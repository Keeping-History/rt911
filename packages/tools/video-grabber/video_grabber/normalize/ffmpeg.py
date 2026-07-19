"""ffmpeg/ffprobe subprocess wrappers for loudness normalization.

Two-pass loudnorm: pass 1 measures THROUGH the same dynaudnorm,loudnorm chain
pass 2 renders with (dynaudnorm changes loudness before loudnorm sees it, so
the analyze stage's raw-file numbers can't seed pass 2). Pass 2 uses
linear=true — one constant gain from the measurement, no second layer of
dynamic compression on top of dynaudnorm.
"""
import json
import subprocess
from pathlib import Path

from video_grabber.config import Config
from video_grabber.normalize.analysis import encode_args, parse_loudnorm_json


def _loudnorm_targets(cfg: Config) -> str:
    return f"I={cfg.norm_target_i:g}:TP={cfg.norm_target_tp:g}:LRA=11"


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed ({res.returncode}): {res.stderr[-2000:]}")
    return res


def probe(path: Path) -> dict:
    """Source encode params via ffprobe."""
    res = _run([
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ])
    data = json.loads(res.stdout)
    stream = next(s for s in data["streams"] if s.get("codec_type") == "audio")
    return {
        "bit_rate": int(data["format"]["bit_rate"]),
        "sample_rate": int(stream["sample_rate"]),
        "channels": int(stream["channels"]),
        "duration": float(data["format"]["duration"]),
    }


def measure(path: Path, cfg: Config, *, with_dynaudnorm: bool) -> dict:
    """Measurement pass → parsed loudnorm JSON (values are strings)."""
    chain = ("dynaudnorm," if with_dynaudnorm else "") + \
        f"loudnorm={_loudnorm_targets(cfg)}:print_format=json"
    res = _run([
        "ffmpeg", "-hide_banner", "-nostdin", "-i", str(path),
        "-af", chain, "-f", "null", "-",
    ])
    return parse_loudnorm_json(res.stderr)


def render(src: Path, dest: Path, measured: dict, probe_info: dict, cfg: Config) -> Path:
    """Pass-2 linear render matching the source's encode params."""
    chain = (
        f"dynaudnorm,loudnorm={_loudnorm_targets(cfg)}"
        f":measured_I={measured['input_i']}:measured_TP={measured['input_tp']}"
        f":measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}"
        f":offset={measured['target_offset']}:linear=true"
    )
    dest.parent.mkdir(parents=True, exist_ok=True)
    _run([
        "ffmpeg", "-hide_banner", "-nostdin", "-y", "-i", str(src),
        "-af", chain, *encode_args(probe_info), str(dest),
    ])
    return dest
