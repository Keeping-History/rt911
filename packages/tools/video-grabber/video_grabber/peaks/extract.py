"""Reduce an audio file to a fixed-size amplitude envelope.

A fixed bucket count is the point. The corpus runs from 40-second clips to
6.75-hour position tapes, and storing per-file resolution would make the blob
size and the renderer both variable for no benefit at preview size. 480 pairs
is ~2 KB whatever the duration, and the component always draws 480 values
across whatever width it has.
"""
from __future__ import annotations

import sys
from array import array

PEAK_BUCKETS = 480


def peaks_from_pcm(samples: bytes, buckets: int = PEAK_BUCKETS) -> list[list[int]]:
    """Signed 16-bit mono PCM -> `buckets` [min, max] pairs scaled to -128..127.

    Scaling to a byte range keeps the stored JSON small; a waveform drawn at
    preview height cannot show more precision than that anyway. `>>` 8 is a
    floor-toward-negative-infinity shift in Python, so -32768 >> 8 == -128 and
    32767 >> 8 == 127 — the full signed 16-bit range maps onto -128..127
    without a separate branch for negative values.

    The corpus's longest tape is 6.75 hours: at 8 kHz mono that's ~194M
    samples, ~389 MB of 16-bit PCM (2 bytes/sample — samples and bytes are
    not the same number). `struct.unpack` would box every sample as a Python
    int in a tuple — ~16x the raw byte size, multi-GB peak RSS on that one
    file. `array("h")` stores samples as packed machine shorts (same 2
    bytes/sample as the source) while still supporting the slicing the
    bucket loop below relies on. Building it via `frombytes` off a
    `memoryview` slice, rather than slicing the `bytes` object first, avoids
    one full-size copy: a `bytes` slice copies, a `memoryview` slice does
    not. The caller's PCM buffer (~389 MB for the largest tape) is still
    live alongside the array's own copy while this runs, so the honest peak
    is ~780 MB, not the "under 200 MB" an earlier version of this comment
    claimed. `array` uses native byte order, unlike `struct`'s explicit
    `<h`, so a big-endian host needs an explicit byteswap to preserve the
    little-endian contract ffmpeg is asked for.
    """
    count = len(samples) // 2
    if count == 0:
        return [[0, 0] for _ in range(buckets)]

    values = array("h")
    values.frombytes(memoryview(samples)[: count * 2])
    if sys.byteorder == "big":
        values.byteswap()
    out: list[list[int]] = []
    for i in range(buckets):
        lo_idx = (i * count) // buckets
        hi_idx = max(((i + 1) * count) // buckets, lo_idx + 1)
        window = values[lo_idx:hi_idx]
        if not window:
            out.append([0, 0])
            continue
        out.append([min(window) >> 8, max(window) >> 8])
    return out
