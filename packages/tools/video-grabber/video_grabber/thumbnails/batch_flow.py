"""Prefect flow: pre-generate one JPEG thumbnail per 30-second interval across the
full 9-day archive (2001-09-09 → 2001-09-18) for every TV channel.

Storage key: ``thumbnails/{slug}/{unix_ts}.jpg`` where ``unix_ts`` is the Unix
epoch second of the 30-second boundary (e.g. 999993600, 999993630, ...).

The flow is resumable: ``head_object`` on the Wasabi key before each upload skips
work already done, so re-running after an interruption picks up where it left off.

Gap segments (URL contains ``_gap.v3``) are skipped; the frontend falls back to
``thumbnails/offline.jpg`` for those time slots.

The init segment (``#EXT-X-MAP``) is downloaded once per channel and reused across
all ~25 920 segments so we don't make 25 920 separate init-segment requests.
"""
import math
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

import httpx
from prefect import flow, get_run_logger

from video_grabber.config import Config
from video_grabber.thumbnails.flows import _channel_rows
from video_grabber.thumbnails.generator import capture_frame_from_bytes
from video_grabber.thumbnails.m3u8 import _find_map_uri
from video_grabber.storage.wasabi import _make_s3_client

_GAP_MARKER = "_gap.v3"
_INTERVAL = 30  # seconds between pre-generated thumbnails
_MAX_WORKERS = 20  # concurrent download+ffmpeg+upload chains


def _parse_all_segments(
    playlist_text: str,
) -> list[tuple[int, float, bool, str]]:
    """Return ``(unix_ts, duration, is_gap, seg_url)`` for every segment in the playlist."""
    lines = playlist_text.splitlines()
    current_dt: datetime | None = None
    elapsed = 0.0
    dur = 0.0
    results: list[tuple[int, float, bool, str]] = []

    for raw in lines:
        line = raw.strip()
        if line.startswith("#EXT-X-PROGRAM-DATE-TIME:"):
            current_dt = datetime.fromisoformat(line.split(":", 1)[1]).astimezone(timezone.utc)
            elapsed = 0.0
        elif line.startswith("#EXTINF:"):
            dur = float(line[8:].split(",")[0])
        elif line and not line.startswith("#"):
            if current_dt is not None:
                unix_ts = int((current_dt + timedelta(seconds=elapsed)).timestamp())
                results.append((unix_ts, dur, _GAP_MARKER in line, line))
                elapsed += dur

    return results


def _select_boundary_items(
    segments: list[tuple[int, float, bool, str]],
) -> list[tuple[int, str]]:
    """Return ``(boundary_unix_ts, seg_url)`` for every 30-second boundary in a non-gap segment.

    A 6-second segment can contain at most one 30-second boundary.  We find the
    first multiple of 30 that is >= ``unix_ts``, then check if it falls within
    the segment's window.
    """
    result: list[tuple[int, str]] = []
    for unix_ts, dur, is_gap, seg_url in segments:
        if is_gap:
            continue
        boundary = math.ceil(unix_ts / _INTERVAL) * _INTERVAL
        if boundary < unix_ts + dur:
            result.append((boundary, seg_url))
    return result


def _process_one(
    slug: str,
    unix_ts: int,
    seg_url: str,
    init_bytes: bytes,
    s3,
    cfg: Config,
) -> str:
    """Download one segment, capture a frame, and upload to Wasabi.  Returns "ok", "skip", or "fail:..."."""
    key = f"thumbnails/{slug}/{unix_ts}.jpg"
    try:
        s3.head_object(Bucket=cfg.wasabi_bucket, Key=key)
        return "skip"
    except Exception:
        pass
    try:
        seg_bytes = httpx.get(seg_url, timeout=15).content
        combined = init_bytes + seg_bytes
        jpeg = capture_frame_from_bytes(combined)
        if not jpeg:
            return "fail:ffmpeg"
        s3.put_object(
            Bucket=cfg.wasabi_bucket,
            Key=key,
            Body=jpeg,
            ContentType="image/jpeg",
            CacheControl="max-age=31536000",
        )
        return "ok"
    except Exception as exc:
        return f"fail:{exc}"


@flow(name="batch-thumbnails", log_prints=True)
def batch_thumbnails_flow() -> None:
    """Pre-generate thumbnails for the full 9-day archive.  Safe to re-run: skips already-uploaded keys."""
    logger = get_run_logger()
    cfg = Config()
    s3 = _make_s3_client(cfg)
    channels = _channel_rows(cfg)

    logger.info("batch-thumbnails: %d channels", len(channels))

    all_work: list[tuple[str, int, str, bytes]] = []
    for slug, master_url in channels:
        thumb_url = master_url.replace("master.m3u8", "thumb.m3u8")
        try:
            resp = httpx.get(thumb_url, timeout=30)
            resp.raise_for_status()
            text = resp.text
        except Exception as exc:
            logger.warning("%s: playlist fetch failed: %s", slug, exc)
            continue

        init_url = _find_map_uri(text)
        init_bytes: bytes = b""
        if init_url:
            try:
                init_bytes = httpx.get(init_url, timeout=10).content
            except Exception as exc:
                logger.warning("%s: init segment fetch failed: %s", slug, exc)

        segs = _parse_all_segments(text)
        boundaries = _select_boundary_items(segs)
        logger.info("%s: %d boundary thumbnails", slug, len(boundaries))

        for unix_ts, seg_url in boundaries:
            all_work.append((slug, unix_ts, seg_url, init_bytes))

    total = len(all_work)
    logger.info("total work items: %d", total)

    ok = skip = fail = 0
    with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as pool:
        futures = {
            pool.submit(_process_one, slug, ts, url, init_b, s3, cfg): idx
            for idx, (slug, ts, url, init_b) in enumerate(all_work)
        }
        for done_count, future in enumerate(as_completed(futures), start=1):
            result = future.result()
            if result == "ok":
                ok += 1
            elif result == "skip":
                skip += 1
            else:
                fail += 1
            if done_count % 500 == 0:
                logger.info(
                    "progress %d/%d  ok=%d skip=%d fail=%d",
                    done_count, total, ok, skip, fail,
                )

    logger.info("done: ok=%d skip=%d fail=%d total=%d", ok, skip, fail, total)
