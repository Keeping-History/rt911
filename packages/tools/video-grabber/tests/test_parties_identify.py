import pytest

from video_grabber.parties.identify import (
    BROADCAST,
    CONVERSATION,
    SCHEMA_VERSION,
    SOURCE_TRANSCRIPT,
    TIER_CLIP,
    TIER_TAPE,
    build_messages,
    media_kind,
    parse_parties,
    should_identify,
    tier_for,
    validate_parties,
)

TRANSCRIPT = (
    "American dispatch, Jim McDonald. This is Indianapolis Center, "
    "trying to get a hold of American 77."
)


# --- the allow-list -------------------------------------------------------

def test_wins_is_broadcast_and_never_identified():
    assert media_kind("audio/wins1010/2001-09-11_1010_WINS_NEWS_10_AM.mp3") == BROADCAST
    assert should_identify("audio/wins1010/2001-09-11_1010_WINS_NEWS_10_AM.mp3") is False


def test_wcbs_is_broadcast_and_never_identified():
    assert media_kind("audio/wcbs/2001-09-11-08-48-00-wcbs.mp3") == BROADCAST
    assert should_identify("audio/wcbs/2001-09-11-08-48-00-wcbs.mp3") is False


def test_atc_folders_are_conversation():
    assert media_kind("audio/AA77/0812 aa77 taxi.mp3") == CONVERSATION
    assert should_identify("audio/AA77/0812 aa77 taxi.mp3") is True


def test_unknown_folder_is_skipped_not_identified():
    # Fail-closed: a folder nobody classified must not be identified by default.
    assert media_kind("audio/brand_new_collection/x.mp3") is None
    assert should_identify("audio/brand_new_collection/x.mp3") is False


def test_allow_list_is_not_a_deny_list():
    # Mutation guard. If someone rewrites should_identify as
    # `media_kind(key) != BROADCAST`, this turns red.
    assert should_identify("audio/unclassified/x.mp3") is False


def test_key_outside_audio_is_not_identified():
    assert media_kind("subtitles/audio/AA77/x.srt") is None


# --- tiering --------------------------------------------------------------

def test_short_clip_is_a_clip():
    assert tier_for(43) == TIER_CLIP


def test_long_tape_is_a_tape():
    assert tier_for(24300) == TIER_TAPE


def test_missing_duration_raises_rather_than_defaulting():
    # Defaulting to clip would push a 6.75h transcript through the clip prompt.
    with pytest.raises(ValueError, match="duration"):
        tier_for(None)


# --- prompt shape ---------------------------------------------------------

def test_topics_vocabulary_is_in_the_prompt():
    """The closed list only works if the model is shown it."""
    system, _ = build_messages("x", TIER_CLIP)
    assert "hijack-report" in system and "shootdown-authority" in system


def test_second_document_only_described_when_supplied():
    bare, user = build_messages("x", TIER_CLIP)
    assert "COMMISSION" not in bare and "COMMISSION" not in user
    with_doc, user2 = build_messages("x", TIER_CLIP, "093800 Gofer 06")
    assert "COMMISSION" in with_doc and "COMMISSION" in user2


def test_prompt_forbids_expanding_a_name_the_document_abbreviates():
    """The commonest gate hit in the first live batch, and a prompt problem.

    The model expanded a transcript's "Boston" to "Boston Center" — correct as
    fact, but added knowledge, so the gate dropped the whole facility when
    "Boston" would have survived.
    """
    system, _ = build_messages("x", TIER_CLIP)
    assert "EXACTLY as the document words it" in system
    assert "Boston Center" in system


def test_tape_tier_is_told_not_to_invent_a_placeholder():
    system, _ = build_messages("x", TIER_TAPE)
    assert "do not invent a placeholder" in system


# --- the containment gate -------------------------------------------------

GOOD = {
    "tier": "clip",
    "participants": [
        {"facility": "Indianapolis Center", "position": None, "person": None,
         "role": "atc", "confidence": "high"},
        {"facility": "American", "position": "dispatch", "person": "Jim McDonald",
         "role": "airline", "confidence": "high"},
    ],
    "link": "landline",
    "aircraft": ["AAL77"],
    "mentions": {"facilities": [], "aircraft": [], "people": []},
    "subject": "Indianapolis Center trying to get a hold of American 77",
    "topics": ["loss-of-contact"],
    "confidence": "high",
    "evidence": "This is Indianapolis Center, trying to get a hold of American 77",
}


def test_gate_accepts_names_the_transcript_contains():
    cleaned, reasons = validate_parties(GOOD, TRANSCRIPT)
    assert reasons == []
    assert cleaned["confidence"] == "high"
    assert cleaned["schema_version"] == SCHEMA_VERSION
    assert [p["person"] for p in cleaned["participants"]] == [None, "Jim McDonald"]


