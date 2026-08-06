from datetime import datetime

import pytest

from video_grabber.transcript.minutes import (
    build_minutes,
    clean,
    condense,
    to_minute_rows,
)
from video_grabber.transcript.segments import Segment

ANCHOR = datetime(2001, 9, 11, 12, 40, 0)


def test_clean_strips_annotations_and_speaker_marks():
    got = clean(">> [MUSIC] The north tower (INAUDIBLE) is burning.")
    assert got == "The north tower is burning."


def test_clean_drops_standalone_filler_only():
    # "um" goes; "umbrella" and "Erman" must survive — a substring match here
    # would quietly corrupt broadcast words.
    got = clean("uh we um saw an umbrella and Erman there")
    assert got == "we saw an umbrella and Erman there"


def test_condense_drops_repeated_sentences_from_overlapping_audio():
    # The stitched channel audio overlaps, so the same clause is transcribed
    # repeatedly across consecutive segments. That repetition is the single
    # biggest source of wasted prompt tokens in raw ASR.
    got = condense([
        "A plane has hit the north tower.",
        "A plane has hit the north tower. We are getting reports of smoke.",
        "We are getting reports of smoke.",
    ])
    assert got == "A plane has hit the north tower. We are getting reports of smoke."


def test_condense_dedupes_ignoring_case_and_punctuation():
    got = condense(["The tower is on fire!", "the tower is on fire"])
    assert got == "The tower is on fire!"


def test_condense_preserves_order_of_first_appearance():
    got = condense(["Second thing happened.", "First thing happened.", "Second thing happened."])
    assert got == "Second thing happened. First thing happened."


def test_condense_truncates_at_a_word_boundary():
    got = condense(["supercalifragilistic reporting from downtown manhattan today"], max_chars=30)
    assert got.endswith("…")
    assert len(got) <= 31
    # Never cut mid-word: a half-word reads as a transcription error rather than
    # a truncation.
    assert "supercalifragilistic" in got
    assert not got.rstrip("…").endswith(("manhatt", "downtow"))


def test_condense_never_paraphrases():
    # The whole justification for extractive condensation: every word in the
    # output must have been broadcast. Guard against anyone swapping in an
    # abstractive summarizer without revisiting the tier-2 contract.
    source = "They are saying it was a small plane."
    got = condense([source])
    assert got == source


def test_build_minutes_buckets_by_start_minute():
    segments = [
        Segment(0.0, 30.0, "First half of the minute."),
        Segment(30.0, 59.0, "Second half of the minute."),
        Segment(65.0, 90.0, "Next minute entirely."),
    ]
    got = build_minutes(segments, ANCHOR)

    assert [s.minute for s in got] == [
        datetime(2001, 9, 11, 12, 40),
        datetime(2001, 9, 11, 12, 41),
    ]
    assert got[0].text == "First half of the minute. Second half of the minute."
    assert got[0].segment_count == 2


def test_build_minutes_files_a_straddling_segment_once():
    # A segment running from 12:40:50 to 12:41:20 belongs to 12:40 only.
    # Counting it in both minutes would let a buddy hear the same sentence
    # twice, a minute apart.
    segments = [Segment(50.0, 80.0, "Straddles the boundary.")]
    got = build_minutes(segments, ANCHOR)
    assert len(got) == 1
    assert got[0].minute == datetime(2001, 9, 11, 12, 40)


def test_build_minutes_drops_a_minute_that_condensed_to_nothing():
    # All annotation, no speech. An empty row would read to the composer as "this
    # station was on air saying nothing", a different claim from "nothing was
    # captured".
    segments = [Segment(0.0, 20.0, "[MUSIC]"), Segment(20.0, 40.0, ">> [INAUDIBLE]")]
    assert build_minutes(segments, ANCHOR) == []


def test_build_minutes_rejects_an_aware_anchor():
    from datetime import timezone

    with pytest.raises(ValueError, match="naive UTC"):
        build_minutes([Segment(0.0, 1.0, "x")], ANCHOR.replace(tzinfo=timezone.utc))


def test_to_minute_rows_carries_provenance():
    # channel/channel_slug/medium are what the streamer filters a buddy's market
    # on. Dropping them here would mean every buddy hears every station.
    rows = to_minute_rows(
        build_minutes([Segment(0.0, 10.0, "On the air.")], ANCHOR),
        channel=7,
        channel_slug="wnbc",
        medium="tv",
    )
    assert rows == [
        {
            "channel": 7,
            "channel_slug": "wnbc",
            "medium": "tv",
            "minute": "2001-09-11T12:40:00",
            "summary": "On the air.",
            "segment_count": 1,
        }
    ]
