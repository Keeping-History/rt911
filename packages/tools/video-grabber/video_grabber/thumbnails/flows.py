"""Prefect flow: periodically capture a JPEG thumbnail for each TV channel.

Scheduled every 30 seconds (see serve.py). Concurrency limit 1 keeps a
second run from starting before the first completes (each run is typically
~5–10 s for 23 channels at 0.5 s per ffmpeg call).

Channels for which ``find_thumb_segment`` returns None (virtual time
outside the stream window, or a download error) are silently skipped;
the frontend falls back to ``thumbnails/offline.jpg`` via ``<img onError>``.
"""
import httpx
from prefect import flow, get_run_logger

from video_grabber.config import Config
from video_grabber.thumbnails.clock import virtual_utc_now
from video_grabber.thumbnails.generator import (
    capture_frame,
    ensure_offline_placeholder,
    upload_thumbnail,
)
from video_grabber.thumbnails.m3u8 import find_thumb_segment

_WASABI_BASE = "https://files.911realtime.org"


def _channel_rows(cfg: Config) -> list[tuple[str, str]]:
    """Return (slug, master_url) pairs for all approved tv_channels rows."""
    resp = httpx.get(
        f"{cfg.directus_url}/items/tv_channels",
        params={"filter[approved][_eq]": 1, "fields": "url", "limit": -1},
        headers={"Authorization": f"Bearer {cfg.directus_api_token}"},
        timeout=10,
    )
    resp.raise_for_status()
    rows = []
    for item in resp.json().get("data", []):
        url = item.get("url", "")
        if not url.endswith("master.m3u8"):
            continue
        # playlists/cnn/master.m3u8  →  parts[-2] == "cnn"
        parts = url.rstrip("/").split("/")
        if len(parts) < 3:
            continue
        slug = parts[-2]
        rows.append((slug, url))
    return rows


@flow(name="generate-thumbnails", log_prints=True)
def generate_thumbnails_flow() -> None:
    logger = get_run_logger()
    cfg = Config()

    ensure_offline_placeholder(cfg)
    virtual_now = virtual_utc_now(cfg)
    logger.info("virtual_now=%s", virtual_now.isoformat())

    channels = _channel_rows(cfg)
    ok = skipped = 0
    for slug, master_url in channels:
        try:
            seg_url = find_thumb_segment(master_url, virtual_now)
            if not seg_url:
                skipped += 1
                continue
            jpeg = capture_frame(seg_url)
            if not jpeg:
                skipped += 1
                continue
            upload_thumbnail(slug, jpeg, cfg)
            ok += 1
        except Exception as exc:
            logger.warning("thumbnail error for %s: %s", slug, exc)
            skipped += 1

    logger.info("thumbnails: %d uploaded, %d skipped (no segment/capture)", ok, skipped)