def test_gate_drops_a_facility_the_transcript_never_names():
    # The failure this exists to prevent: the model knows 9/11 and supplies
    # NEADS from memory rather than from the audio.
    bad = {**GOOD, "participants": [
        {"facility": "NEADS", "position": None, "person": None,
         "role": "military", "confidence": "high"},
        GOOD["participants"][1],
    ]}
    cleaned, reasons = validate_parties(bad, TRANSCRIPT)
    # The NEADS entry names nobody once its invented facility is stripped, so it
    # is dropped rather than left as a contentless role.
    assert [p["facility"] for p in cleaned["participants"]] == ["American"]
    assert any("neads" in r.lower() for r in reasons)


def test_gate_drops_an_invented_person():
    bad = {**GOOD, "participants": [
        {"facility": "American", "position": "dispatch", "person": "Colin Scoggins",
         "role": "airline", "confidence": "high"},
    ]}
    cleaned, reasons = validate_parties(bad, TRANSCRIPT)
    assert cleaned["participants"][0]["person"] is None
    assert cleaned["participants"][0]["facility"] == "American"
    assert any("scoggins" in r.lower() for r in reasons)


def test_a_gate_hit_caps_confidence_at_medium_rather_than_crushing_it():
    """Schema 1 forced 'low' on any rejection, which lost real information.

    189 rows were downgraded that way and became indistinguishable from the 357
    the model itself could not read. A trimmed answer may not claim certainty,
    but what survived is still worth grading.
    """
    bad = {**GOOD, "aircraft": ["AAL77", "UAL93"]}
    cleaned, reasons = validate_parties(bad, TRANSCRIPT)
    assert reasons
    assert cleaned["confidence"] == "medium"


def test_per_participant_confidence_survives_independently():
    mixed = {**GOOD, "participants": [
        {**GOOD["participants"][0], "confidence": "high"},
        {**GOOD["participants"][1], "confidence": "low"},
    ]}
    cleaned, _ = validate_parties(mixed, TRANSCRIPT)
    assert [p["confidence"] for p in cleaned["participants"]] == ["high", "low"]


def test_gate_rejects_evidence_that_is_not_verbatim():
    bad = {**GOOD, "evidence": "Indianapolis Center said they lost the aircraft"}
    cleaned, reasons = validate_parties(bad, TRANSCRIPT)
    assert cleaned["evidence"] is None
    assert any("verbatim" in r for r in reasons)


def test_gate_tolerates_whitespace_and_case_in_evidence():
    ok = {**GOOD, "evidence": "  this IS indianapolis   center  "}
    _, reasons = validate_parties(ok, TRANSCRIPT)
    assert reasons == []


def test_gate_accepts_a_callsign_whose_number_is_in_the_transcript():
    # 'AAL77' is a normalisation of 'American 77', not a quotation, so the gate
    # checks the numeric part rather than the literal token.
    cleaned, reasons = validate_parties(GOOD, TRANSCRIPT)
    assert cleaned["aircraft"] == ["AAL77"]
    assert reasons == []


def test_gate_drops_a_callsign_the_transcript_never_mentions():
    bad = {**GOOD, "aircraft": ["AAL77", "UAL93"]}
    cleaned, reasons = validate_parties(bad, TRANSCRIPT)
    assert cleaned["aircraft"] == ["AAL77"]
    assert any("93" in r for r in reasons)


def test_various_is_no_longer_an_accepted_answer():
    """Schema 1 needed the placeholder; schema 2 has participants instead.

    Letting it through would put `facility:various` into the tag index as though
    it were a real facility.
    """
    tape = {**GOOD, "tier": "tape", "participants": [
        {"facility": "various", "position": None, "person": None,
         "role": "unknown", "confidence": "low"},
    ]}
    cleaned, _ = validate_parties(tape, TRANSCRIPT)
    assert cleaned["participants"] == []


# --- the new fields -------------------------------------------------------

def test_subject_may_not_name_a_facility_the_source_never_had():
    bad = {**GOOD, "subject": "Cleveland Center reports a hijacking in progress"}
    cleaned, reasons = validate_parties(bad, TRANSCRIPT)
    assert cleaned["subject"] is None
    assert any("subject names" in r for r in reasons)


def test_subject_may_use_ordinary_words_the_source_lacks():
    """The rule that shipped first rejected every subject in the corpus.

    Whole-phrase containment works for a minute summary drawn from a long
    source; against a two-sentence transcript it flags "reports" and "routine"
    as inventions. Only names and numbers are policed now.
    """
    ok = {**GOOD, "subject": "Indianapolis Center is trying to reach American 77"}
    cleaned, reasons = validate_parties(ok, TRANSCRIPT)
    assert cleaned["subject"] == ok["subject"]
    assert reasons == []


