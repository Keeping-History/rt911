"""
Tests for EPG JSON output — validates EPGChannel[] contract from EPG.tsx.
"""
import json
from datetime import datetime, timezone, timedelta, date
from unittest.mock import MagicMock

from video_grabber.epg.assembler import assemble_day


def make_channel():
    ch = MagicMock()
    ch.id = "chan-001"
    ch.slug = "cnn"
    ch.display_name = "CNN"
    return ch


def make_slot(ia_id, starts_at, duration_sec, title="News"):
    prog = MagicMock()
    prog.ia_identifier = ia_id
    prog.title = title
    prog.description = "Desc"
    slot = MagicMock()
    slot.starts_at = starts_at
    slot.ends_at = starts_at + timedelta(seconds=duration_sec)
    slot.program = prog
    return slot


def test_epg_json_has_required_keys():
    ch = make_channel()
    base = datetime(2001, 9, 11, 0, 0, tzinfo=timezone.utc)
    slots = [make_slot("prog-a", base, 86400)]
    _, epg = assemble_day(ch, date(2001, 9, 11), None, slots=slots)

    for key in ("name", "number", "callSign", "location", "icon", "grid"):
        assert key in epg, f"Missing key: {key}"


def test_epg_grid_entries_have_required_fields():
    ch = make_channel()
    base = datetime(2001, 9, 11, 0, 0, tzinfo=timezone.utc)
    slots = [make_slot("prog-a", base, 86400, title="CNN Coverage")]
    _, epg = assemble_day(ch, date(2001, 9, 11), None, slots=slots)

    for entry in epg["grid"]:
        assert "title" in entry
        assert "start" in entry
        assert "end" in entry


def test_epg_start_end_utc_iso8601():
    ch = make_channel()
    base = datetime(2001, 9, 11, 0, 0, tzinfo=timezone.utc)
    slots = [make_slot("prog-a", base, 43200), make_slot("prog-b", base + timedelta(hours=12), 43200)]
    _, epg = assemble_day(ch, date(2001, 9, 11), None, slots=slots)

    for entry in epg["grid"]:
        # Must parse as ISO 8601
        dt = datetime.fromisoformat(entry["start"].replace("Z", "+00:00"))
        assert dt.tzinfo is not None


def test_epg_gap_entry_title():
    ch = make_channel()
    base = datetime(2001, 9, 11, 4, 0, tzinfo=timezone.utc)  # 4h gap at start
    slots = [make_slot("prog-a", base, 82800)]  # 23h program
    _, epg = assemble_day(ch, date(2001, 9, 11), None, slots=slots)

    gap = next(e for e in epg["grid"] if e["title"] == "[No Signal]")
    assert gap is not None


def test_epg_program_has_full_title():
    ch = make_channel()
    base = datetime(2001, 9, 11, 0, 0, tzinfo=timezone.utc)
    slots = [make_slot("cnn-sep11-0800", base, 86400, title="CNN Live Coverage")]
    _, epg = assemble_day(ch, date(2001, 9, 11), None, slots=slots)

    real = next(e for e in epg["grid"] if e["title"] != "[No Signal]")
    assert real["fullTitle"] == "cnn-sep11-0800"


def test_epg_is_json_serializable():
    ch = make_channel()
    base = datetime(2001, 9, 11, 0, 0, tzinfo=timezone.utc)
    slots = [make_slot("prog-a", base, 86400)]
    _, epg = assemble_day(ch, date(2001, 9, 11), None, slots=slots)

    # Must not raise
    serialized = json.dumps(epg)
    assert len(serialized) > 0


def test_epg_call_sign_is_uppercase():
    ch = make_channel()
    base = datetime(2001, 9, 11, 0, 0, tzinfo=timezone.utc)
    slots = [make_slot("prog-a", base, 86400)]
    _, epg = assemble_day(ch, date(2001, 9, 11), None, slots=slots)

    assert epg["callSign"] == "CNN"
