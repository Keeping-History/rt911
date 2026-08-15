"""Identify who each recording's traffic is between, and tag it for searching.

One flow, one pass. The Commission clip index is consulted per row rather than
run as a separate enrichment pass: a second pass would mean a second model call
for the same recording, and a half-finished one would leave two different shapes
in the same column.
"""
from datetime import datetime, timezone

import httpx
from prefect import flow, get_run_logger

from video_grabber.catalogue.flows import _page_mp3_items, key_from_url
from video_grabber.config import Config
from video_grabber.directus.writer import _auth_headers
from video_grabber.parties.commission import match_commission_clip
from video_grabber.parties.identify import (
    SCHEMA_VERSION,
    TIER_TAPE,
    build_messages,
    parse_parties,
    should_identify,
    tier_for,
    validate_parties,
)
from video_grabber.parties.tags import build_tags
from video_grabber.storage import wasabi
from video_grabber.transcript.summarize_flows import anthropic_completer

SAMPLE_WINDOWS = 6
SAMPLE_CHARS = 2000

# max_tokens caps thinking AND response text together, and claude-sonnet-5 runs
# adaptive thinking whenever `thinking` is unset (unlike sonnet-4.6, where omitting
# it meant no thinking at all). The reply itself is ~350 tokens of JSON, so 1200
# looked generous — but a hard clip spends the whole budget reasoning and returns
# stop_reason=max_tokens with no text block at all. Measured on
# audio/ZOB/095654: 1200 -> 1200 output tokens, ['thinking'], text ''.
# The same clip at 4000 -> end_turn, 2813 output tokens, ['thinking', 'text'].
# Failure is silent and self-selecting for the ambiguous clips that most need the
# reasoning, so leave real headroom rather than trimming to the observed maximum.
# Schema 2 asks for more fields, so the text half of the budget grew too.
PARTIES_MAX_TOKENS = 5000


def srt_text_to_plain(srt: str) -> str:
    return " ".join(
        line.strip() for line in srt.splitlines()
        if line.strip() and not line.strip().isdigit() and "-->" not in line
    )


def sample_windows(text: str, n: int = SAMPLE_WINDOWS, size: int = SAMPLE_CHARS) -> list[str]:
    """Evenly spaced excerpts. A 6.75h transcript does not fit in one prompt."""
    if len(text) <= size:
        return [text]
    step = max(1, (len(text) - size) // max(1, n - 1))
    return [text[i:i + size] for i in range(0, len(text) - size + 1, step)][:n]


@flow(name="identify-parties")
def identify_parties_flow(limit: int | None = None, force: bool = False,
                          dry_run: bool = True) -> None:
    """Identify parties and derive search tags for every eligible mp3_items row.

    Where the 9/11 Commission catalogued the same recording, their title and
    monograph narrative go into the prompt alongside the transcript, and every
    value the model keeps records which of the two it came from.

    Idempotency marker is `parties.schema_version`, so re-running picks up rows
    left on an older shape and skips ones already current; pass force=True to
    redo everything.
    """
    logger = get_run_logger()
    cfg = Config()
    if not cfg.anthropic_api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    complete = anthropic_completer(cfg, model=cfg.parties_model, max_tokens=PARTIES_MAX_TOKENS)

    done = skipped = failed = broadcast = enriched = 0
    for row in _page_mp3_items(cfg, "id,url,subtitles,calc_duration,parties"):
        if limit is not None and done >= limit:
            break
        key = key_from_url(row["url"])

        if not should_identify(key):
            broadcast += 1
            continue
        existing = row.get("parties") or {}
        if existing.get("schema_version") == SCHEMA_VERSION and not force:
            skipped += 1
            continue

        clip = match_commission_clip(key)

        # A missing transcript is not disqualifying when the Commission
        # catalogued the recording: their text alone can carry an
        # identification, and the gate rejects anything claiming the empty
        # transcript as its source.
        transcript = ""
        if row.get("subtitles"):
            transcript = srt_text_to_plain(
                wasabi.read_text(key_from_url(row["subtitles"]), cfg)
            )
        if not transcript.strip() and clip is None:
            logger.warning("identify-parties: %s has no transcript and no clip", key)
            skipped += 1
            continue

        tier = tier_for(row.get("calc_duration"))
        excerpt = transcript
        if tier == TIER_TAPE:
            excerpt = "\n\n---\n\n".join(sample_windows(transcript))
        commission_text = clip.text if clip else ""
        system, user = build_messages(excerpt, tier, commission_text)

        try:
            parsed = parse_parties(complete(system, user))
        except ValueError as exc:
            logger.warning("identify-parties: %s unparseable: %s", key, exc)
            failed += 1
            continue

        cleaned, reasons = validate_parties(parsed, excerpt, commission_text)
        cleaned["tier"] = tier
        cleaned["model"] = cfg.parties_model
        cleaned["generated_at"] = datetime.now(timezone.utc).isoformat()
        if clip:
            enriched += 1
            cleaned["commission"] = {
                "title": clip.title,
                "source": clip.source,
                "stamp": clip.stamp,
                "slug_overlap": clip.overlap,
            }
        if reasons:
            cleaned["gate_reasons"] = reasons
            logger.info("identify-parties: %s gated: %s", key, reasons)

        tags = build_tags(cleaned)

        if dry_run:
            logger.info("DRY RUN %s -> %s | tags=%s", key, cleaned, tags)
        else:
            pr = httpx.patch(f"{cfg.directus_url}/items/mp3_items/{row['id']}",
                             json={"parties": cleaned, "tags": tags},
                             headers=_auth_headers(cfg))
            pr.raise_for_status()
        done += 1

    logger.info(
        "identify-parties: %d identified (%d with Commission sources), "
        "%d skipped, %d broadcast (excluded), %d failed",
        done, enriched, skipped, broadcast, failed,
    )
