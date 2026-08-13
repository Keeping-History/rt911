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


def test_parses_hours_beyond_two_digits():
    """A stitched 9-day channel runs past hour 99, and the hour field grows.

    This was a live data-corruption bug, not a theoretical one. _TIME required
    exactly two digits and used .search(), so "100:00:05,000" quietly matched the
    SUBSTRING "00:00:05,000" -- hour 100 read as hour 0. Every cue past hour 99
    landed exactly 100 hours early, which put 09-13 coverage at 09-09 and fed
    buddies post-attack content as "what you have just heard on TV" on the
    morning of 9/11. CNN alone had 114,038 affected timestamps.
    """
    cues = parse_srt("1\n100:00:05,000 --> 100:00:09,000\nlater-day line\n")
    assert len(cues) == 1
    assert cues[0].start == 360005.0, "hour 100 must not be read as hour 0"
    assert cues[0].end == 360009.0


def test_parses_three_digit_hours_at_the_end_of_a_nine_day_stream():
    # 9 days is 216 hours; the last cues of a full stitched channel look like this.
    cues = parse_srt("1\n215:59:58,500 --> 215:59:59,900\nfinal line\n")
    assert cues[0].start == 777598.5
    assert cues[0].end == 777599.9


def test_round_trips_a_three_digit_hour_through_render():
    # The writer was never broken -- _fmt's {h:02d} is a MINIMUM width, so it
    # already emits "100:00:05,000". Only the reader was. Pin both directions so
    # they cannot drift apart again.
    original = [Cue(360005.0, 360009.0, "later-day line")]
    assert parse_srt(render_srt(original)) == original


def test_a_cue_never_parses_to_an_end_before_its_start():
    # The observable symptom in production: a cue spanning the 99->100 hour
    # boundary parsed as start=359985, end=4, because only the end had three
    # digits. An end before a start is impossible and must never parse silently.
    cues = parse_srt("1\n99:59:45,000 --> 100:00:04,000\nspans the boundary\n")
    assert cues[0].end > cues[0].start


def test_strips_music_and_blank_audio_markers():
    from video_grabber.transcribe.srt import strip_nonspeech_cues
    cues = [Cue(0, 1, "[Music]"), Cue(1, 2, "Bravo 112"),
            Cue(2, 3, "[BLANK_AUDIO]"), Cue(3, 4, "♪♪")]
    assert [c.text for c in strip_nonspeech_cues(cues)] == ["Bravo 112"]


def test_keeps_inaudible_markers_because_they_mark_real_speech():
    # '[unintelligible]' means someone spoke and whisper could not resolve it.
    # That is information; '[Music]' over an open mic is not.
    from video_grabber.transcribe.srt import strip_nonspeech_cues
    cues = [Cue(0, 1, "[unintelligible]"), Cue(1, 2, "Bravo 112")]
    assert len(strip_nonspeech_cues(cues)) == 2


def test_leaves_ordinary_speech_untouched():
    from video_grabber.transcribe.srt import strip_nonspeech_cues
    cues = [Cue(0, 1, "American 77, Indy Center")]
    assert strip_nonspeech_cues(cues) == cues
