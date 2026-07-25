from datetime import datetime

import pytest

from video_grabber.transcribe.srt import Cue
from video_grabber.transcript.segments import Segment, build_segments, to_rows


def test_merges_adjacent_cues_into_one_segment():
    cues = [Cue(0.0, 2.0, "the north tower"), Cue(2.0, 4.0, "has been hit")]
    segs = build_segments(cues)
    assert segs == [Segment(0.0, 4.0, "the north tower has been hit")]


def test_splits_when_max_seconds_would_be_exceeded():
    cues = [Cue(float(i) * 10.0, float(i) * 10.0 + 10.0, f"c{i}") for i in range(4)]
    segs = build_segments(cues, max_seconds=30.0)
    assert len(segs) == 2
    assert segs[0].start == 0.0 and segs[0].end == 30.0
    assert segs[0].text == "c0 c1 c2"
    assert segs[1].start == 30.0 and segs[1].end == 40.0


def test_splits_on_a_long_gap_even_when_under_max_seconds():
    # A 30s window spanning a long silence would otherwise produce one segment
    # whose text is two unrelated utterances under a misleading time range.
    cues = [Cue(0.0, 1.0, "before"), Cue(9.0, 10.0, "after")]
    segs = build_segments(cues, max_seconds=30.0, max_gap=3.0)
    assert len(segs) == 2
    assert segs[0].text == "before"
    assert segs[1].text == "after"


def test_gap_exactly_at_the_threshold_does_not_split():
    cues = [Cue(0.0, 1.0, "before"), Cue(4.0, 5.0, "after")]
    segs = build_segments(cues, max_seconds=30.0, max_gap=3.0)
    assert len(segs) == 1


def test_drops_empty_and_whitespace_only_cues():
    cues = [Cue(0.0, 1.0, "kept"), Cue(1.0, 2.0, "   "), Cue(2.0, 3.0, "")]
    segs = build_segments(cues)
    assert segs == [Segment(0.0, 1.0, "kept")]


def test_collapses_internal_whitespace_and_newlines():
    cues = [Cue(0.0, 2.0, "two lines\nof  text")]
    segs = build_segments(cues)
    assert segs[0].text == "two lines of text"


def test_empty_input_yields_no_segments():
    assert build_segments([]) == []


def test_a_single_cue_longer_than_max_seconds_is_kept_whole():
    # Splitting mid-cue would invent a timestamp for text we cannot place.
    cues = [Cue(0.0, 45.0, "a very long uninterrupted statement")]
    segs = build_segments(cues, max_seconds=30.0)
    assert len(segs) == 1
    assert segs[0].end == 45.0


def test_to_rows_offsets_by_the_anchor():
    anchor = datetime(2001, 9, 11, 12, 0, 0)
    segs = [Segment(90.0, 120.0, "text")]
    rows = to_rows(segs, anchor, channel=7, channel_slug="wnbc", medium="tv")
    assert rows == [
        {
            "channel": 7,
            "channel_slug": "wnbc",
            "medium": "tv",
            "start_date": "2001-09-11T12:01:30",
            "end_date": "2001-09-11T12:02:00",
            "text": "text",
        }
    ]


def test_to_rows_rejects_an_aware_anchor():
    # Mixing naive and aware datetimes is a tested bug class in this package;
    # fail loudly at the boundary rather than silently shifting by the offset.
    from datetime import timezone

    with pytest.raises(ValueError, match="naive UTC"):
        to_rows([Segment(0.0, 1.0, "t")], datetime(2001, 9, 11, tzinfo=timezone.utc),
                channel=1, channel_slug=None, medium="tv")
