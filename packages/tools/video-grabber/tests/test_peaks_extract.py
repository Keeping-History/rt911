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
