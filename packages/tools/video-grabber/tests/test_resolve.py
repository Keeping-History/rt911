"""Tests for the resolve stage (bare job -> linked channel + program).

Pure-helper tests need no DB. resolve_job is exercised against a mocked
SQLAlchemy connection so no Postgres is required.
"""
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from video_grabber.pipeline import resolve
from video_grabber.pipeline.resolve import (
    _air_date,
    _air_date_from_identifier,
    _program_title,
    _timezone_abbr,
    resolve_job,
)

WETA_META = {
    "title": "American Public Education : WETA : September 9, 2001 8:00pm-10:00pm EDT",
    "date": "2001-09-10T00:00:00Z",
    "subject": ["American Public Education", "Television Program"],
    "description": "A documentary.",
    "creator": "",
}


def test_air_date_from_identifier_is_authoritative_utc():
    """The identifier timestamp is UTC and wins over everything else."""
    meta = {
        "identifier": "WETA_20010915_163000_Victory_Garden",
        "title": "Victory Garden : WETA : September 15, 2001 12:30pm-12:59pm EDT",
        "date": "2001-09-15T00:00:00Z",  # misleading: midnight, not air time
    }
    assert _air_date(meta) == datetime(2001, 9, 15, 16, 30, tzinfo=timezone.utc)


def test_air_date_bbc_identifier_beats_misparsed_title():
    """Regression: BBC titles carry BST, but the tz sits after the *end* time of
    the range so extract_air_date_utc misses it and defaults to EDT (5h wrong).
    The identifier (21:00 UTC == 10:00pm BST) must win."""
    meta = {
        "identifier": "BBC_20010910_210000_BBC_World_News",
        "title": "BBC World News : BBC : September 10, 2001 10:00pm-10:30pm BST",
    }
    assert _air_date(meta) == datetime(2001, 9, 10, 21, 0, tzinfo=timezone.utc)


def test_air_date_falls_back_to_title_without_identifier_timestamp():
    """IDs with no embedded timestamp fall through to the title (EDT default)."""
    meta = {
        "identifier": "cnn-sep11-morning",  # no _YYYYMMDD_HHMMSS_ timestamp
        "title": "CNN Live : CNN : September 11, 2001 9:00am EDT",
    }
    # 9:00am EDT == 13:00 UTC
    assert _air_date(meta) == datetime(2001, 9, 11, 13, 0, tzinfo=timezone.utc)


def test_air_date_falls_back_to_date_field_last():
    """When neither identifier nor title yield a time, the calendar-day `date`
    field is the last resort (midnight UTC)."""
    meta = {"identifier": "no-ts", "title": "Untitled", "date": "2001-09-11T00:00:00Z"}
    assert _air_date(meta) == datetime(2001, 9, 11, 0, 0, tzinfo=timezone.utc)


def test_air_date_from_identifier_helper():
    assert _air_date_from_identifier("WETA_20010915_163000_Victory_Garden") == (
        datetime(2001, 9, 15, 16, 30, tzinfo=timezone.utc)
    )
    assert _air_date_from_identifier("abc200109110954-1036") is None


def test_air_date_raises_when_undeterminable():
    with pytest.raises(ValueError):
        _air_date({"title": "no date anywhere", "identifier": "no-timestamp"})


def test_program_title_uses_subject_first():
    assert _program_title(WETA_META) == "American Public Education"


def test_program_title_falls_back_to_title_prefix():
    meta = {"title": "No Greater Calling : WETA : September 9, 2001 10:00pm-11:00pm EDT"}
    assert _program_title(meta) == "No Greater Calling"


def test_program_title_default_when_empty():
    assert _program_title({}) == "Untitled"


def test_timezone_abbr_from_title():
    assert _timezone_abbr(WETA_META) == "EDT"


def test_timezone_abbr_defaults_to_edt():
    assert _timezone_abbr({"title": "no tz here"}) == "EDT"


def _mock_db(*, existing_program_id=None):
    """A db whose execute() returns the right scalar per statement order:
    INSERT channel -> SELECT program -> (INSERT program) -> UPDATE job.
    """
    db = MagicMock()
    results = []

    chan = MagicMock()
    chan.scalar_one.return_value = "chan-uuid"
    results.append(chan)

    sel = MagicMock()
    sel.scalar.return_value = existing_program_id
    results.append(sel)

    if existing_program_id is None:
        prog = MagicMock()
        prog.scalar_one.return_value = "prog-uuid"
        results.append(prog)  # INSERT program ... RETURNING id
    else:
        results.append(MagicMock())  # UPDATE programs

    results.append(MagicMock())  # UPDATE video_jobs

    db.execute.side_effect = results
    return db


def make_job():
    return SimpleNamespace(
        id="job-uuid",
        ia_identifier="WETA_20010910_000000_American_Public_Education",
        ia_metadata=WETA_META,
        channel=SimpleNamespace(slug=None, display_name=None, timezone=None),
        program=SimpleNamespace(
            title=None, description=None, air_date=None, duration_seconds=None
        ),
        channel_id=None,
        program_id=None,
    )


def test_resolve_job_links_channel_and_program():
    job = make_job()
    db = _mock_db()

    out = resolve_job(job, db, media_path=None)

    assert out.channel_id == "chan-uuid"
    assert out.program_id == "prog-uuid"
    assert out.channel.slug == "weta"
    assert out.channel.display_name == "WETA"  # call-sign -> upper-cased slug
    assert out.program.title == "American Public Education"
    assert out.program.air_date == datetime(2001, 9, 10, 0, 0, tzinfo=timezone.utc)
    assert out.program.duration_seconds == 0  # no media_path -> probe skipped
    db.commit.assert_called_once()


def test_resolve_job_updates_existing_program():
    """Re-running on a job whose program already exists must not double-insert."""
    job = make_job()
    db = _mock_db(existing_program_id="prog-existing")

    out = resolve_job(job, db, media_path=None)

    assert out.program_id == "prog-existing"
    # statements: INSERT channel, SELECT program, UPDATE program, UPDATE job
    assert db.execute.call_count == 4
    db.commit.assert_called_once()


def test_resolve_job_probes_duration_when_media_present(monkeypatch):
    job = make_job()
    db = _mock_db()
    monkeypatch.setattr(resolve, "probe_duration_seconds", lambda p: 1798)

    out = resolve_job(job, db, media_path="/tmp/whatever.mpg")

    assert out.program.duration_seconds == 1798


def test_resolve_job_raises_without_slug():
    job = make_job()
    job.ia_metadata = {"title": "completely unrecognizable network"}
    with pytest.raises(ValueError):
        resolve_job(job, MagicMock(), media_path=None)
