"""The Commission-source join, and the two-document containment gate."""
import pytest

from video_grabber.parties.commission import (
    MIN_SLUG_OVERLAP,
    load_clip_index,
    match_commission_clip,
    slug_overlap,
)
from video_grabber.parties.identify import (
    SOURCE_COMMISSION,
    SOURCE_TRANSCRIPT,
    validate_parties,
)

# Two clips a minute apart on the real morning, catalogued by the Commission with
# very different titles. The stamps are what our filenames carry.
TRANSCRIPT = "Gofer zero six, this is Washington Center, do you have him in sight."
COMMISSION = (
    "093800 Gofer 06 Aircraft is Down\n\n"
    "Colin Scoggins at Boston Center relayed the report to NEADS."
)


# --- the shipped index ----------------------------------------------------

def test_index_loads_and_is_keyed_by_six_digit_stamp():
    index = load_clip_index()
    assert len(index) > 100
    assert all(len(k) == 6 and k.isdigit() for k in index)
    assert all(entry["title"] and entry["source"] for entry in index.values())


def test_index_is_cached_not_reread():
    assert load_clip_index() is load_clip_index()


# --- slug scoring ---------------------------------------------------------

def test_overlap_ignores_flight_numbers_that_match_everything():
    # Nothing but the stopworded callsign in common — not a match on the strength
    # of a token that appears in half the corpus.
    assert slug_overlap("aa77 taxi clearance", "aa77 dulles departure") < MIN_SLUG_OVERLAP


def test_overlap_survives_our_canonical_rename_marker():
    # The timezone fix appended "(canonical)" to renamed objects; it is our
    # bookkeeping, not part of any title, and must not dilute the score.
    plain = slug_overlap("gofer 06 aircraft is down", "Gofer 06 Aircraft is Down")
    marked = slug_overlap("gofer 06 aircraft is down (canonical)", "Gofer 06 Aircraft is Down")
    assert plain == marked == 1.0


# --- matching -------------------------------------------------------------

def test_no_leading_timestamp_never_matches():
    assert match_commission_clip("audio/wcbs/2001-09-11-08-48-00-wcbs.mp3") is None


def test_unknown_timestamp_returns_none():
    assert match_commission_clip("audio/ZNY/999999 nothing here.mp3") is None


def test_same_stamp_different_tape_is_rejected():
    """The reason the slug is scored at all.

    093800 is a real stamp in the index, held by 'Gofer 06 Aircraft is Down'. A
    different recording that happens to share the second must not inherit the
    Commission's description of the first — that would attach a narrative about
    a shootdown report to an unrelated turn instruction.
    """
    index = load_clip_index()
    if "093800" not in index:
        pytest.skip("index no longer carries this stamp")
    assert match_commission_clip("audio/DL1989/093800 d1989 turn right 31.mp3") is None


def test_agreeing_title_matches_and_reports_its_source():
    index = load_clip_index()
    stamp, entry = next(iter(sorted(index.items())))
    key = f"audio/ZNY/{entry['title']}.mp3"
    clip = match_commission_clip(key)
    assert clip is not None
    assert clip.stamp == stamp
    assert clip.overlap == 1.0
    assert clip.title in clip.text


# --- the two-document gate ------------------------------------------------

def _parties(**over):
    """A well-formed answer, so each test's own defect is the only one in play."""
    base = {
        "tier": "clip",
        "participants": [],
        "link": "landline",
        "aircraft": [],
        "mentions": {"facilities": [], "aircraft": [], "people": []},
        "subject": None,
        "topics": [],
        "confidence": "high",
        "evidence": "Gofer zero six, this is Washington Center",
        "sources": {"evidence": SOURCE_TRANSCRIPT},
    }
    base.update(over)
    base.setdefault("sources", {}).setdefault("evidence", SOURCE_TRANSCRIPT)
    return base


def _reason(reasons, needle):
    """Assert some reason mentions `needle`, without pinning their order."""
    assert any(needle in r for r in reasons), reasons


