"""Pure SubRip/WebVTT cue model: parse, shift, merge, render.

Cue times are floats in seconds. This module has no I/O and no infra deps so it
is exhaustively unit-tested; the offset math is the linchpin of the per-channel
merge (a program airing at ``air_date`` is shifted by ``air_date − window_start``
onto the isochronous stitched timeline — see docs/transcription.md)."""

from __future__ import annotations

import re
from dataclasses import dataclass

_TIME = re.compile(r"(?P<h>\d{2}):(?P<m>\d{2}):(?P<s>\d{2})[,.](?P<ms>\d{3})")
_ARROW = re.compile(r"\s*-->\s*")


@dataclass(frozen=True)
class Cue:
    start: float
    end: float
    text: str


def _parse_ts(ts: str) -> float:
    m = _TIME.search(ts)
    if not m:
        raise ValueError(f"bad timestamp: {ts!r}")
    return int(m["h"]) * 3600 + int(m["m"]) * 60 + int(m["s"]) + int(m["ms"]) / 1000.0


def parse_srt(text: str) -> list[Cue]:
    cues: list[Cue] = []
    # Split on blank lines into blocks; each block is [index?, timing, ...text].
    for block in re.split(r"\r?\n\r?\n", text.strip()):
        lines = [ln for ln in block.splitlines() if ln.strip() != ""]
        if not lines:
            continue
        timing_idx = 0 if _ARROW.search(lines[0]) else 1
        if timing_idx >= len(lines) or not _ARROW.search(lines[timing_idx]):
            continue
        left, right = _ARROW.split(lines[timing_idx], maxsplit=1)
        body = "\n".join(lines[timing_idx + 1 :]).strip()
        if not body:
            continue
        cues.append(Cue(_parse_ts(left), _parse_ts(right), body))
    return cues


def shift(cues: list[Cue], offset_seconds: float) -> list[Cue]:
    return [Cue(c.start + offset_seconds, c.end + offset_seconds, c.text) for c in cues]


def merge(blocks: list[list[Cue]]) -> list[Cue]:
    flat = [c for block in blocks for c in block if c.text.strip()]
    return sorted(flat, key=lambda c: (c.start, c.end))


def _fmt(seconds: float, sep: str) -> str:
    if seconds < 0:
        seconds = 0.0
    ms = round(seconds * 1000)
    h, ms = divmod(ms, 3600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def render_srt(cues: list[Cue]) -> str:
    out: list[str] = []
    for i, c in enumerate(cues, start=1):
        out.append(str(i))
        out.append(f"{_fmt(c.start, ',')} --> {_fmt(c.end, ',')}")
        out.append(c.text)
        out.append("")
    return "\n".join(out)


def render_vtt(cues: list[Cue]) -> str:
    out: list[str] = ["WEBVTT", ""]
    for c in cues:
        out.append(f"{_fmt(c.start, '.')} --> {_fmt(c.end, '.')}")
        out.append(c.text)
        out.append("")
    return "\n".join(out)
