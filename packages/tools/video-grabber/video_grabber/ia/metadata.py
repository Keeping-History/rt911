"""
Metadata extraction — air date parsing, channel slug, timezone resolution.
Ported from packages/backend/seed.mjs:parseTitleDate().
"""
import re
from datetime import datetime, timezone, timedelta

from video_grabber.ia.channel_map import normalize_slug

# Fixed UTC offsets used during Sep 2001 (pre-IANA; no DST transitions within our window)
_TZABBR: dict[str, timedelta] = {
    "EDT": timedelta(hours=-4),
    "ET":  timedelta(hours=-4),
    "CDT": timedelta(hours=-5),
    "CT":  timedelta(hours=-5),
    "MDT": timedelta(hours=-6),
    "MT":  timedelta(hours=-6),
    "PDT": timedelta(hours=-7),
    "PT":  timedelta(hours=-7),
    "EST": timedelta(hours=-5),
    "CST": timedelta(hours=-6),
    "MST": timedelta(hours=-7),
    "PST": timedelta(hours=-8),
    "UTC": timedelta(0),
    "GMT": timedelta(0),
    "BST": timedelta(hours=1),   # British Summer Time
    "CEST": timedelta(hours=2),
    "CET": timedelta(hours=1),
}

# Default offset when no tz abbreviation is found — EDT matches US East Coast 9/11 coverage
_DEFAULT_OFFSET = timedelta(hours=-4)

# Some abbreviations are genuinely ambiguous across regions. "CST" is US Central
# (-6) in a US title but China Standard Time (+8) for CCTV3; "CT" likewise. When
# one of these appears for a channel with a known canonical timezone, trust the
# channel's region over the literal abbreviation.
_AMBIGUOUS_ABBR: frozenset[str] = frozenset({"CST", "CT"})

# Canonical Sept-2001 UTC offset per channel, used to disambiguate the entries
# in _AMBIGUOUS_ABBR. Only non-US broadcasters need an entry; US channels fall
# through to the literal (US) reading. Sept 2001 is inside summer DST for the
# Northern Hemisphere with no transition in our window, so fixed offsets are
# exact. (Most channels resolve air time from the UTC identifier timestamp and
# never reach this path; this is the authoritative fallback when they do.)
_CHANNEL_OFFSET: dict[str, timedelta] = {
    "cctv3": timedelta(hours=8),   # China Standard Time
    "nhk": timedelta(hours=9),     # Japan Standard Time
    "bbc": timedelta(hours=1),     # British Summer Time
    "mcm": timedelta(hours=2),     # Central European Summer Time
    "ant1": timedelta(hours=3),    # Greece, Eastern European Summer Time
    "ntv": timedelta(hours=4),     # Moscow Summer Time
}


def _resolve_offset(
    tz_abbr: str | None, channel_slug: str | None, default: timedelta
) -> timedelta:
    """UTC offset for a parsed title time. An explicit abbreviation wins, except
    that an *ambiguous* one (see _AMBIGUOUS_ABBR) defers to the channel's known
    region. Falls back to ``default`` when nothing matches."""
    if tz_abbr:
        abbr = tz_abbr.upper()
        canonical = _CHANNEL_OFFSET.get((channel_slug or "").lower())
        if abbr in _AMBIGUOUS_ABBR and canonical is not None:
            return canonical
        off = _TZABBR.get(abbr)
        if off is not None:
            return off
    return default

# Ordered patterns — most specific first. Use named groups to avoid index shifting.
_MONTH_NAMES = (
    "january|february|march|april|may|june|july|august|september|"
    "october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec"
)

_PATTERNS: list[tuple[str, re.Pattern]] = [
    # ISO 8601: 2001-09-11T08:00:00 or 2001-09-11 08:00:00
    (
        "iso",
        re.compile(
            r"(?P<isodate>\d{4}-\d{2}-\d{2})[T ](?P<isotime>\d{2}:\d{2}(?::\d{2})?)"
            r"(?:\s*(?P<isotz>[A-Z]{2,5}))?",
            re.IGNORECASE,
        ),
    ),
    # "September 11, 2001 8:00am EDT"  /  "Sep 11 2001 9:00 AM"
    (
        "named",
        re.compile(
            rf"(?P<month>{_MONTH_NAMES})\s+(?P<day>\d{{1,2}}),?\s+(?P<year>\d{{4}})"
            r"\s+(?P<time>\d{1,2}:\d{2}(?::\d{2})?)(?:\s*(?P<ampm>AM|PM))?"
            r"(?:\s+(?P<tz>[A-Z]{2,5}))?",
            re.IGNORECASE,
        ),
    ),
]

