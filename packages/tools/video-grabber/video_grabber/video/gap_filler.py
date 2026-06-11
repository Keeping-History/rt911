"""
Blue gap-filler package — the segments the EPG assembler splices into dead air.

For each of the 3 renditions this produces, in ``output_dir/<rend>/``:
  - ``init.mp4``            — shared fMP4 init (moov) for the rendition
  - ``seg_gap_6s.m4s``      — the canonical full-length filler segment
  - ``seg_gap_<n>s.m4s``    — one remainder segment per n in REMAINDER_SECONDS

assembler.py composes any gap of G seconds as ⌊G/6⌋ copies of ``seg_gap_6s``
plus one ``seg_gap_<G%6>s`` remainder, so this small, bounded package fills a
gap of any length. Color #0000f5, codec-matched to real content (main@3.1,
29.97 fps) so hls.js level-switches seamlessly across the splice. Silent audio
is retained in every rendition because hls.js requires audio in all of them.

Each segment is encoded standalone with a forced IDR at frame 0 so it decodes
independently — a hard HLS requirement that the encoder's ``-g 60`` default
would otherwise violate for sub-2-second segments.
"""
import subprocess
from pathlib import Path
from typing import Iterable

from video_grabber.video.encoder import RENDITIONS

_SEGMENT_DURATION = 6
# A gap of G seconds leaves a remainder of G % 6 ∈ {1..5}; those plus the
# canonical 6s segment cover every gap length the assembler can emit.
REMAINDER_SECONDS = (1, 2, 3, 4, 5)


def generate_gap_fmp4(
    output_dir: Path,
    *,
    remainder_seconds: Iterable[int] = REMAINDER_SECONDS,
) -> Path:
    """Generate the per-rendition gap package under ``output_dir``.

    Returns ``output_dir`` (the package root the uploader pushes to
    ``hls/<slug>/_gap/``). Idempotent per call — overwrites existing segments.
    """
    durations = [_SEGMENT_DURATION, *sorted(set(remainder_seconds))]
    for rend in RENDITIONS:
        rend_dir = output_dir / rend["name"]
        rend_dir.mkdir(parents=True, exist_ok=True)
        for i, secs in enumerate(durations):
            # Share one init.mp4 across the rendition's segments (identical codec
            # config), so generate it only on the first (6s) pass.
            _encode_gap_segment(
                rend, rend_dir, secs, write_init=(i == 0),
            )
    return output_dir


def _encode_gap_segment(rend: dict, rend_dir: Path, secs: int, *, write_init: bool) -> None:
    """Encode a single standalone ``seg_gap_<secs>s.m4s`` (and init.mp4 if asked)."""
    init_name = "init.mp4" if write_init else "init_tmp.mp4"
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i",
        f"color=c=0x0000f5:size={rend['width']}x{rend['height']}:rate=29.97",
        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
        "-t", str(secs),
        "-c:v", "libx264", "-profile:v", "main", "-level:v", "3.1",
        "-pix_fmt", "yuv420p",
        # Standalone segment: force a keyframe at frame 0, no scene-cut splits.
        "-g", "9999", "-keyint_min", "9999", "-sc_threshold", "0",
        "-force_key_frames", "expr:eq(n,0)",
        "-c:a", "aac", "-ar", "44100", *rend["a_flags"],
        # hls_time > secs guarantees a single output segment.
        "-hls_time", str(secs + 1),
        "-hls_list_size", "0", "-hls_playlist_type", "vod",
        "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", init_name,
        "-hls_flags", "independent_segments", "-f", "hls",
        "-hls_segment_filename", "seg%04d.m4s",
        str(rend_dir / "index.m3u8"),
    ]
    subprocess.run(cmd, check=True, cwd=rend_dir)

    (rend_dir / "seg0000.m4s").rename(rend_dir / f"seg_gap_{secs}s.m4s")
    # Drop the throwaway playlist and any non-shared init copy.
    (rend_dir / "index.m3u8").unlink(missing_ok=True)
    if not write_init:
        (rend_dir / "init_tmp.mp4").unlink(missing_ok=True)
