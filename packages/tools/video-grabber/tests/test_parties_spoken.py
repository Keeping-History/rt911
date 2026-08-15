"""Numbers as the radio says them.

The corpus writes one number three ways — "2-5", "two five", "twenty five" — and
before this a callsign written any of them scored as absent from a transcript
written any other.
"""
import pytest

from video_grabber.parties.identify import _callsign_supported, unsupported_identities
from video_grabber.parties.spoken import digit_candidates, spoken_to_digits
from video_grabber.parties.tags import normalize_callsign


# --- the two readings -----------------------------------------------------

@pytest.mark.parametrize("spoken,expected", [
    # Digit-by-digit: no tens word, so each word is one digit.
    ("niner seven five", "975"),
    ("two five", "25"),
    ("one three four zero zero", "13400"),
    ("seven five", "75"),
    # Natural: a tens or teens word cannot be read digit by digit.
    ("eighty nine", "89"),
    ("ninety three", "93"),
    ("seventeen", "17"),
    ("one thousand two hundred", "1200"),
])
def test_the_reading_is_chosen_by_whether_a_tens_word_is_present(spoken, expected):
    assert spoken_to_digits(spoken) == expected


def test_aviation_pronunciations_are_understood():
    """Controllers say these and the transcriber writes them down verbatim."""
    assert spoken_to_digits("niner fife tree") == "953"


def test_surrounding_words_are_left_alone():
    assert spoken_to_digits("Delta Eighty Nine heavy") == "Delta 89 heavy"


def test_candidates_offer_both_readings():
    both = digit_candidates("eighty nine")
    assert "89" in both.split() and "809" in both.split()


def test_candidates_are_separated_so_a_search_cannot_span_two():
    # "89 975" must not satisfy a search for "897".
    assert "897" not in digit_candidates("eighty nine niner seven five")


# --- what this fixes end to end -------------------------------------------

def test_callsign_spelled_out_by_the_model_matches_a_spelled_out_transcript():
    """The observed failure: the model echoes the audio's phrasing back.

    'Delta Eighty Nine' carries no digits at all, so the digit check rejected it
    outright even though the transcript said exactly that.
    """
    assert _callsign_supported("Delta Eighty Nine", "roger, Delta eighty nine is with you")


def test_callsign_in_digits_matches_a_spelled_out_transcript():
    assert _callsign_supported("United 93", "united ninety three is not responding")
    assert _callsign_supported("AAL 975", "american niner seven five, descend")


def test_callsign_spelled_out_matches_a_digit_transcript():
    assert _callsign_supported("Delta Eighty Nine", "DAL89 checking in")


def test_an_invented_flight_number_is_still_rejected():
    """Widening the readings must not widen what can be invented."""
    assert not _callsign_supported("United 93", "american niner seven five, descend")
    assert not _callsign_supported("Delta Eighty Nine", "delta eighty eight is with you")


def test_a_short_number_does_not_match_a_longer_one_containing_it():
    """Found on the NEADS floor tape, and it predates the spoken-number work.

    That transcript never says 93 — it says "US 9-37". Substring matching
    accepted "United 93" against it. Numbers are matched whole.
    """
    assert not _callsign_supported("United 93", "we have US 9-37 inbound")
    assert not _callsign_supported("American 11", "flight 1180 is climbing")
    assert _callsign_supported("US 937", "we have US 9-37 inbound")


def test_a_long_spoken_readout_does_not_match_every_short_callsign():
    # "twelve hours thirty minutes twenty five seconds" concatenates to a long
    # digit string; it must not vouch for an arbitrary flight number inside it.
    readout = "12 hours, 30 minutes, 25 seconds, 30 minutes, 30 seconds"
    assert not _callsign_supported("Delta 53", readout)


def test_leading_zeros_are_a_spelling_not_a_difference():
    assert _callsign_supported("Gofer 06", "gofer 6, say position")
    assert _callsign_supported("Gofer 6", "gofer zero six, say position")


def test_a_callsign_with_no_number_at_all_is_still_rejected():
    # "a Delta out of Boston" names an airline, not an aircraft.
    assert not _callsign_supported("Delta", "we have a Delta out of Boston")


def test_subject_may_cite_a_number_the_transcript_only_spells_out():
    assert unsupported_identities(
        "Delta 89 is diverting", "roger, delta eighty nine is diverting"
    ) == []


# --- tags -----------------------------------------------------------------

def test_spelled_out_callsign_reaches_the_same_tag_as_the_coded_one():
    assert normalize_callsign("Delta Eighty Nine") == normalize_callsign("DAL89") == "dal89"


def test_spoken_digits_reach_the_same_tag():
    assert normalize_callsign("Niner Seven Five") == "975"
    assert normalize_callsign("United Ninety Three") == "ual93"
