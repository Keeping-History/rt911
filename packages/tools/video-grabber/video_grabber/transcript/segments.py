"""Merge SRT cues into retrieval-sized transcript segments.

Pure logic, no I/O and no Prefect, so the timing arithmetic is unit-testable in
isolation — the same reasoning as transcribe/srt.py.

A cue is roughly a sentence, which is too small to retrieve against: a query
matches a fragment with no surrounding context. A whole program is far too
large. Thirty seconds is about a spoken paragraph, which is what the chat
composer wants to put in a prompt.
"""

from dataclasses import dataclass
from datetime import datetime

from video_grabber.transcribe.srt import Cue


@dataclass(frozen=True)
class Segment:
    start: float
    end: float
    text: str


def build_segments(
    cues: list[Cue], *, max_seconds: float = 30.0, max_gap: float = 3.0
) -> list[Segment]:
    """Group cues into segments of at most max_seconds, breaking on long silences.

    The gap rule matters as much as the duration rule: a window that spans a
    long silence would otherwise join two unrelated utterances under one time
    range, which reads as a single statement to anything retrieving it.

    A cue longer than max_seconds is emitted whole rather than split — there is
    no honest timestamp to split it at.
    """
    out: list[Segment] = []
    start: float | None = None
    end = 0.0
    parts: list[str] = []

    def flush() -> None:
        nonlocal start, end, parts
        if start is not None and parts:
            out.append(Segment(start, end, " ".join(parts)))
        start, parts = None, []

    for cue in cues:
        text = " ".join(cue.text.split())
        if not text:
            continue
        if start is not None and (cue.start - end > max_gap or cue.end - start > max_seconds):
            flush()
        if start is None:
            start = cue.start
        end = cue.end
        parts.append(text)

    flush()
    return out


def to_rows(
    segments: list[Segment],
    anchor: datetime,
    *,
    channel: int | None,
    channel_slug: str | None,
    medium: str,
) -> list[dict]:
    """Stamp segments with absolute 2001 wall-clock times, ready for Directus.

    Cue times are relative to the start of the media file; the anchor is that
    file's own start_date, so absolute = anchor + cue offset. For a channel-level
    SRT the anchor is tv_channels.start_date; for radio it is the mp3_items row's
    start_date.
    """
    if anchor.tzinfo is not None:
        raise ValueError(f"anchor must be a naive UTC datetime, got {anchor!r}")

    rows = []
    for seg in segments:
        rows.append(
            {
                "channel": channel,
                "channel_slug": channel_slug,
                "medium": medium,
                "start_date": _stamp(anchor, seg.start),
                "end_date": _stamp(anchor, seg.end),
                "text": seg.text,
            }
        )
    return rows


def _stamp(anchor: datetime, offset_seconds: float) -> str:
    from datetime import timedelta

    return (anchor + timedelta(seconds=offset_seconds)).isoformat()
