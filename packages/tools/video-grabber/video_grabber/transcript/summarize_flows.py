"""Summarise chat_transcript_segments into chat_transcript_minutes.

Deliberately a SEPARATE flow from build-transcript-segments, and deliberately
reading the segments back out of Directus rather than re-deriving them from the
SRT. Two reasons, both learned the hard way:

  * Coupling them meant populating minutes required a full 227k-row segment
    re-ingest, and would now also mean re-running every LLM call on any segment
    rebuild — paying twice for output that had not changed.
  * Reading the segments themselves removes the divergence risk that coupling
    was supposed to solve. chat_transcript_segments is what the streamer falls
    back to, so summarising *it* guarantees the two describe the same audio;
    deriving both from the SRT separately only guaranteed they were built at the
    same moment.

Resumable by construction: minutes already summarised by the requested method
are skipped, so an interrupted run is restarted by running it again.
"""

import collections
import concurrent.futures as futures

import httpx
from prefect import flow, get_run_logger

from video_grabber.config import Config
from video_grabber.transcript import writer
from video_grabber.transcript.minutes import condense
from video_grabber.transcript.summarize import (
    TIER_ABSTRACT,
    TIER_EXTRACT,
    TIER_MECHANICAL,
    summarize_minute,
)


# max_tokens caps thinking AND reply text together, and the newer models think by
# default when `thinking` is unset. The summarizer's own replies are a couple of
# hundred tokens, so 400 looked right — but it is a ceiling, not a reservation:
# you are billed for tokens actually emitted, so a generous cap costs nothing on
# a model that does not think, and is the difference between a working call and
# an empty string on one that does. claude-haiku-4-5 (the default) does not think;
# SUMMARIZE_MODEL can point anywhere, which is why the default is sized for the
# thinking case. See PARTIES_MAX_TOKENS in parties/flows.py for the measurement.
DEFAULT_MAX_TOKENS = 4000


