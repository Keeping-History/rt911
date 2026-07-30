import pytest

from video_grabber.transcript.minutes import condense
from video_grabber.transcript.summarize import (
    _stem,
    TIER_ABSTRACT,
    TIER_EXTRACT,
    TIER_MECHANICAL,
    build_extract_messages,
    content_words,
    parse_extract,
    summarize_minute,
    units_of,
    validate_abstract,
)

# A minute of genuine early-confusion coverage: the station does NOT yet know it
# was an airliner, and says so. Every fidelity test below turns on that.
SOURCE = (
    "They are saying it was a small plane. "
    "The plane just was coming in low over the building. "
    "We do not know yet how many people were inside."
)
TEXTS = [
    "They are saying it was a small plane.",
    "The plane just was coming in low over the building.",
    "We do not know yet how many people were inside.",
]


def _fallback(texts):
    return condense(texts)


# --- the containment gate -------------------------------------------------

def test_gate_accepts_a_summary_built_from_source_words():
    assert validate_abstract("small plane coming in low over the building", SOURCE) is None


def test_gate_rejects_hindsight_substitution():
    # The failure this whole module exists to prevent: the model knows how the
    # day went and quietly upgrades the station's uncertainty into the
    # afternoon's certainty. "hijacked" and "airliner" are nowhere in the source.
    reason = validate_abstract("A hijacked airliner struck the tower", SOURCE)
    assert reason is not None
    assert "hijack" in reason


def test_gate_rejects_invented_numbers():
    # Number words are deliberately not stopwords. "two planes" where the source
    # said "a small plane" is a fabricated fact that a naive stopword list waves
    # straight through.
    reason = validate_abstract("two planes hit the building", SOURCE)
    assert reason is not None
    assert "two" in reason


def test_gate_rejects_named_entities_the_source_never_named():
    reason = validate_abstract("The plane hit the World Trade Center", SOURCE)
    assert reason is not None
    assert "world" in reason or "trade" in reason or "center" in reason


def test_gate_allows_inflection():
    # "saying"/"say", "building"/"buildings" must not trip the gate; the words
    # still came from the source.
    assert validate_abstract("they say a small plane was coming in low over the buildings", SOURCE) is None


def test_gate_rejects_empty_and_overlong():
    assert validate_abstract("   ", SOURCE) == "empty"
    assert validate_abstract(SOURCE + " " + SOURCE, SOURCE) is not None


def test_content_words_drops_function_words_but_keeps_numbers():
    got = content_words("the two planes were of a kind")
    assert "two" in got and _stem("plane") in got
    assert "the" not in got and "were" not in got


# --- tier 1: verbatim by construction -------------------------------------

def test_extract_returns_only_source_text():
    # The model is asked for indices and the line is rebuilt from the source, so
    # even a model that tries to editorialise cannot get new words in.
    def complete(system, user):
        return '{"keep": [0, 2]}'

    got = summarize_minute(TEXTS, tier=TIER_EXTRACT, complete=complete, fallback=_fallback)
    assert got.method == TIER_EXTRACT
    assert got.text == (
        "They are saying it was a small plane. We do not know yet how many people were inside."
    )
    assert validate_abstract(got.text, SOURCE) is None


def test_extract_ignores_a_model_that_returns_prose_instead_of_indices():
    def complete(system, user):
        return "A hijacked airliner struck the north tower."

    got = summarize_minute(TEXTS, tier=TIER_EXTRACT, complete=complete, fallback=_fallback)
    assert got.method == TIER_MECHANICAL
    assert "hijacked" not in got.text


def test_parse_extract_drops_out_of_range_and_nonsense_indices():
    units = units_of(TEXTS)
    assert parse_extract('{"keep": [0, 99, -1, "x", true, 2]}', units, max_units=3) == [0, 2]


def test_parse_extract_survives_surrounding_chatter():
    units = units_of(TEXTS)
    assert parse_extract('Sure! {"keep": [1]} hope that helps', units, max_units=3) == [1]


def test_extract_caps_how_much_it_keeps():
    def complete(system, user):
        return '{"keep": [0, 1, 2]}'

    got = summarize_minute(TEXTS, tier=TIER_EXTRACT, complete=complete, fallback=_fallback, max_units=1)
    assert got.text == "They are saying it was a small plane."


