"""Reconcile mp3_items against the audio/ prefix.

Two flows, both idempotent and both defaulting to dry_run=True: these write to
the live catalogue, and a wrong start_date puts historical audio on the wrong
day of the replay.
"""
import subprocess as _sp
from pathlib import Path
from urllib.parse import unquote

import httpx
from prefect import flow, get_run_logger

from video_grabber.catalogue.filenames import parse_key
from video_grabber.config import Config
from video_grabber.directus.writer import _WASABI_BASE, _auth_headers, wasabi_public_url
from video_grabber.storage import wasabi

_PAGE = 500
# Cloudflare in front of files.911realtime.org blocks some default tool
# User-Agents outright; ffprobe's own is fine, but pin a browser UA so an
# in-cluster probe never 403s and gets mistaken for an unreadable file.
_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
       "Chrome/120.0 Safari/537.36")


def probe_duration(url: str) -> int | None:
    """Duration in whole seconds, or None if ffprobe cannot read the file."""
    r = _sp.run(
        ["ffprobe", "-v", "error", "-user_agent", _UA,
         "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", url],
        capture_output=True, text=True,
    )
    if r.returncode != 0 or not r.stdout.strip():
        return None
    try:
        return int(float(r.stdout.strip()))
    except ValueError:
        return None


def _page_mp3_items(cfg: Config, fields: str, *, client=httpx):
    """Yield every mp3_items row, following offsets until a short page."""
    offset = 0
    while True:
        r = client.get(
            f"{cfg.directus_url}/items/mp3_items",
            params={"fields": fields, "limit": _PAGE, "offset": offset},
            headers=_auth_headers(cfg),
        )
        r.raise_for_status()
        page = r.json().get("data") or []
        yield from page
        if len(page) < _PAGE:
            return
        offset += _PAGE


def key_from_url(url: str) -> str:
    """Bucket key for a stored mp3_items.url (which is percent-encoded)."""
    return unquote(url.replace(f"{_WASABI_BASE}/", ""))


@flow(name="backfill-mp3-catalogue")
def backfill_mp3_catalogue_flow(dry_run: bool = True) -> None:
    """Create an mp3_items row for every audio/ object that has none."""
    logger = get_run_logger()
    cfg = Config()
    have = {row["url"] for row in _page_mp3_items(cfg, "url") if row.get("url")}
    keys = [k for k in wasabi.list_keys("audio/", cfg) if k.lower().endswith(".mp3")]

    created = unreadable = untimeable = 0
    for key in keys:
        url = wasabi_public_url(key)
        if url in have:
            continue
        parsed = parse_key(key)
        if parsed.start_utc is None:
            # mp3_items.start_date is NOT NULL, and this whole product is driven
            # by the virtual clock — a row with no time can never be served.
            # The existing NORAD tapes show the precedent: their start times were
            # curated by hand from the recordings, not derived from filenames.
            # So refuse, and surface these for the same treatment.
            logger.warning(
                "backfill: %s has no parseable timestamp; skipping. It needs a "
                "hand-curated start_date, as the NORAD tapes were given.", key,
            )
            untimeable += 1
            continue
        duration = probe_duration(url)
        if duration is None:
            # calc_duration gates clip/tape tiering downstream; a row without it
            # would make identification refuse. Skip loudly instead.
            logger.warning("backfill: could not probe %s; skipping", key)
            unreadable += 1
            continue
        body = {
            "title": parsed.title,
            "full_title": parsed.title,
            "url": url,
            "format": "mp3",
            "calc_duration": duration,
            "timezone": "EDT",
            "approved": 0,
            "start_date": parsed.start_utc.strftime("%Y-%m-%d %H:%M:%S"),
        }
        if dry_run:
            logger.info("DRY RUN would create: %s", body)
        else:
            r = httpx.post(f"{cfg.directus_url}/items/mp3_items",
                           json=body, headers=_auth_headers(cfg))
            r.raise_for_status()
        created += 1
    logger.info(
        "backfill-mp3-catalogue: %d rows %s, %d unreadable, %d untimeable "
        "(need a hand-curated start_date)",
        created, "would be created" if dry_run else "created", unreadable, untimeable,
    )


@flow(name="link-mp3-subtitles")
def link_mp3_subtitles_flow(dry_run: bool = True) -> None:
    """Point every mp3_items.subtitles at its SRT. Idempotent."""
    from video_grabber.transcribe.flows import existing_srt_key

    logger = get_run_logger()
    cfg = Config()
    srt_keys = [k for k in wasabi.list_keys(f"{cfg.subtitles_prefix}/", cfg)
                if k.endswith(".srt")]
    srt_paths, srt_stems = set(srt_keys), {Path(k).stem for k in srt_keys}

    linked = missing = unchanged = 0
    for row in _page_mp3_items(cfg, "id,url,subtitles"):
        srt_key = existing_srt_key(key_from_url(row["url"]), srt_stems, srt_paths)
        if srt_key is None:
            missing += 1
            continue
        target = wasabi_public_url(srt_key)
        if row.get("subtitles") == target:
            unchanged += 1
            continue
        if not dry_run:
            pr = httpx.patch(f"{cfg.directus_url}/items/mp3_items/{row['id']}",
                             json={"subtitles": target}, headers=_auth_headers(cfg))
            pr.raise_for_status()
        linked += 1
    logger.info("link-mp3-subtitles: %d %s, %d already correct, %d without an SRT",
                linked, "would be linked" if dry_run else "linked", unchanged, missing)
