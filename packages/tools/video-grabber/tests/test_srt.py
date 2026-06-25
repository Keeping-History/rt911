from video_grabber.transcribe.srt import (
    Cue,
    parse_srt,
    shift,
    merge,
    render_srt,
    render_vtt,
)

SAMPLE = (
    "1\n"
    "00:00:01,000 --> 00:00:02,500\n"
    "Hello world\n"
    "\n"
    "2\n"
    "00:00:03,000 --> 00:00:04,000\n"
    "Second line\n"
)


def test_parse_srt_reads_times_and_text():
    cues = parse_srt(SAMPLE)
    assert len(cues) == 2
    assert cues[0] == Cue(start=1.0, end=2.5, text="Hello world")
    assert cues[1].text == "Second line"


def test_parse_srt_joins_multiline_text():
    cues = parse_srt("1\n00:00:00,000 --> 00:00:01,000\nline a\nline b\n")
    assert cues[0].text == "line a\nline b"


def test_shift_adds_offset_to_both_ends():
    cues = shift(parse_srt(SAMPLE), 3600.0)
    assert cues[0].start == 3601.0
    assert cues[0].end == 3602.5


def test_merge_orders_by_start_and_drops_empty_blocks():
    a = [Cue(10.0, 11.0, "later")]
    b = [Cue(1.0, 2.0, "earlier")]
    merged = merge([a, [], b])
    assert [c.text for c in merged] == ["earlier", "later"]


def test_render_srt_roundtrips():
    cues = [Cue(1.0, 2.5, "Hello world"), Cue(3.0, 4.0, "Second line")]
    out = render_srt(cues)
    assert "00:00:01,000 --> 00:00:02,500" in out
    assert parse_srt(out) == cues


def test_render_vtt_has_header_and_dot_millis():
    out = render_vtt([Cue(1.0, 2.5, "Hi")])
    assert out.startswith("WEBVTT\n\n")
    assert "00:00:01.000 --> 00:00:02.500" in out