def test_extract_prompt_numbers_every_unit():
    system, user = build_extract_messages(units_of(TEXTS), max_units=3)
    assert "0: They are saying it was a small plane." in user
    assert "2: We do not know yet" in user
    assert "at most 3" in system


# --- tier 2: rewrite, then gate -------------------------------------------

def test_abstract_accepts_a_contained_rewrite():
    def complete(system, user):
        return "small plane coming in low over the building"

    got = summarize_minute(TEXTS, tier=TIER_ABSTRACT, complete=complete, fallback=_fallback)
    assert got.method == TIER_ABSTRACT
    assert got.rejected is None


def test_abstract_falls_back_when_the_model_adds_hindsight():
    def complete(system, user):
        return "A hijacked airliner has struck the World Trade Center."

    got = summarize_minute(TEXTS, tier=TIER_ABSTRACT, complete=complete, fallback=_fallback)
    assert got.method == TIER_MECHANICAL
    assert got.rejected and "hijack" in got.rejected
    assert "hijacked" not in got.text


# --- failure handling -----------------------------------------------------

def test_a_transport_failure_degrades_rather_than_losing_the_minute():
    # A missing minute reads to the composer as a station that was off the air,
    # which is a different and worse claim than a crudely truncated one.
    def complete(system, user):
        raise RuntimeError("429 rate limited")

    for tier in (TIER_EXTRACT, TIER_ABSTRACT):
        got = summarize_minute(TEXTS, tier=tier, complete=complete, fallback=_fallback)
        assert got.method == TIER_MECHANICAL
        assert got.text
        assert "429" in got.rejected


def test_a_minute_of_pure_annotation_is_reported_empty_not_summarised():
    def complete(system, user):
        raise AssertionError("must not call the model for a minute with no speech")

    got = summarize_minute(["[MUSIC]", ">> (INAUDIBLE)"], tier=TIER_EXTRACT,
                           complete=complete, fallback=_fallback)
    assert got.text == ""
    assert got.rejected == "no speech in minute"


def test_unknown_tier_is_a_programming_error():
    with pytest.raises(ValueError, match="unknown tier"):
        summarize_minute(TEXTS, tier="nope", complete=lambda s, u: "", fallback=_fallback)


def test_a_rejected_abstraction_degrades_to_extraction_not_truncation():
    # A rejected rewrite says nothing about the model's ability to *choose* good
    # lines, and extraction is both safer and measurably better than truncating
    # to the first N characters. Only if extraction also fails is the mechanical
    # line used.
    calls = []

    def complete(system, user):
        calls.append(user)
        # first call is the abstraction (rejected), second is the index request
        return ("A hijacked airliner struck the tower."
                if len(calls) == 1 else '{"keep": [1]}')

    got = summarize_minute(TEXTS, tier=TIER_ABSTRACT, complete=complete, fallback=_fallback)
    assert got.method == TIER_EXTRACT
    assert got.text == "The plane just was coming in low over the building."
    # the rejection reason is preserved so the run can report why it stepped down
    assert got.rejected and "hijack" in got.rejected


def test_possessives_and_doubled_consonants_do_not_cause_false_rejections():
    # Both were real false rejections in the first sample run against production
    # transcripts: "city's" failed to match "city", and "hitting" failed to
    # match "hit".
    source = "the city was hit and the plane was falling"
    assert validate_abstract("the city's plane was hitting and falling", source) is None


def test_quantities_and_hedges_are_never_stopwords():
    # Both invent a fact the broadcast never carried: a number the station did
    # not give, and a certainty level it did not express. Connectives may be
    # introduced freely; these may not.
    src = "the building is on fire and smoke is coming from the upper floors right now"
    for invented in ("many people are in the building",
                     "several people are in the building",
                     "the building is possibly on fire",
                     "the building is reportedly on fire"):
        assert validate_abstract(invented, src) is not None, f"gate let through: {invented}"
    # ...while pure syntax is fine
    assert validate_abstract("because the building is on fire", src) is None
