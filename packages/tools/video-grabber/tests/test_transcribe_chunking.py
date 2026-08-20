import pytest

from video_grabber.transcribe.chunking import windows


def test_short_recording_is_one_window():
    assert windows(120.0, chunk_s=600, overlap_s=5) == [(0, 120000)]


def test_exact_multiple_produces_no_trailing_sliver():
    assert windows(1200.0, chunk_s=600, overlap_s=0) == [(0, 600000), (600000, 600000)]


def test_windows_overlap_so_speech_on_a_boundary_is_not_lost():
    got = windows(1200.0, chunk_s=600, overlap_s=5)
    assert got[1][0] == 595000


def test_final_window_is_clipped_to_the_real_end():
    got = windows(1300.0, chunk_s=600, overlap_s=0)
    assert got[-1][0] + got[-1][1] == 1300000


def test_a_six_hour_tape_is_split_into_bounded_windows():
    got = windows(24299.0, chunk_s=600, overlap_s=5)
    assert all(d <= 600000 for _, d in got)
    assert got[0][0] == 0
    assert got[-1][0] + got[-1][1] == 24299000


def test_every_second_of_audio_is_covered():
    # A gap between windows silently drops speech; this is the invariant that
    # matters more than the exact window count.
    got = windows(24299.0, chunk_s=600, overlap_s=5)
    reach = 0
    for start, length in got:
        assert start <= reach, f"gap before {start}"
        reach = max(reach, start + length)
    assert reach == 24299000


def test_zero_duration_raises_rather_than_returning_nothing():
    with pytest.raises(ValueError):
        windows(0, chunk_s=600, overlap_s=5)


def test_overlap_larger_than_chunk_raises():
    with pytest.raises(ValueError):
        windows(1200.0, chunk_s=600, overlap_s=600)
