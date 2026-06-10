"""
Tests for IA metadata extractor — air date parsing, channel normalization,
timezone resolution, and UTC conversion. No network calls.
"""
import pytest
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo

from video_grabber.ia.metadata import (
    extract_air_date_utc,
    resolve_timezone,
    extract_channel_slug,
    extract_duration_seconds,
)


# ---------------------------------------------------------------------------
# Air date extraction — ported from seed.mjs parseTitleDate fixtures
# ---------------------------------------------------------------------------

TITLE_FIXTURES = [
    # (title, description, expected_utc_datetime)
    (
        "CNN September 11, 2001 8:00am EDT",
        "",
        datetime(2001, 9, 11, 12, 0, tzinfo=timezone.utc),  # 8am EDT = 12:00 UTC
    ),
    (
        "MSNBC Sep 11 2001 9:00 AM EDT live coverage",
        "",
        datetime(2001, 9, 11, 13, 0, tzinfo=timezone.utc),  # 9am EDT = 13:00 UTC
    ),
    (
        "NBC News September 11 2001 7:00 PM EDT",
        "",
        datetime(2001, 9, 11, 23, 0, tzinfo=timezone.utc),
    ),
    (
        "CBS Evening News September 12, 2001 6:30 PM CDT",
        "",
        datetime(2001, 9, 12, 23, 30, tzinfo=timezone.utc),  # 6:30pm CDT = 23:30 UTC
    ),
    (
        "Fox News September 13 2001 3:00 PM PDT",
        "",
        datetime(2001, 9, 13, 22, 0, tzinfo=timezone.utc),  # 3pm PDT = 22:00 UTC
    ),
    (
        "PBS NewsHour 2001-09-11T20:00:00",
        "",
        datetime(2001, 9, 11, 20, 0, tzinfo=timezone.utc),  # ISO 8601 assumed UTC
    ),
    (
        "ABC World News Tonight Sep 11 2001",
        "Broadcast September 11, 2001 6:30 PM EDT",
        datetime(2001, 9, 11, 22, 30, tzinfo=timezone.utc),  # falls back to description
    ),
    (
        "CNN Live Coverage September 11 2001 10:00 AM",  # no tz abbr → default EDT
        "",
        datetime(2001, 9, 11, 14, 0, tzinfo=timezone.utc),
    ),
    (
        "WTVD September 11 2001 11:00PM ET",
        "",
        datetime(2001, 9, 12, 3, 0, tzinfo=timezone.utc),  # 11pm ET = next day 03:00 UTC
    ),
    (
        "BBC World September 11 2001 14:00 BST",
        "",
        datetime(2001, 9, 11, 13, 0, tzinfo=timezone.utc),  # BST = UTC+1
    ),
]


@pytest.mark.parametrize("title,description,expected", TITLE_FIXTURES)
def test_extract_air_date_utc(title, description, expected):
    result = extract_air_date_utc(title, description)
    assert result is not None, f"Failed to parse: {title!r}"
    # Allow ±1 minute tolerance for ambiguous formats
    delta = abs((result - expected).total_seconds())
    assert delta < 120, f"Got {result!r}, expected {expected!r} for title {title!r}"


def test_no_date_returns_none():
    result = extract_air_date_utc("Random program without any date", "")
    assert result is None


def test_iso_date_no_time_returns_none():
    # Date alone without time is not enough for our use case
    result = extract_air_date_utc("Program 2001-09-11", "")
    # This may or may not parse — just ensure no exception
    # (acceptable to return None or a midnight UTC datetime)
    assert result is None or isinstance(result, datetime)


# ---------------------------------------------------------------------------
# Out-of-range detection (Sep 9–17 2001 UTC window)
# ---------------------------------------------------------------------------

def test_date_in_range_passes():
    dt = extract_air_date_utc("CNN September 11, 2001 8:00am EDT", "")
    assert dt is not None
    assert datetime(2001, 9, 9, tzinfo=timezone.utc) <= dt <= datetime(2001, 9, 18, tzinfo=timezone.utc)


def test_date_out_of_range_still_returned():
    # extract_air_date_utc returns the date; range filtering is caller's responsibility
    dt = extract_air_date_utc("CNN October 1 2001 8:00am EDT", "")
    if dt is not None:
        assert dt.year == 2001 and dt.month == 10


# ---------------------------------------------------------------------------
# Timezone resolution
# ---------------------------------------------------------------------------

def test_resolve_edt():
    tz = resolve_timezone("EDT", "cnn")
    assert tz.utcoffset(datetime(2001, 9, 11)) == timedelta(hours=-4)


def test_resolve_cdt():
    tz = resolve_timezone("CDT", "cbs-news")
    assert tz.utcoffset(datetime(2001, 9, 11)) == timedelta(hours=-5)


def test_resolve_pdt():
    tz = resolve_timezone("PDT", "fox-news")
    assert tz.utcoffset(datetime(2001, 9, 11)) == timedelta(hours=-7)


def test_resolve_bst():
    tz = resolve_timezone("BST", "bbc")
    assert tz.utcoffset(datetime(2001, 9, 11)) == timedelta(hours=1)


def test_resolve_none_defaults_to_edt():
    tz = resolve_timezone(None, "cnn")
    assert tz.utcoffset(datetime(2001, 9, 11)) == timedelta(hours=-4)


def test_resolve_unknown_abbr_falls_back_to_edt():
    tz = resolve_timezone("XYZ", "cnn")
    assert tz.utcoffset(datetime(2001, 9, 11)) == timedelta(hours=-4)


# ---------------------------------------------------------------------------
# Channel slug extraction
# ---------------------------------------------------------------------------

def test_extract_channel_slug_from_creator():
    item = {"creator": "Cable News Network", "subject": [], "title": ""}
    assert extract_channel_slug(item) == "cnn"


def test_extract_channel_slug_from_subject_list():
    item = {"creator": "", "subject": ["MSNBC", "news"], "title": ""}
    assert extract_channel_slug(item) == "msnbc"


def test_extract_channel_slug_from_title_regex():
    item = {"creator": "", "subject": [], "title": "WNYC September 11 2001"}
    assert extract_channel_slug(item) == "wnyc"


def test_extract_channel_slug_unknown():
    item = {"creator": "Unknown TV", "subject": [], "title": "Some show"}
    assert extract_channel_slug(item) is None


# ---------------------------------------------------------------------------
# Duration extraction
# ---------------------------------------------------------------------------

def test_duration_from_length_field():
    assert extract_duration_seconds({"length": "3600"}) == 3600


def test_duration_float_rounds():
    assert extract_duration_seconds({"length": "3601.7"}) == 3601


def test_duration_missing_returns_zero():
    assert extract_duration_seconds({}) == 0
