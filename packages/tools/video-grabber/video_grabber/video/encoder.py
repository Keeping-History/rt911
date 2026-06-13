"""
3-rendition ABR fMP4/CMAF HLS encoder.

Renditions: Full (854x480), Mid (320x240), Thumb (160x120).
No upscaling — each rung is capped at source resolution.
Three separate subprocess calls (one per rendition) for simplicity.

ffmpeg is invoked with ``-progress pipe:1 -nostats -loglevel error`` so
stdout carries machine-parseable key=value progress blocks (one per
``progress=continue|end`` sentinel) and stderr only has actual errors.
We stream stdout and log every ``_PROGRESS_LOG_INTERVAL_SEC`` seconds so
operators can see the encode advancing in real time rather than staring
at a single ``stage='encoding'`` row for 30+ minutes.
"""
import json
import logging
import os
import subprocess
import time
from pathlib import Path
from typing import Optional

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

# Hardware (VAAPI) encode path. Enabled by setting VAAPI_DEVICE to a render
# node (e.g. /dev/dri/renderD128) on a host with an AMD/Intel iGPU. The VCN
# hardware encoder runs ~10x faster than libx264 preset slow and barely touches
# the CPU. Falls back to the software path above when VAAPI_DEVICE is unset.
_VAAPI_COMMON = [
    "-c:v", "h264_vaapi", "-profile:v", "main", "-level", "31",
    "-r", "29.97", "-g", "60", "-keyint_min", "60",
    "-c:a", "aac", "-ar", "44100",
]
# Per-rendition VBR rate control, capped to match the bandwidth ladder
# advertised in the master playlist / EPG assembler.
_VAAPI_RATE = {
    "full":  ["-rc_mode", "VBR", "-b:v", "2000k", "-maxrate", "2500k", "-bufsize", "5000k"],
    "mid":   ["-rc_mode", "VBR", "-b:v", "300k",  "-maxrate", "350k",  "-bufsize", "700k"],
    "thumb": ["-rc_mode", "VBR", "-b:v", "128k",  "-maxrate", "160k",  "-bufsize", "320k"],
}

_HLS_FLAGS = [
    "-hls_time", "6", "-hls_list_size", "0", "-hls_playlist_type", "vod",
    "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
    "-hls_flags", "independent_segments", "-f", "hls",
]

# Suppress ffmpeg's chatty "real time" stderr line (`-nostats`) and the
# encoder banner (`-loglevel error`) so stderr only contains genuine errors,
# and route machine-parseable progress lines to stdout via `-progress pipe:1`.
_PROGRESS_FLAGS = ["-progress", "pipe:1", "-nostats", "-loglevel", "error"]

# How often (wall-clock seconds) to emit an encode-progress log line.
_PROGRESS_LOG_INTERVAL_SEC = 10.0

_default_log = logging.getLogger(__name__)


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


def probe_duration_seconds(path: Path) -> int:
    """Return whole-second media duration via ffprobe, or 0 if unavailable.

    Reads the container ``format.duration`` rather than a stream duration:
    MPEG program streams (.mpg) frequently report ``N/A`` at the stream
    level but carry a reliable duration on the format. Truncates to whole
    seconds to match the ``programs.duration_seconds`` integer column.
    """
    result = subprocess.run(
        [
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_format", str(path),
        ],
        capture_output=True,
    )
    try:
        data = json.loads(result.stdout or "{}")
    except json.JSONDecodeError:
        return 0
    raw = data.get("format", {}).get("duration")
    try:
        return int(float(raw))
    except (TypeError, ValueError):
        return 0


