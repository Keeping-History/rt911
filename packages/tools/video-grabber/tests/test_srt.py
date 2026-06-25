from video_grabber.transcribe.srt import (
    Cue,
    dedupe_consecutive,
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


def test_dedupe_consecutive_removes_loop():
    # Simulates a whisper hallucination loop: phrase repeated 5× at end.
    phrase = " Oh, my goodness, there's another plane."
    cues = [
        Cue(0.0, 1.0, "Intro"),
        Cue(1.0, 2.0, "Middle content"),
        Cue(2.0, 3.0, phrase),
        Cue(3.0, 4.0, phrase),
        Cue(4.0, 5.0, phrase),
        Cue(5.0, 6.0, phrase),
        Cue(6.0, 7.0, phrase),
    ]
    result = dedupe_consecutive(cues)
    assert len(result) == 3
    assert result[0].text == "Intro"
    assert result[1].text == "Middle content"
    assert result[2].text == phrase


def test_dedupe_consecutive_keeps_non_consecutive_repeats():
    # Legitimately repeated phrase separated by other content is kept.
    cues = [
        Cue(0.0, 1.0, "Hello"),
        Cue(1.0, 2.0, "World"),
        Cue(2.0, 3.0, "Hello"),
    ]
    assert dedupe_consecutive(cues) == cues


def test_dedupe_consecutive_handles_whitespace_variants():
    cues = [
        Cue(0.0, 1.0, "Line one"),
        Cue(1.0, 2.0, " Line one "),   # leading/trailing space — same after strip
        Cue(2.0, 3.0, "Line two"),
    ]
    result = dedupe_consecutive(cues)
    assert len(result) == 2
    assert result[1].text == "Line two"


def test_dedupe_consecutive_empty():
    assert dedupe_consecutive([]) == []
