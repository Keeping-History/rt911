"""Reduce an audio file to a fixed-size amplitude envelope.

A fixed bucket count is the point. The corpus runs from 40-second clips to
6.75-hour position tapes, and storing per-file resolution would make the blob
size and the renderer both variable for no benefit at preview size. 480 pairs
is ~2 KB whatever the duration, and the component always draws 480 values
across whatever width it has.
"""
from __future__ import annotations

import struct

PEAK_BUCKETS = 480


def peaks_from_pcm(samples: bytes, buckets: int = PEAK_BUCKETS) -> list[list[int]]:
    """Signed 16-bit mono PCM -> `buckets` [min, max] pairs scaled to -128..127.

    Scaling to a byte range keeps the stored JSON small; a waveform drawn at
    preview height cannot show more precision than that anyway. `>>` 8 is a
    floor-toward-negative-infinity shift in Python, so -32768 >> 8 == -128 and
    32767 >> 8 == 127 — the full signed 16-bit range maps onto -128..127
    without a separate branch for negative values.
    """
    count = len(samples) // 2
    if count == 0:
        return [[0, 0] for _ in range(buckets)]

    values = struct.unpack(f"<{count}h", samples[: count * 2])
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