def test_subject_survives_when_built_from_source_words():
    cleaned, reasons = validate_parties(GOOD, TRANSCRIPT)
    assert cleaned["subject"] == GOOD["subject"]
    assert cleaned["sources"]["subject"] == SOURCE_TRANSCRIPT
    assert reasons == []


def test_subject_may_not_invent_a_flight_number():
    bad = {**GOOD, "subject": "Indianapolis Center is trying to reach American 93"}
    cleaned, reasons = validate_parties(bad, TRANSCRIPT)
    assert cleaned["subject"] is None
    assert any("93" in r for r in reasons)


# --- spoken digits --------------------------------------------------------

SPOKEN = "Quit 2-5, contact Washington Center 1-3-4-0-0."


def test_callsign_matches_a_transcript_that_spells_the_number_out():
    """Controllers read numbers digit by digit and the transcriber follows.

    'Quit 2-5' is right there in the audio, but a callsign normalised to
    'Quit 25' looked absent — which is why `aircraft` sat at 54% fill.
    """
    ok = {**GOOD, "aircraft": ["Quit 25"], "evidence": "Quit 2-5, contact Washington Center",
          "subject": None, "participants": []}
    cleaned, reasons = validate_parties(ok, SPOKEN)
    assert cleaned["aircraft"] == ["Quit 25"]
    assert reasons == []


def test_spoken_digit_joining_does_not_merge_separate_numbers():
    """'190, 230' are two altitudes, not the number 190230."""
    bad = {**GOOD, "aircraft": ["Flight 190230"], "evidence": "passing through 190, 230",
           "subject": None, "participants": []}
    cleaned, reasons = validate_parties(bad, "Philadelphia passing through 190, 230.")
    assert cleaned["aircraft"] == []
    assert reasons


def test_topic_outside_the_vocabulary_is_dropped():
    bad = {**GOOD, "topics": ["loss-of-contact", "everyone-is-worried"]}
    cleaned, reasons = validate_parties(bad, TRANSCRIPT)
    assert cleaned["topics"] == ["loss-of-contact"]
    assert any("controlled vocabulary" in r for r in reasons)


def test_mentioned_people_are_gated_like_participants():
    bad = {**GOOD, "mentions": {"facilities": ["NEADS"], "aircraft": [], "people": []}}
    cleaned, reasons = validate_parties(bad, TRANSCRIPT)
    assert cleaned["mentions"]["facilities"] == []
    assert any("neads" in r.lower() for r in reasons)


def test_mentions_are_kept_separate_from_participants():
    ok = {**GOOD, "mentions": {"facilities": [], "aircraft": ["AAL77"], "people": []}}
    cleaned, _ = validate_parties(ok, TRANSCRIPT)
    assert cleaned["mentions"]["aircraft"] == ["AAL77"]
    assert all(p["facility"] != "AAL77" for p in cleaned["participants"])


def test_unknown_link_value_falls_back_rather_than_persisting():
    bad = {**GOOD, "link": "carrier-pigeon"}
    cleaned, _ = validate_parties(bad, TRANSCRIPT)
    assert cleaned["link"] == "unknown"


def test_unknown_role_falls_back_to_unknown():
    bad = {**GOOD, "participants": [
        {**GOOD["participants"][0], "role": "wizard"},
    ]}
    cleaned, _ = validate_parties(bad, TRANSCRIPT)
    assert cleaned["participants"][0]["role"] == "unknown"


# --- parsing --------------------------------------------------------------

def test_parse_accepts_a_fenced_json_block():
    raw = '```json\n{"tier":"clip","confidence":"high"}\n```'
    assert parse_parties(raw)["tier"] == "clip"


def test_parse_accepts_bare_json():
    assert parse_parties('{"tier":"clip"}')["tier"] == "clip"


def test_parse_rejects_non_json():
    with pytest.raises(ValueError):
        parse_parties("I could not determine the parties.")


def test_parse_rejects_a_json_array():
    with pytest.raises(ValueError, match="not an object"):
        parse_parties("[1, 2, 3]")


@pytest.mark.parametrize("raw", ["", "   \n ", None])
def test_parse_blames_the_token_budget_for_an_empty_reply(raw):
    """An empty reply means max_tokens went entirely on thinking, not a bad prompt.

    claude-sonnet-5 thinks by default when `thinking` is unset, and max_tokens caps
    thinking and text together — so the response is a lone thinking block with no
    text. Reporting that as malformed JSON sends the next reader to the prompt.
    """
    with pytest.raises(ValueError, match="no text"):
        parse_parties(raw)
