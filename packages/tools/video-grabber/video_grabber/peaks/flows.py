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


# 20 minutes. The longest tape is 8h18m, and ffmpeg decodes audio far faster
# than realtime (minutes, not hours, even for the longest source) — this
# leaves generous headroom over any real decode while still bounding a hang
# on a corrupt/truncated file. `subprocess.TimeoutExpired` is a subclass of
# `Exception`, so it's caught by compute_peaks_flow's per-row `except
# Exception`: a timed-out row is counted as failed and the run continues,
# rather than the whole unattended run wedging on one bad file forever.
_FFMPEG_TIMEOUT_S = 20 * 60


_SAMPLE_RATE_HZ = 8000
_BYTES_PER_SAMPLE = 2  # s16le


def pcm_for(path: Path) -> bytes:
    """Decode to 8 kHz signed 16-bit little-endian mono.

    Plenty for an envelope drawn at preview size, and it keeps the 8h18m
    tape's PCM buffer to ~478 MB rather than several GB at source rate (e.g.
    44.1 kHz stereo would be ~5.3 GB for the same tape).
    `capture_output=True` uses `Popen.communicate()` internally, so stdout is
    read incrementally alongside the process rather than after it exits — the
    pipe can't fill and deadlock the way a naive `stdout=PIPE` + `.wait()`
    would on a large decode. `timeout=` guards a different failure mode: a
    hung or stalled decode on a corrupt/truncated file would otherwise sit
    forever with nothing raised and the per-row try/except never firing.
    """
    result = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path),
         "-ac", "1", "-ar", str(_SAMPLE_RATE_HZ), "-f", "s16le", "-"],
        capture_output=True, check=True, timeout=_FFMPEG_TIMEOUT_S,
    )
    return result.stdout


class PartialDecodeError(RuntimeError):
    """ffmpeg produced less audio than the catalogue says the recording holds."""


# Tolerance for the decoded-vs-catalogued length check below. It cannot be
# exact, and the two terms cover two different sources of honest divergence:
#
# - The 1.5 s floor covers rounding and codec padding. `calc_duration` is
#   whole seconds — `catalogue/flows.py:probe_duration` is `int(float(...))`,
#   a TRUNCATION, so the stored value sits up to 1 s below the real duration
#   before anything else — and MP3 encoder/decoder delay and padding add tens
#   of ms on top. The shortest recording in the corpus is 2 s, so the floor
#   has to stay small enough to still catch a truncated decode of one of
#   those.
# - The 1 % term covers ffprobe estimating a duration from the bitrate rather
#   than reading a frame count, which is the one error that scales with
#   length. On the 8h18m tape that is ~5 minutes of slack — still far tighter
#   than any partial decode worth catching, and ~5 of the 480 buckets.
#
# The bias is deliberate: a false rejection costs one recomputed row on the
# next run (logged, retried, cheap), while a false acceptance writes a
# permanently misaligned envelope that `should_compute` will never revisit.
_DURATION_TOLERANCE_S = 1.5
_DURATION_TOLERANCE_FRACTION = 0.01


def check_decode_length(pcm: bytes, calc_duration: object) -> None:
    """Raise `PartialDecodeError` if the decode cannot be the whole recording.

    `check=True` on the ffmpeg call only catches a non-zero exit, and ffmpeg
    routinely exits 0 on a truncated or damaged MP3 after emitting a short PCM
    prefix. `peaks_from_pcm` would then stretch that prefix across all 480
    buckets and the frontend would draw it across the row's full
    `calc_duration` extent: a waveform misaligned from the audio it claims to
    depict, stored as a success. Because `should_compute` treats any non-null
    `peaks` as done, only a `force=True` pass over the whole corpus would ever
    repair it — so the check has to happen before the write, not after.

    A zero-length decode is the worst case and is rejected unconditionally:
    `peaks_from_pcm` turns it into 480 `[0, 0]` pairs, indistinguishable from a
    genuinely silent recording, so there is no `calc_duration` to compare
    against and nothing to gain from storing it.

    Rows with an absent or non-positive `calc_duration` cannot be checked
    beyond that. They are ACCEPTED rather than failed: the length is the only
    evidence available, refusing them would drop real envelopes for rows whose
    only defect is a missing catalogue field, and a re-run would keep refusing
    them forever. The zero-length rule above still applies, which is the case
    that would actually corrupt the display.

    Note the one blind spot: if a file was already truncated when
    `probe_duration` ran, `calc_duration` describes the truncated file and
    matches the short decode. This catches damage that postdates the
    catalogue entry, and MP3s whose header frame count outlives their payload
    — not a file that has been short since ingest.
    """
    decoded_s = len(pcm) / _BYTES_PER_SAMPLE / _SAMPLE_RATE_HZ
    if decoded_s <= 0:
        raise PartialDecodeError("ffmpeg decoded 0 samples")
    if not isinstance(calc_duration, (int, float)) or calc_duration <= 0:
        return
    tolerance = max(_DURATION_TOLERANCE_S, _DURATION_TOLERANCE_FRACTION * calc_duration)
    if abs(decoded_s - calc_duration) > tolerance:
        raise PartialDecodeError(
            f"decoded {decoded_s:.1f}s but the catalogue says {calc_duration}s "
            f"(tolerance {tolerance:.1f}s) — a partial decode, not an envelope"
        )


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

    # `calc_duration` is projected for `check_decode_length`, not for display:
    # without it every row becomes unverifiable and the guard is silently dead.
    for row in _page_mp3_items(cfg, "id,url,peaks,calc_duration"):
        if limit is not None and done >= limit:
            break
        if not should_compute(row, force=force):
            skipped += 1
            continue

        key = key_from_url(row["url"])
        # One recording must not be able to end a run over hundreds of them —
        # a bad download, an unreadable file, a corrupt tape, a partial decode
        # — count it and move on, the way identify-parties does.
        # `PartialDecodeError` lands here too, which is the point: a row whose
        # envelope would be wrong is left NULL for a later run to retry rather
        # than written and never revisited.
        try:
            with tempfile.TemporaryDirectory() as tmp:
                local = Path(tmp) / Path(key).name
                wasabi.download_file(key, local, cfg)
                pcm = pcm_for(local)
                check_decode_length(pcm, row.get("calc_duration"))
                peaks = peaks_from_pcm(pcm, PEAK_BUCKETS)
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