def encode_to_hls(
    input_path: Path,
    output_dir: Path,
    logger: Optional[logging.Logger] = None,
) -> Path:
    """Encode source to 3-rendition ABR HLS. Returns path to master.m3u8.

    ``logger`` is passed by the flow (Prefect ``get_run_logger()``) so
    per-rendition start/done lines and ffmpeg progress show up in the
    Prefect UI. Falls back to the module's stdlib logger for direct
    invocations.
    """
    log = logger if logger is not None else _default_log
    vaapi_device = os.getenv("VAAPI_DEVICE")
    src_w, src_h = probe_resolution(input_path)
    log.info(
        "encode: source resolution %dx%d (%s)",
        src_w, src_h, f"VAAPI {vaapi_device}" if vaapi_device else "software x264",
    )
    master_lines = ["#EXTM3U", "#EXT-X-INDEPENDENT-SEGMENTS"]

    for rend in RENDITIONS:
        out_w, out_h = scale_keep_aspect(src_w, src_h, rend["width"], rend["height"])
        rend_dir = output_dir / rend["name"]
        rend_dir.mkdir(parents=True, exist_ok=True)

        if vaapi_device:
            # Deinterlace + scale on CPU (cheap), then hand frames to the GPU
            # encoder. `hwupload` needs the device declared via -vaapi_device.
            vf = (
                f"yadif=mode=0:parity=-1:deint=1,"
                f"scale={out_w}:{out_h}:flags=lanczos,format=nv12,hwupload"
            )
            cmd = (
                ["ffmpeg", "-y"]
                + _PROGRESS_FLAGS
                + ["-vaapi_device", vaapi_device, "-i", str(input_path), "-vf", vf]
                + _VAAPI_COMMON
                + _VAAPI_RATE[rend["name"]]
                + rend["a_flags"]
                + _HLS_FLAGS
                + ["-hls_segment_filename", "seg%04d.m4s", str(rend_dir / "index.m3u8")]
            )
        else:
            vf = (
                f"yadif=mode=0:parity=-1:deint=1,"
                f"scale={out_w}:{out_h}:flags=lanczos"
            )
            cmd = (
                ["ffmpeg", "-y"]
                + _PROGRESS_FLAGS
                + ["-i", str(input_path), "-vf", vf]
                + _COMMON_FLAGS
                + rend["v_flags"]
                + rend["a_flags"]
                + _HLS_FLAGS
                + ["-hls_segment_filename", "seg%04d.m4s", str(rend_dir / "index.m3u8")]
            )
        log.info("encode: starting rendition %s (%dx%d)", rend["name"], out_w, out_h)
        t0 = time.monotonic()
        _run_ffmpeg_with_progress(cmd, label=rend["name"], cwd=rend_dir, logger=log)
        log.info(
            "encode: rendition %s done in %.1fs",
            rend["name"], time.monotonic() - t0,
        )

        master_lines += [
            f"#EXT-X-STREAM-INF:BANDWIDTH={rend['bandwidth']},RESOLUTION={out_w}x{out_h}",
            f"{rend['name']}/index.m3u8",
        ]

    master = output_dir / "master.m3u8"
    master.write_text("\n".join(master_lines) + "\n")
    log.info("encode: wrote master playlist %s", master)
    return master


def _run_ffmpeg_with_progress(
    cmd: list[str],
    *,
    label: str,
    cwd: Path,
    logger: logging.Logger,
) -> None:
    """Run ffmpeg streaming its `-progress pipe:1` output and emitting a
    progress log line at most every ``_PROGRESS_LOG_INTERVAL_SEC`` seconds.

    Raises RuntimeError on non-zero exit, including the stderr tail so
    the operator can see what went wrong.
    """
    proc = subprocess.Popen(
        cmd,
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    last_log = time.monotonic()
    field: dict[str, str] = {}
    try:
        assert proc.stdout is not None  # for type-checkers
        for raw in proc.stdout:
            line = raw.strip()
            if not line or "=" not in line:
                continue
            k, v = line.split("=", 1)
            field[k] = v
            if k != "progress":
                continue
            now = time.monotonic()
            is_terminal = v == "end"
            if is_terminal or (now - last_log) >= _PROGRESS_LOG_INTERVAL_SEC:
                out_time_us = _safe_int(field.get("out_time_us") or field.get("out_time_ms", "0"))
                logger.info(
                    "encode %s: t=%.1fs frame=%s fps=%s speed=%s bitrate=%s size=%s",
                    label,
                    out_time_us / 1_000_000,
                    field.get("frame", "?"),
                    field.get("fps", "?"),
                    field.get("speed", "?"),
                    field.get("bitrate", "?"),
                    field.get("total_size", "?"),
                )
                last_log = now
            field.clear()
    finally:
        proc.wait()
    if proc.returncode != 0:
        assert proc.stderr is not None
        stderr_tail = proc.stderr.read()[-2000:]
        raise RuntimeError(f"FFmpeg failed ({label}): {stderr_tail}")


def _safe_int(value: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0
