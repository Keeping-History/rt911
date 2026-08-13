import pytest

from video_grabber.parties.identify import (
    BROADCAST,
    CONVERSATION,
    TIER_CLIP,
    TIER_TAPE,
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


# --- the containment gate -------------------------------------------------

GOOD = {
    "tier": "clip",
    "side_a": {"facility": "Indianapolis Center", "position": None, "person": None,
               "role": "atc"},
    "side_b": {"facility": "American", "position": "dispatch", "person": "Jim McDonald",
               "role": "airline"},
    "link": "landline", "aircraft": ["AAL77"], "confidence": "high",
    "evidence": "This is Indianapolis Center, trying to get a hold of American 77",
}


def test_gate_accepts_names_the_transcript_contains():
    cleaned, reasons = validate_parties(GOOD, TRANSCRIPT)
    assert reasons == []
    assert cleaned["confidence"] == "high"
    assert cleaned["side_b"]["person"] == "Jim McDonald"


def test_gate_drops_a_facility_the_transcript_never_names():
    # The failure this exists to prevent: the model knows 9/11 and supplies
    # NEADS from memory rather than from the audio.
    bad = {**GOOD, "side_a": {"facility": "NEADS", "position": None, "person": None,
                              "role": "military"}}
    cleaned, reasons = validate_parties(bad, TRANSCRIPT)
    assert cleaned["side_a"]["facility"] is None
    assert cleaned["confidence"] == "low"
    assert any("neads" in r.lower() for r in reasons)


def test_gate_drops_an_invented_person():
    bad = {**GOOD, "side_b": {"facility": "American", "position": "dispatch",
                              "person": "Colin Scoggins", "role": "airline"}}
    cleaned, reasons = validate_parties(bad, TRANSCRIPT)
    assert cleaned["side_b"]["person"] is None
    assert cleaned["confidence"] == "low"


def test_gate_rejects_evidence_that_is_not_verbatim():
    bad = {**GOOD, "evidence": "Indianapolis Center said they lost the aircraft"}
    cleaned, reasons = validate_parties(bad, TRANSCRIPT)
    assert cleaned["confidence"] == "low"
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


def test_gate_leaves_various_alone_on_tape_tier():
    tape = {**GOOD, "tier": "tape",
            "side_b": {"facility": "various", "position": None, "person": None,
                       "role": None}}
    cleaned, reasons = validate_parties(tape, TRANSCRIPT)
    assert cleaned["side_b"]["facility"] == "various"
    assert reasons == []


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
