"""Pure SubRip/WebVTT cue model: parse, shift, merge, render.

Cue times are floats in seconds. This module has no I/O and no infra deps so it
is exhaustively unit-tested; the offset math is the linchpin of the per-channel
merge (a program airing at ``air_date`` is shifted by ``air_date − window_start``
onto the isochronous stitched timeline — see docs/transcription.md)."""

from __future__ import annotations

import re
from dataclasses import dataclass

# Hours are \d+, not \d{2}. A stitched channel spans nine days, so the hour field
# runs past 99 and grows a third digit -- which _fmt has always emitted correctly,
# because {h:02d} is a MINIMUM width. Only reading was broken.
#
# The anchor matters as much as the quantifier. This was previously matched with
# .search() and a two-digit hour, so "100:00:05,000" quietly matched the SUBSTRING
# "00:00:05,000" starting one character in: hour 100 read as hour 0, no error, no
# warning. Every cue past hour 99 landed exactly 100 hours early, which put 09-13
# coverage at 09-09 and fed buddies post-attack television as "what you have just
# heard" on the morning of 9/11. Anchoring makes a partial match impossible rather
# than merely unlikely.
_TIME = re.compile(r"\s*(?P<h>\d+):(?P<m>\d{2}):(?P<s>\d{2})[,.](?P<ms>\d{3})")
_ARROW = re.compile(r"\s*-->\s*")


@dataclass(frozen=True)
class Cue:
    start: float
    end: float
    text: str


def _parse_ts(ts: str) -> float:
    m = _TIME.match(ts)
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


def dedupe_consecutive(cues: list[Cue]) -> list[Cue]:
    """Drop consecutive cues whose stripped text is identical.

    Whisper hallucination loops produce a run of identical phrases at the end
    of a transcription (usually over silence or low-confidence audio). Keeping
    only the first occurrence of each consecutive run removes the artifact while
    preserving legitimately repeated phrases that are separated by other content."""
    if not cues:
        return cues
    result = [cues[0]]
    for cue in cues[1:]:
        if cue.text.strip() != result[-1].text.strip():
            result.append(cue)
    return result


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


# Markers whisper emits for non-speech audio. Deliberately excludes
# [unintelligible] / [inaudible]: those mark speech that could not be resolved,
# which is information worth keeping.
_NONSPEECH = re.compile(
    r"^\s*[\[\(]?\s*(music|blank_audio|silence|sound|noise|applause)\s*[\]\)]?\s*$",
    re.I,
)
_MUSIC_GLYPHS = re.compile(r"^[\s♪♫♩♬]+$")


def strip_nonspeech_cues(cues: list[Cue]) -> list[Cue]:
    """Drop cues that carry no speech at all.

    dedupe_consecutive() collapses runs of identical cues, which turned six hours
    of open-mic [Music] into a single cue and made an empty transcript look like a
    clean one. Removing them outright is the honest representation.
    """
    return [c for c in cues
            if not _NONSPEECH.match(c.text) and not _MUSIC_GLYPHS.match(c.text)]


# A hallucination loop repeats a short cycle of phrases. Period 1 is the classic
# "same line over and over"; the NEADS MCC tape produced a period-2 A/B/A/B loop
# 447 cues long. Cap the period so a genuinely repetitive exchange (a readback,
# a roll call) is not mistaken for an artifact, and require several repeats so
# ordinary speech that happens to echo survives.
_LOOP_MAX_PERIOD = 4
_LOOP_MIN_REPEATS = 3


def collapse_repetition_loops(cues: list[Cue],
                              max_period: int = _LOOP_MAX_PERIOD,
                              min_repeats: int = _LOOP_MIN_REPEATS) -> list[Cue]:
    """Collapse whisper hallucination loops to a single cycle.

    dedupe_consecutive only removes runs of IDENTICAL neighbours, so an
    alternating A/B/A/B loop passes through it untouched — every cue differs
    from the one before it. On the NEADS MCC tape that inflated a ~2,177-word
    transcript to 4,738 words of fabricated dialogue, which then becomes input
    to party identification.

    Only *cycles* are collapsed. A phrase that recurs scattered between genuine
    content ("Okay", a callsign) is speech, not an artifact, and is preserved.

    Loops with a period longer than ``max_period`` are not detected; that is a
    deliberate floor on how much repetition counts as real dialogue.
    """
    if not cues:
        return cues
    texts = [c.text.strip() for c in cues]
    n = len(cues)
    out: list[Cue] = []
    i = 0
    while i < n:
        collapsed = False
        # Smallest period first: an A/A/A/A run is a period-1 loop, not period-2.
        for period in range(1, max_period + 1):
            if i + period * min_repeats > n:
                continue
            block = texts[i:i + period]
            repeats = 1
            while texts[i + repeats * period:i + (repeats + 1) * period] == block:
                repeats += 1
            if repeats >= min_repeats:
                out.extend(cues[i:i + period])
                i += period * repeats
                collapsed = True
                break
        if not collapsed:
            out.append(cues[i])
            i += 1
    return out
