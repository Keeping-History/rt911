"""
3-rendition ABR fMP4/CMAF HLS encoder.

Renditions: Full (854x480), Mid (320x240), Thumb (160x120).
No upscaling — each rung is capped at source resolution.
Three separate subprocess.run calls (one per rendition) for simplicity.
"""
import json
import subprocess
from pathlib import Path

RENDITIONS = [
    {
        "name": "full",
        "width": 854,
        "height": 480,
        "v_flags": ["-crf", "21", "-maxrate", "2500k", "-bufsize", "5000k"],
        "a_flags": ["-b:a", "128k", "-ac", "2"],
        "bandwidth": 2628000,
    },
    {
        "name": "mid",
        "width": 320,
        "height": 240,
        "v_flags": ["-b:v", "300k", "-maxrate", "350k", "-bufsize", "700k"],
        "a_flags": ["-b:a", "96k", "-ac", "2"],
        "bandwidth": 396000,
    },
    {
        "name": "thumb",
        "width": 160,
        "height": 120,
        "v_flags": ["-b:v", "128k", "-maxrate", "160k", "-bufsize", "320k"],
        "a_flags": ["-b:a", "8k", "-ac", "1"],
        "bandwidth": 136000,
    },
]

_COMMON_FLAGS = [
    "-c:v", "libx264", "-profile:v", "main", "-level:v", "3.1",
    "-preset", "slow", "-r", "29.97",
    "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
    "-c:a", "aac", "-ar", "44100",
]

_HLS_FLAGS = [
    "-hls_time", "6", "-hls_list_size", "0", "-hls_playlist_type", "vod",
    "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
    "-hls_flags", "independent_segments", "-f", "hls",
]


def scale_keep_aspect(src_w: int, src_h: int, max_w: int, max_h: int) -> tuple[int, int]:
    """Scale src to fit within max_w x max_h without upscaling. Output dims are always even."""
    if src_w <= max_w and src_h <= max_h:
        out_w, out_h = src_w, src_h
    else:
        scale = min(max_w / src_w, max_h / src_h)
        out_w = int(src_w * scale)
        out_h = int(src_h * scale)
    # H.264 requires even dimensions
    out_w = (out_w // 2) * 2
    out_h = (out_h // 2) * 2
    return out_w, out_h


def probe_resolution(path: Path) -> tuple[int, int]:
    """Return (width, height) of the first video stream via ffprobe."""
    result = _probe(path)
    data = json.loads(result.stdout)
    for stream in data.get("streams", []):
        w = stream.get("width")
        h = stream.get("height")
        if w and h:
            return int(w), int(h)
    raise ValueError(f"No video stream found in {path}")


def _probe(path: Path):
    return subprocess.run(
        [
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_streams", "-select_streams", "v:0", str(path),
        ],
        capture_output=True,
    )


def encode_to_hls(input_path: Path, output_dir: Path) -> Path:
    """Encode source to 3-rendition ABR HLS. Returns path to master.m3u8."""
    src_w, src_h = probe_resolution(input_path)
    master_lines = ["#EXTM3U", "#EXT-X-INDEPENDENT-SEGMENTS"]

    for rend in RENDITIONS:
        out_w, out_h = scale_keep_aspect(src_w, src_h, rend["width"], rend["height"])
        rend_dir = output_dir / rend["name"]
        rend_dir.mkdir(parents=True, exist_ok=True)

        vf = (
            f"yadif=mode=0:parity=-1:deint=1,"
            f"scale={out_w}:{out_h}:flags=lanczos"
        )
        cmd = (
            ["ffmpeg", "-i", str(input_path), "-vf", vf]
            + _COMMON_FLAGS
            + rend["v_flags"]
            + rend["a_flags"]
            + _HLS_FLAGS
            + ["-hls_segment_filename", "seg%04d.m4s", str(rend_dir / "index.m3u8")]
        )
        result = subprocess.run(cmd, capture_output=True)
        if result.returncode != 0:
            raise RuntimeError(
                f"FFmpeg failed ({rend['name']}): {result.stderr.decode()}"
            )

        master_lines += [
            f"#EXT-X-STREAM-INF:BANDWIDTH={rend['bandwidth']},RESOLUTION={out_w}x{out_h}",
            f"{rend['name']}/index.m3u8",
        ]

    master = output_dir / "master.m3u8"
    master.write_text("\n".join(master_lines) + "\n")
    return master
