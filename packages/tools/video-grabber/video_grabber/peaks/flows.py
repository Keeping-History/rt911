"""Compute an amplitude envelope for every audio recording.

Manual-only and dry_run=True by default, like identify-parties: it writes to
the live catalogue, so nothing should schedule it.
"""
from pathlib import Path
import subprocess
import tempfile

import httpx
from prefect import flow, get_run_logger

from video_grabber.catalogue.flows import _page_mp3_items, key_from_url
from video_grabber.config import Config
from video_grabber.directus.writer import _auth_headers
from video_grabber.peaks.extract import PEAK_BUCKETS, peaks_from_pcm
from video_grabber.storage import wasabi


def should_compute(row: dict, *, force: bool) -> bool:
    """Idempotency marker is `peaks IS NOT NULL`, so a run is resumable."""
    return force or not row.get("peaks")


def pcm_for(path: Path) -> bytes:
    """Decode to 8 kHz signed 16-bit little-endian mono.

    Plenty for an envelope drawn at preview size, and it keeps a 6.75-hour
    tape's intermediate buffer under 200 MB rather than several GB at source
    rate. `capture_output=True` uses `Popen.communicate()` internally, so
    stdout is read incrementally alongside the process rather than after it
    exits — the pipe can't fill and deadlock the way a naive
    `stdout=PIPE` + `.wait()` would on a large decode.
    """
    result = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path),
         "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
        capture_output=True, check=True,
    )
    return result.stdout


@flow(name="compute-peaks")
def compute_peaks_flow(limit: int | None = None, force: bool = False,
                       dry_run: bool = True) -> None:
    """Compute a 480-bucket amplitude envelope for every eligible mp3_items row.

    Idempotency marker is `peaks IS NOT NULL`, so re-running picks up rows
    left empty (new uploads, a prior failure) and skips ones already done;
    pass force=True to recompute everything.
    """
    logger = get_run_logger()
    cfg = Config()
    done = skipped = failed = 0

    for row in _page_mp3_items(cfg, "id,url,peaks"):
        if limit is not None and done >= limit:
            break
        if not should_compute(row, force=force):
            skipped += 1
            continue

        key = key_from_url(row["url"])
        # One recording must not be able to end a run over hundreds of them —
        # a bad download, an unreadable file, a corrupt tape — count it and
        # move on, the way identify-parties does.
        try:
            with tempfile.TemporaryDirectory() as tmp:
                local = Path(tmp) / Path(key).name
                wasabi.download_file(key, local, cfg)
                peaks = peaks_from_pcm(pcm_for(local), PEAK_BUCKETS)
        except Exception as exc:
            logger.warning("compute-peaks: %s failed: %s: %s", key, type(exc).__name__, exc)
            failed += 1
            continue

        if dry_run:
            logger.info("DRY RUN %s -> %d buckets", key, len(peaks))
        else:
            r = httpx.patch(f"{cfg.directus_url}/items/mp3_items/{row['id']}",
                            json={"peaks": peaks}, headers=_auth_headers(cfg))
            r.raise_for_status()
        done += 1

    logger.info("compute-peaks: %d computed, %d skipped, %d failed", done, skipped, failed)