_MONTH_MAP = {
    "january": 1, "jan": 1, "february": 2, "feb": 2, "march": 3, "mar": 3,
    "april": 4, "apr": 4, "may": 5, "june": 6, "jun": 6, "july": 7, "jul": 7,
    "august": 8, "aug": 8, "september": 9, "sep": 9, "sept": 9,
    "october": 10, "oct": 10, "november": 11, "nov": 11, "december": 12, "dec": 12,
}


def extract_air_date_utc(
    title: str, description: str = "", channel_slug: str | None = None
) -> datetime | None:
    """Parse air date from title then description; return UTC datetime or None.

    ``channel_slug`` disambiguates region-ambiguous timezone abbreviations in
    the title (e.g. CCTV3's "CST" is China, not US Central)."""
    for text in (title, description):
        if not text:
            continue
        result = _parse_text(text, channel_slug)
        if result is not None:
            return result
    return None


def _parse_text(text: str, channel_slug: str | None = None) -> datetime | None:
    for kind, pattern in _PATTERNS:
        m = pattern.search(text)
        if m is None:
            continue
        try:
            return _build_datetime(kind, m, channel_slug)
        except (ValueError, KeyError):
            continue
    return None


def _build_datetime(
    kind: str, m: re.Match, channel_slug: str | None = None
) -> datetime | None:
    gd = m.groupdict()

    if kind == "iso":
        date_str = gd["isodate"]
        time_str = gd["isotime"]
        tz_abbr = gd.get("isotz")
        year, month, day = map(int, date_str.split("-"))
        # ISO without tz → treat as UTC (not local time)
        offset = _resolve_offset(tz_abbr, channel_slug, default=timedelta(0))
    else:
        month = _MONTH_MAP[gd["month"].lower()]
        day = int(gd["day"])
        year = int(gd["year"])
        time_str = gd["time"]
        ampm = gd.get("ampm")
        tz_abbr = gd.get("tz")
        time_str = _apply_ampm(time_str, ampm)
        offset = _resolve_offset(tz_abbr, channel_slug, default=_DEFAULT_OFFSET)

    h, mn, sec = _parse_time(time_str)
    tz = timezone(offset)
    local_dt = datetime(year, month, day, h, mn, sec, tzinfo=tz)
    return local_dt.astimezone(timezone.utc)


def _apply_ampm(time_str: str, ampm: str | None) -> str:
    if ampm is None:
        return time_str
    parts = time_str.split(":")
    h = int(parts[0])
    if ampm.upper() == "PM" and h != 12:
        h += 12
    elif ampm.upper() == "AM" and h == 12:
        h = 0
    parts[0] = str(h)
    return ":".join(parts)


def _parse_time(time_str: str) -> tuple[int, int, int]:
    parts = time_str.split(":")
    h = int(parts[0])
    mn = int(parts[1]) if len(parts) > 1 else 0
    sec = int(parts[2]) if len(parts) > 2 else 0
    return h, mn, sec


def resolve_timezone(tz_str: str | None, channel_slug: str) -> timezone:
    """Return a fixed-offset timezone, disambiguating region-ambiguous
    abbreviations by ``channel_slug``. Falls back to EDT (UTC-4) when unknown."""
    return timezone(_resolve_offset(tz_str, channel_slug, _DEFAULT_OFFSET))


def extract_channel_slug(item: dict) -> str | None:
    """Delegate to channel_map.normalize_slug."""
    return normalize_slug(item)


def extract_duration_seconds(item: dict) -> int:
    """Return duration in whole seconds; 0 if absent or unparseable."""
    raw = item.get("length") or ""
    try:
        return int(float(str(raw).strip()))
    except (ValueError, TypeError):
        return 0
