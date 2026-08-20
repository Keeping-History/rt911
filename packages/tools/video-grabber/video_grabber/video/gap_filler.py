"""
Blue gap pool — sequenced fMP4 segments the EPG assembler splices into dead air.

A gap (dead air between recordings) is filled by referencing a POOL of pre-encoded
blue segments **in order** (seg0000, seg0001, …). Because the pool is one
*continuous* encode, every tile carries a real, increasing fMP4 ``mfhd``
sequence_number and ``tfdt`` baseMediaDecodeTime — which conformant players
(VLC, AVFoundation/QuickTime) require. The earlier design repeated ONE fragment,
so every copy shared ``sequence_number=1`` / ``tfdt=0``; players logged
"Fragment sequence discontinuity 1 != 2" and mis-timed the dead air into minutes
of seek drift. Verified in VLC: the repeated fragment throws the error on every
tile, the sequenced pool throws none.

For a gap longer than the pool, the assembler resets with ``#EXT-X-DISCONTINUITY``
and reuses the pool from seg0000 (a discontinuity lets the media timeline
restart), so this bounded pool fills arbitrarily long gaps. Verified in VLC:
clean and exact-duration across 50 reuse runs.

The pool is channel-independent (it's just blue), so it lives at a single shared
prefix and is uploaded once. ``POOL_VERSION`` is part of that path: bump it
whenever the encoding changes, because segments carry a 1-year ``max-age`` at a
fixed URL and a new path is the only way past the CDN, the proxy, and a viewer's
OS URL cache at once.

30 fps + no B-frames so each tile's presentation extent is clean; one forced IDR
every 6 s so each segment decodes independently (a hard HLS requirement). Silent
audio is retained in every rendition because hls.js requires audio in all of them.
"""
import subprocess
from pathlib import Path

from video_grabber.video.encoder import RENDITIONS

# Bump on any gap-encoding change (see module docstring on caching).
POOL_VERSION = "_gap.v3"
# 1 hour of 6 s tiles. The assembler reuses the pool across discontinuities for
# longer gaps, so this only bounds how often a long gap re-anchors — it does not
# limit gap length. Kept modest to keep the one-time shared upload small.
POOL_TILES = 600
TILE_SECONDS = 6


def generate_gap_pool(output_dir: Path, *, pool_tiles: int = POOL_TILES) -> int:
    """Encode the per-rendition sequenced blue pool under ``output_dir``.

    Produces ``<rend>/init.mp4`` + ``<rend>/seg0000.m4s … seg{N-1}.m4s`` for each
    rendition, with native increasing sequence_number/tfdt. Returns the tile count.
    """
    for rend in RENDITIONS:
        rend_dir = output_dir / rend["name"]
        rend_dir.mkdir(parents=True, exist_ok=True)
        _encode_pool(rend, rend_dir, pool_tiles)
    return pool_tiles


def _encode_pool(rend: dict, rend_dir: Path, pool_tiles: int) -> None:
    """One continuous blue encode segmented at ``TILE_SECONDS`` — ffmpeg stamps
    each fragment with the correct increasing sequence_number and tfdt."""
    seconds = pool_tiles * TILE_SECONDS
    keyint = TILE_SECONDS * 30  # one IDR per segment at 30 fps
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i",
        f"color=c=0x0000f5:size={rend['width']}x{rend['height']}:rate=30",
        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
        "-t", str(seconds),
        "-c:v", "libx264", "-profile:v", "main", "-level:v", "3.1",
        "-pix_fmt", "yuv420p", "-bf", "0",
        "-g", str(keyint), "-keyint_min", str(keyint), "-sc_threshold", "0",
        "-c:a", "aac", "-ar", "44100", *rend["a_flags"],
        "-hls_time", str(TILE_SECONDS), "-hls_list_size", "0", "-hls_playlist_type", "vod",
        "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
        "-hls_flags", "independent_segments", "-f", "hls",
        "-hls_segment_filename", "seg%04d.m4s",
        str(rend_dir / "index.m3u8"),
    ]
    subprocess.run(cmd, check=True, cwd=rend_dir)
    # The throwaway playlist isn't needed: tiles are uniform TILE_SECONDS and the
    # assembler references them by index.
    (rend_dir / "index.m3u8").unlink(missing_ok=True)