def test_commission_sourced_name_survives_though_absent_from_transcript():
    """The whole point of consulting a second document.

    'Colin Scoggins' is nowhere in the audio. Held to the transcript alone he is
    correctly destroyed; here he is admissible because the Commission names him
    and the answer says that is where he came from.
    """
    cleaned, reasons = validate_parties(
        _parties(participants=[{
            "facility": "NEADS", "position": None, "person": "Colin Scoggins",
            "role": "military", "confidence": "high", "source": SOURCE_COMMISSION,
        }]),
        TRANSCRIPT,
        COMMISSION,
    )
    assert cleaned["participants"][0]["person"] == "Colin Scoggins"
    assert cleaned["participants"][0]["source"] == SOURCE_COMMISSION
    assert reasons == []


def test_a_name_in_neither_document_is_still_destroyed():
    cleaned, reasons = validate_parties(
        _parties(participants=[{
            "facility": "Cleveland Center", "position": None, "person": None,
            "role": "atc", "confidence": "high", "source": SOURCE_COMMISSION,
        }]),
        TRANSCRIPT,
        COMMISSION,
    )
    assert cleaned["participants"] == []
    _reason(reasons, "commission_monograph never contains")


def test_claiming_the_transcript_for_a_commission_only_name_fails():
    """Provenance is checked, not merely recorded.

    A model that mislabels where a value came from must not get it through — the
    label decides which document the value is held against.
    """
    cleaned, _ = validate_parties(
        _parties(participants=[{
            "facility": None, "position": None, "person": "Colin Scoggins",
            "role": "military", "confidence": "high", "source": SOURCE_TRANSCRIPT,
        }]),
        TRANSCRIPT,
        COMMISSION,
    )
    assert cleaned["participants"] == []


def test_undeclared_source_is_held_to_the_transcript():
    """Fail-closed. Saying nothing must not reach the looser document."""
    cleaned, reasons = validate_parties(
        _parties(participants=[{
            "facility": "NEADS", "position": None, "person": None,
            "role": "military", "confidence": "high",
        }]),
        TRANSCRIPT,
        COMMISSION,
    )
    assert cleaned["participants"] == []
    _reason(reasons, "transcript never contains")


def test_unknown_source_name_is_rejected_not_trusted():
    cleaned, reasons = validate_parties(
        _parties(participants=[{
            "facility": "NEADS", "position": None, "person": None,
            "role": "military", "confidence": "high", "source": "my_own_knowledge",
        }]),
        TRANSCRIPT,
        COMMISSION,
    )
    assert cleaned["participants"] == []
    _reason(reasons, "unknown source")


def test_evidence_may_quote_the_commission_when_it_says_so():
    quote = "Colin Scoggins at Boston Center relayed the report to NEADS."
    cleaned, reasons = validate_parties(
        _parties(evidence=quote, sources={"evidence": SOURCE_COMMISSION}),
        TRANSCRIPT,
        COMMISSION,
    )
    assert cleaned["evidence"] == quote
    assert reasons == []


def test_surviving_sources_map_is_rebuilt_from_what_passed():
    """The stored map must describe the stored values, not the model's claims."""
    cleaned, _ = validate_parties(
        _parties(aircraft=["Gofer 06"], sources={"aircraft": SOURCE_COMMISSION}),
        TRANSCRIPT,
        COMMISSION,
    )
    assert cleaned["sources"] == {
        "evidence": SOURCE_TRANSCRIPT,
        "aircraft": SOURCE_COMMISSION,
    }


def test_with_no_commission_text_the_gate_reduces_to_transcript_only():
    """The single-document case is the degenerate case, not a separate path."""
    cleaned, reasons = validate_parties(
        _parties(participants=[{
            "facility": "NEADS", "position": None, "person": None,
            "role": "military", "confidence": "high", "source": SOURCE_COMMISSION,
        }]),
        TRANSCRIPT,
    )
    assert cleaned["participants"] == []
    assert reasons
