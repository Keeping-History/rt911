"""The single redaction point: what is allowed to leave the private blob.

`mp3_items.parties` is private and stays private — it carries the QA signals
(`gate_reasons`, `model`) that say how much to trust a row, which is an internal
judgement, not something to publish. The public columns are a projection of it,
and this function is the only place that projection happens. The Go and
TypeScript types downstream have no field for a redacted value, so a leak here
is not caught later; it is simply published.

So these tests are about absence as much as presence. Several of them feed the
projection a key nobody has ever written, because the failure they guard is not
"today's blob leaks" but "tomorrow's producer adds a field and it leaks".
"""
import json

from video_grabber.parties.public_meta import REDACTED, build_public_meta

# The shape `identify_parties_flow` actually stores: schema-2 output from
# `validate_parties`, plus the four keys the flow stamps on afterwards
# (`model`, `generated_at`, `commission`, `gate_reasons`).
PARTIES = {
    "schema_version": 2,
    "tier": "clip",
    "link": "landline",
    "confidence": "high",
    "subject": "Boston Center tells New York Center that American 11 is not responding",
    "evidence": "American 11 is not responding",
    "participants": [
        {"facility": "Boston Center", "position": "AA sector", "person": "Joe Cooper",
         "role": "atc", "confidence": "high", "source": "transcript"},
        {"facility": "New York Center", "position": None, "person": None,
         "role": "atc", "confidence": "medium", "source": "commission_monograph"},
    ],
    "aircraft": ["American 11"],
    "mentions": {
        "facilities": ["NEADS"], "aircraft": ["UAL175"], "people": ["Ben Sliney"],
    },
    "topics": ["hijack-report"],
    "sources": {
        "subject": "transcript",
        "evidence": "transcript",
        "aircraft": "transcript",
        "mentions.people": "commission_monograph",
    },
    "generated_at": "2026-08-13T10:00:00+00:00",
    "model": "claude-sonnet-5",
    "commission": {
        "title": "Boston Center / New York Center landline",
        "source": "Team 8 audio monograph",
        "stamp": "09:16:00",
        "slug_overlap": 0.83,
    },
    "gate_reasons": ["subject names ['Cleveland'] which the transcript never contains"],
}


def _keys_anywhere(value) -> set[str]:
    """Every mapping key in a nested structure, at any depth."""
    if isinstance(value, dict):
        found = set(value)
        for child in value.values():
            found |= _keys_anywhere(child)
        return found
    if isinstance(value, list):
        found = set()
        for child in value:
            found |= _keys_anywhere(child)
        return found
    return set()


# --- what is published ----------------------------------------------------

def test_the_flat_fields_are_copied():
    meta = build_public_meta(PARTIES)
    assert meta["subject"] == PARTIES["subject"]
    assert meta["link"] == "landline"
    assert meta["tier"] == "clip"
    assert meta["confidence"] == "high"
    assert meta["evidence"] == "American 11 is not responding"


def test_participants_are_projected_to_the_five_public_fields():
    """Exactly five keys, whatever else the entry happens to carry.

    `source` rides on every stored participant and is not published — a
    per-field provenance label is an internal working note, and a projection
    that copied the entry wholesale would ship it.
    """
    meta = build_public_meta(PARTIES)
    assert [set(p) for p in meta["participants"]] == [
        {"person", "facility", "position", "role", "confidence"}
    ] * 2
    assert meta["participants"][0] == {
        "person": "Joe Cooper", "facility": "Boston Center", "position": "AA sector",
        "role": "atc", "confidence": "high",
    }


def test_mentions_are_copied_for_all_three_kinds():
    assert build_public_meta(PARTIES)["mentions"] == {
        "facilities": ["NEADS"], "aircraft": ["UAL175"], "people": ["Ben Sliney"],
    }


def test_a_missing_mentions_kind_becomes_an_empty_list():
    """The card renders three lists. A missing key is an absent section; a
    `None` is a crash in whichever of the two languages reads it first."""
    meta = build_public_meta({**PARTIES, "mentions": {"facilities": ["NEADS"]}})
    assert meta["mentions"] == {"facilities": ["NEADS"], "aircraft": [], "people": []}


def test_provenance_carries_the_three_things_a_reader_can_check():
    prov = build_public_meta(PARTIES)["provenance"]
    assert prov["generated_at"] == "2026-08-13T10:00:00+00:00"
    assert prov["sources"]["subject"] == "transcript"
    assert prov["commission"] == {
        "title": "Boston Center / New York Center landline",
        "source": "Team 8 audio monograph",
        "stamp": "09:16:00",
    }


