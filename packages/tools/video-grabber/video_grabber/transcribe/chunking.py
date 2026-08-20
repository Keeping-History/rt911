"""Split a recording into bounded transcription windows.

Whole-file transcription of the long position tapes fails badly: a single
5-minute window of the NEADS MCC tape yields 150 words while the entire 6.67-hour
file yields 84. Bounding the window bounds the decoder state.

Windows overlap slightly so a sentence straddling a boundary is seen whole by at
least one window; the merge step de-duplicates the repeated cues.
"""
from __future__ import annotations


def windows(duration_s: float, chunk_s: int, overlap_s: int) -> list[tuple[int, int]]:
    """Return [(offset_ms, duration_ms), …] covering the whole recording."""
    if duration_s <= 0:
        raise ValueError(f"duration must be positive, got {duration_s!r}")
    if overlap_s >= chunk_s:
        raise ValueError(
            f"overlap_s ({overlap_s}) must be smaller than chunk_s ({chunk_s})"
        )

    total_ms = int(round(duration_s * 1000))
    chunk_ms = chunk_s * 1000
    step = chunk_ms - overlap_s * 1000

    if total_ms <= chunk_ms:
        return [(0, total_ms)]

    out: list[tuple[int, int]] = []
    start = 0
    while start < total_ms:
        length = min(chunk_ms, total_ms - start)
        out.append((start, length))
        if start + length >= total_ms:
            break
        start += step
    return out
