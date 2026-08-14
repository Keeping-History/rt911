"""Identify who each recording's traffic is between and write mp3_items.parties."""
from datetime import datetime, timezone
from pathlib import Path

import httpx
from prefect import flow, get_run_logger

from video_grabber.catalogue.flows import _page_mp3_items, key_from_url
from video_grabber.config import Config
from video_grabber.directus.writer import _auth_headers
from video_grabber.parties.identify import (
    TIER_TAPE,
    build_clip_messages,
    build_tape_messages,
    parse_parties,
    should_identify,
    tier_for,
    validate_parties,
)
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
PARTIES_MAX_TOKENS = 4000


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
    """Identify communication parties for every eligible mp3_items row.

    Idempotency marker is `parties IS NOT NULL`, so the flow is resumable
    without a jobs table; pass force=True to re-identify.
    """
    logger = get_run_logger()
    cfg = Config()
    if not cfg.anthropic_api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    complete = anthropic_completer(cfg, model=cfg.parties_model, max_tokens=PARTIES_MAX_TOKENS)

    done = skipped = failed = broadcast = 0
    for row in _page_mp3_items(cfg, "id,url,subtitles,calc_duration,parties"):
        if limit is not None and done >= limit:
            break
        key = key_from_url(row["url"])

        if not should_identify(key):
            broadcast += 1
            continue
        if row.get("parties") and not force:
            skipped += 1
            continue
        if not row.get("subtitles"):
            logger.warning("identify-parties: %s has no subtitles; skipping", key)
            skipped += 1
            continue

        transcript = srt_text_to_plain(wasabi.read_text(key_from_url(row["subtitles"]), cfg))
        if not transcript.strip():
            skipped += 1
            continue

        tier = tier_for(row.get("calc_duration"))
        if tier == TIER_TAPE:
            system, user = build_tape_messages(Path(key).name, sample_windows(transcript))
        else:
            system, user = build_clip_messages(transcript)

        try:
            parsed = parse_parties(complete(system, user))
        except ValueError as exc:
            logger.warning("identify-parties: %s unparseable: %s", key, exc)
            failed += 1
            continue

        cleaned, reasons = validate_parties(parsed, transcript)
        cleaned["tier"] = tier
        cleaned["model"] = cfg.parties_model
        cleaned["generated_at"] = datetime.now(timezone.utc).isoformat()
        if reasons:
            cleaned["gate_reasons"] = reasons
            logger.info("identify-parties: %s downgraded: %s", key, reasons)

        if dry_run:
            logger.info("DRY RUN %s -> %s", key, cleaned)
        else:
            pr = httpx.patch(f"{cfg.directus_url}/items/mp3_items/{row['id']}",
                             json={"parties": cleaned}, headers=_auth_headers(cfg))
            pr.raise_for_status()
        done += 1

    logger.info(
        "identify-parties: %d identified, %d skipped, %d broadcast (excluded), %d failed",
        done, skipped, broadcast, failed,
    )
