"""Extract 16 kHz mono WAV from any media URL via ffmpeg (already in the image).

Reads straight from the public files.911realtime.org URL — HLS master playlist
for TV programs, MP3 for radio — so no source re-download is needed. whisper.cpp
wants 16 kHz mono PCM; we hand it exactly that."""
from __future__ import annotations

import subprocess
from pathlib import Path


def extract_audio(src_url: str, out_wav: Path, *, runner=subprocess.run) -> Path:
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y",
        "-i", src_url,
        "-vn",
        "-ar", "16000",
        "-ac", "1",
        "-f", "wav",
        str(out_wav),
    ]
    result = runner(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed ({result.returncode}): {result.stderr[-2000:]}")
    return out_wav