def anthropic_completer(cfg: Config, *, model: str | None = None,
                        max_tokens: int = DEFAULT_MAX_TOKENS):
    """Build a `complete(system, user) -> str` bound to a model.

    Wrapped rather than passed as a client so summarize.py stays free of the SDK
    and its rules — every judgment in there is unit-testable without a key.

    Defaults to the summarizer's model; party identification passes its own,
    since it needs more reasoning and a larger JSON reply.
    """
    import anthropic

    client = anthropic.Anthropic(api_key=cfg.anthropic_api_key)
    chosen = model or cfg.summarize_model

    def complete(system: str, user: str) -> str:
        msg = client.messages.create(
            model=chosen,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        text = "".join(b.text for b in msg.content if b.type == "text")
        if not text.strip() and msg.stop_reason == "max_tokens":
            # Returning "" here is how this failed silently before: the caller
            # cannot tell a truncated call from a model that had nothing to say,
            # so the summarizer quietly degraded to mechanical condensation and
            # party identification logged "did not return JSON". Name the cause.
            raise ValueError(
                f"model {chosen} returned no text: the whole max_tokens={max_tokens} "
                f"budget went on thinking (stop_reason=max_tokens, blocks="
                f"{[b.type for b in msg.content]}). Raise the budget rather than "
                f"changing the prompt."
            )
        return text

    return complete


def _fetch_segments(cfg: Config, *, start: str, end: str, client=httpx) -> list[dict]:
    """Page through the segments in [start, end).

    Directus caps a page server-side, so this follows offsets until short —
    asking for limit=-1 on a table this size is how a run silently summarises
    only the first page.
    """
    out: list[dict] = []
    page_size, offset = 1000, 0
    while True:
        r = client.get(
            f"{cfg.directus_url}/items/chat_transcript_segments",
            params={
                "fields": "channel,channel_slug,medium,start_date,text",
                "filter": (
                    '{"_and":[{"start_date":{"_gte":"%s"}},{"start_date":{"_lt":"%s"}}]}'
                    % (start, end)
                ),
                "sort": "start_date",
                "limit": page_size,
                "offset": offset,
            },
            headers={"Authorization": f"Bearer {cfg.directus_api_token}"},
            timeout=httpx.Timeout(connect=30.0, read=600.0, write=120.0, pool=30.0),
        )
        r.raise_for_status()
        batch = r.json()["data"]
        out.extend(batch)
        if len(batch) < page_size:
            return out
        offset += page_size


def _group(segments: list[dict]) -> dict:
    buckets: dict = collections.defaultdict(list)
    for s in segments:
        minute = s["start_date"][:16].replace("T", " ") + ":00"
        buckets[(s.get("channel"), s.get("channel_slug"), s.get("medium") or "tv", minute)].append(
            s["text"]
        )
    return buckets


@flow(name="summarize-transcript-minutes")
def summarize_transcript_minutes_flow(
    start: str = "2001-09-11T12:00:00",
    end: str = "2001-09-11T23:00:00",
    tier: str | None = None,
    limit: int = 0,
    dry_run: bool = True,
    cfg: Config | None = None,
) -> dict:
    """Condense every channel-minute in [start, end) and write the results.

    dry_run defaults to TRUE. This flow spends money and rewrites the tier-2
    grounding every buddy reads, and the mechanical condenser it replaces was
    shipped on the strength of unit tests against hand-written fixtures that did
    not resemble the real corpus. Look at a sample before writing 12k rows.

    limit bounds how many minutes are processed at all, so a costed sample is a
    parameter rather than a separate script.
    """
    logger = get_run_logger()
    cfg = cfg or Config()
    tier = tier or cfg.summarize_tier
    if tier not in (TIER_EXTRACT, TIER_ABSTRACT):
        raise ValueError(f"tier must be {TIER_EXTRACT!r} or {TIER_ABSTRACT!r}, got {tier!r}")
    if not cfg.anthropic_api_key:
        raise ValueError("ANTHROPIC_API_KEY is unset; refusing to run a summarisation pass")

    segments = _fetch_segments(cfg, start=start, end=end)
    buckets = _group(segments)
    logger.info("fetched %d segments across %d channel-minutes", len(segments), len(buckets))
    if not buckets:
        raise RuntimeError(f"no transcript segments in [{start}, {end}) — nothing to summarise")

    # Sort on a stringified key. The tuples mix types by design -- TV carries an
    # int channel and a null slug, radio the reverse -- so sorting them directly
    # raises TypeError comparing None to int the moment both media are in range.
    keys = sorted(buckets, key=lambda k: tuple("" if p is None else str(p) for p in k))
    keys = keys[: limit or None]
    complete = anthropic_completer(cfg)

    def one(key):
        result = summarize_minute(
            buckets[key],
            tier=tier,
            complete=complete,
            max_units=cfg.summarize_max_units,
            fallback=condense,
        )
        return key, result

    results = []
    with futures.ThreadPoolExecutor(max_workers=cfg.summarize_concurrency) as pool:
        for key, result in pool.map(one, keys):
            results.append((key, result))

    counts = collections.Counter(r.method for _, r in results)
    rejected = [(k, r.rejected) for k, r in results if r.rejected]
    # A rejection is the gate doing its job, not an error -- but a HIGH rate means
    # the prompt is drifting outside the source and the tier should be reconsidered,
    # so it is surfaced rather than buried in per-item logs.
    logger.info("methods=%s rejected=%d/%d", dict(counts), len(rejected), len(results))
    for key, reason in rejected[:10]:
        logger.info("rejected %s: %s", key, reason)

    if dry_run:
        for (channel, slug, medium, minute), r in results[:5]:
            logger.info("[dry-run] %s %s -> (%s) %s", slug or channel, minute, r.method, r.text[:160])
        return {
            "minutes": len(results), "written": 0, "dry_run": True,
            "methods": dict(counts), "rejected": len(rejected),
        }

    rows_by_source: dict = collections.defaultdict(list)
    for (channel, slug, medium, minute), r in results:
        if not r.text:
            continue
        rows_by_source[(channel, slug, medium)].append({
            "channel": channel, "channel_slug": slug, "medium": medium,
            "minute": minute, "summary": r.text,
            "segment_count": len(buckets[(channel, slug, medium, minute)]),
            "method": r.method, "model": cfg.summarize_model if r.method != TIER_MECHANICAL else None,
        })

    written = 0
    for (channel, slug, medium), rows in rows_by_source.items():
        # Window-scoped: this run owns [start, end) for this source and must not
        # delete minutes a previous run paid for outside it.
        written += writer.replace_minutes(
            rows, medium=medium, channel=channel, channel_slug=slug, cfg=cfg,
            minute_gte=start, minute_lt=end,
        )
    logger.info("summarised %d minutes, wrote %d rows", len(results), written)
    return {
        "minutes": len(results), "written": written, "dry_run": False,
        "methods": dict(counts), "rejected": len(rejected),
    }
