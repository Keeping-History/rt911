import struct

from video_grabber.peaks.extract import PEAK_BUCKETS, peaks_from_pcm


def pcm(values):
    """Signed 16-bit little-endian mono, the format ffmpeg is asked for."""
    return b"".join(struct.pack("<h", v) for v in values)


def test_silence_yields_flat_peaks_rather_than_raising():
    out = peaks_from_pcm(pcm([0] * 4800), buckets=10)
    assert len(out) == 10
    assert all(lo == 0 and hi == 0 for lo, hi in out)


def test_full_scale_reaches_the_extremes():
    out = peaks_from_pcm(pcm([32767, -32768] * 2400), buckets=10)
    assert max(hi for _, hi in out) == 127
    assert min(lo for lo, _ in out) == -128


def test_bucket_count_is_fixed_regardless_of_length():
    short = peaks_from_pcm(pcm([1000] * 1000))
    long = peaks_from_pcm(pcm([1000] * 1_000_000))
    assert len(short) == len(long) == PEAK_BUCKETS


def test_a_file_shorter_than_the_bucket_count_still_fills_every_bucket():
    out = peaks_from_pcm(pcm([500] * 10), buckets=100)
    assert len(out) == 100


def test_empty_input_yields_flat_peaks():
    assert peaks_from_pcm(b"", buckets=5) == [[0, 0]] * 5


def test_non_divisible_bucket_count_partitions_correctly():
    """7 samples into 3 buckets doesn't divide evenly, and a ramp (rather
    than a flat value) means a shifted window boundary changes the numbers
    instead of silently passing.

    Partition (lo_idx = i*7//3, hi_idx = max((i+1)*7//3, lo_idx+1)):
      bucket 0: samples[0:2] = [0, 500]              -> >>8 = [0, 1]
      bucket 1: samples[2:4] = [1000, 1500]          -> >>8 = [3, 5]
      bucket 2: samples[4:7] = [2000, 2500, 3000]    -> >>8 = [7, 11]
    """
    out = peaks_from_pcm(pcm([0, 500, 1000, 1500, 2000, 2500, 3000]), buckets=3)
    assert out == [[0, 1], [3, 5], [7, 11]]


def test_odd_length_input_ignores_the_trailing_byte():
    """A truncated final sample (odd total byte count) must not raise and
    must not be read as a spurious extra sample."""
    truncated = pcm([1000, -2000, 3000]) + b"\xff"
    out = peaks_from_pcm(truncated, buckets=3)
    assert out == [[3, 3], [-8, -8], [11, 11]]