def test_a_recording_the_commission_never_catalogued_has_no_commission_block():
    without = {k: v for k, v in PARTIES.items() if k != "commission"}
    assert build_public_meta(without)["provenance"]["commission"] is None


# --- what is not published ------------------------------------------------

def test_the_redacted_qa_signals_never_appear_anywhere_in_the_output():
    """`gate_reasons` and `model` are how we decide whether to trust a row.

    Nothing downstream can catch these: the Go and TypeScript types have no
    field to put them in, so a leak is published rather than rejected.
    """
    meta = build_public_meta(PARTIES)
    assert not (REDACTED & _keys_anywhere(meta))
    dumped = json.dumps(meta)
    assert "gate_reasons" not in dumped
    assert PARTIES["model"] not in dumped
    assert "Cleveland" not in dumped   # the gate reason's text, not just its key


def test_provenance_drops_a_source_path_for_a_field_that_is_not_published():
    """`sources` is keyed by field path, and it holds paths for fields the
    public columns do not carry — `aircraft` among them. Publishing a
    provenance entry for a value nobody can see says where something came from
    without saying what it was."""
    assert "aircraft" not in build_public_meta(PARTIES)["provenance"]["sources"]


def test_the_commission_match_score_stays_internal():
    """`slug_overlap` is how confident the filename match was — a pipeline
    diagnostic, not a fact about the recording."""
    prov = build_public_meta(PARTIES)["provenance"]
    assert "slug_overlap" not in prov["commission"]


def test_a_key_no_producer_has_written_yet_is_not_published():
    """The reason the projection is closed rather than filtered.

    A deny-list only ever knows about the fields that existed when it was
    written. `identify_parties_flow` already stamps four keys onto the
    validator's output, and the next thing added there would be published by
    default under any passthrough — at top level, and equally in the two nested
    blocks the projection reaches into.
    """
    leaky = {
        **PARTIES,
        "reviewer_note": "recheck this one",
        "commission": {**PARTIES["commission"], "internal_score": 0.4},
        "sources": {**PARTIES["sources"], "reviewer_note": "transcript"},
    }
    meta = build_public_meta(leaky)
    assert "reviewer_note" not in _keys_anywhere(meta)
    assert "internal_score" not in _keys_anywhere(meta)
    assert "recheck this one" not in json.dumps(meta)


# --- rows with nothing to say ---------------------------------------------

def test_a_row_with_no_parties_yields_empty_fields_rather_than_an_error():
    """59 of the 814 recordings carry no `parties` at all — broadcasts, and
    rows the gate could not identify. They still need a row written: the card
    has to be able to say "nothing is known about this" definitely, and a
    re-derivation has to be able to clear a projection that is no longer
    supported."""
    for empty in (None, {}):
        meta = build_public_meta(empty)
        assert meta["subject"] is None
        assert meta["link"] is None
        assert meta["tier"] is None
        assert meta["confidence"] is None
        assert meta["evidence"] is None
        assert meta["participants"] == []
        assert meta["mentions"] == {"facilities": [], "aircraft": [], "people": []}
        assert meta["provenance"] == {
            "generated_at": None, "sources": {}, "commission": None,
        }


def test_every_row_gets_the_same_set_of_columns():
    """A partly-populated projection would leave whichever columns the row had
    nothing to say about holding whatever was there before."""
    assert set(build_public_meta(None)) == set(build_public_meta(PARTIES))


# --- shapes the validator never produces but the database might hold -------

def test_a_participant_that_is_not_an_object_is_dropped():
    """This runs over the whole corpus unattended; one malformed row must not
    end the pass."""
    meta = build_public_meta({**PARTIES, "participants": ["Boston Center", None]})
    assert meta["participants"] == []


def test_a_wrongly_typed_nested_block_is_treated_as_absent():
    meta = build_public_meta(
        {**PARTIES, "mentions": [], "sources": ["transcript"], "commission": "yes"}
    )
    assert meta["mentions"] == {"facilities": [], "aircraft": [], "people": []}
    assert meta["provenance"]["sources"] == {}
    assert meta["provenance"]["commission"] is None


def test_the_projection_does_not_reach_back_into_the_stored_blob():
    """The public lists must not alias the private ones — appending to a
    published list would otherwise edit the record it was derived from."""
    original = json.loads(json.dumps(PARTIES))
    meta = build_public_meta(PARTIES)
    meta["mentions"]["facilities"].append("Cleveland Center")
    meta["participants"][0]["person"] = "somebody else"
    assert PARTIES == original
