"""Invoke whisper.cpp (whisper-cli) to caption a 16 kHz mono WAV.

whisper.cpp writes `<out_base>.srt` and `<out_base>.vtt` natively, so there is no
SRT→VTT conversion step. The Vulkan backend runs the compute on the encode-1 AMD
iGPU (see Dockerfile whisper-builder stage); on a host without Vulkan it falls
back to CPU automatically. Language is pinned to English (the .en model)."""
from __future__ import annotations

import subprocess
from pathlib import Path

from video_grabber.config import Config


def transcribe_wav(wav: Path, out_base: Path, cfg: Config, *, runner=subprocess.run) -> Path:
    out_base.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        cfg.whisper_bin,
        "-m", cfg.whisper_model,
        "-t", str(cfg.whisper_threads),
        "-l", "en",
        "--output-srt",
        "--output-vtt",
        "--output-file", str(out_base),
        str(wav),
    ]
    result = runner(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"whisper-cli failed ({result.returncode}): {result.stderr[-2000:]}")
    return out_base.with_suffix(".srt")
