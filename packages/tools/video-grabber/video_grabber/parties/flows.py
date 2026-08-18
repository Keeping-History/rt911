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
from video_grabber.parties.tag_store import load_vocabulary, sync_item_tags
from video_grabber.parties.tags import build_tag_records
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
    # Read once for the whole run and updated in place as new tags appear; a
    # per-row read would spend most of its requests re-fetching the same table.
    vocab = {} if dry_run else load_vocabulary(cfg)

    done = skipped = failed = broadcast = enriched = 0
    for row in _page_mp3_items(
        cfg, "id,url,subtitles,calc_duration,parties,tags_curated"
    ):
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

        # One recording must not be able to end a run over hundreds of them. The
        # reply is arbitrary JSON from a model, so the ways it can be wrong are
        # open-ended; a bad row is counted and named, and the walk continues.
        try:
            parsed = parse_parties(complete(system, user))
            cleaned, reasons = validate_parties(parsed, excerpt, commission_text)
        except Exception as exc:
            logger.warning(
                "identify-parties: %s failed: %s: %s", key, type(exc).__name__, exc
            )
            failed += 1
            continue
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

        # Tags are rebuilt from scratch every run so the model can retract a
        # tag it no longer supports; `tags_curated` is the human column the
        # flow reads and never writes, so hand-added tags survive regardless.
        records = build_tag_records(cleaned, row.get("tags_curated") or [])

        if dry_run:
            logger.info("DRY RUN %s -> %s | tags=%s",
                        key, cleaned, [r["tag"] for r in records])
        else:
            # `parties` is a column on the item; the tags are a many-to-many and
            # cannot ride along in this PATCH — `mp3_items.tags` is an alias over
            # the junction, not a field that holds values.
            pr = httpx.patch(f"{cfg.directus_url}/items/mp3_items/{row['id']}",
                             json={"parties": cleaned},
                             headers=_auth_headers(cfg))
            pr.raise_for_status()
            sync_item_tags(cfg, row["id"], records, vocab)
        done += 1

    logger.info(
        "identify-parties: %d identified (%d with Commission sources), "
        "%d skipped, %d broadcast (excluded), %d failed",
        done, enriched, skipped, broadcast, failed,
    )


@flow(name="rebuild-tags")
def rebuild_tags_flow(limit: int | None = None, dry_run: bool = True) -> None:
    """Re-derive every row's tags from the `parties` it already carries.

    Tags are a pure function of `parties` plus `tags_curated`, so a change to
    the derivation — a new facility alias, a topic added to the vocabulary, a
    callsign that now normalises differently — makes every stored tag stale
    without making a single `parties` block wrong. Re-running `identify-parties`
    would fix them, but only by paying for inference over the whole corpus to
    reproduce answers already on disk.

    This reads no transcripts and calls no model. It is also how the corpus was
    moved onto the m2m shape: the junction is rebuilt from scratch, so a tag the
    derivation no longer produces loses its rows rather than lingering.
    """
    logger = get_run_logger()
    cfg = Config()
    vocab = {} if dry_run else load_vocabulary(cfg)

    done = skipped = tagged = 0
    for row in _page_mp3_items(cfg, "id,parties,tags_curated"):
        if limit is not None and done >= limit:
            break
        parties = row.get("parties")
        if not parties:
            skipped += 1
            continue

        records = build_tag_records(parties, row.get("tags_curated") or [])
        if dry_run:
            logger.info("DRY RUN %s -> %s", row["id"], [r["tag"] for r in records])
        else:
            tagged += sync_item_tags(cfg, row["id"], records, vocab)
        done += 1

    logger.info(
        "rebuild-tags: %d rows re-derived, %d taggings written, %d without parties, "
        "%d distinct tags in vocabulary",
        done, tagged, skipped, len(vocab),
    )
