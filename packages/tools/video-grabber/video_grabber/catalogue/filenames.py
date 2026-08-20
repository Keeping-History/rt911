"""Derive mp3_items metadata from a bucket key.

Every rule here refuses rather than guesses. A filename this parser cannot read
yields start_utc=None and the row is created without a timestamp — a wrong
timestamp puts 2001-09-11 audio on the wrong day of the replay, which is exactly
the failure mode of the transcript-timeline contamination incident.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

DAY = datetime(2001, 9, 11, tzinfo=timezone.utc)
ET_OFFSET = timedelta(hours=4)  # EDT on 2001-09-11; UTC = ET + 4

# Anchored at the start and bounded by a lookahead, so '100225' reads as
# 10:02:25 and never as hour '10' followed by a re-anchored search.
_CLIP_TIME = re.compile(r"^(\d{2})(\d{2})(\d{2})?(?=\D|$)")
# faa_atc tape windows: '… 1245-1316 UTC …'
_UTC_WINDOW = re.compile(r"\b(\d{2})(\d{2})-(\d{2})(\d{2})\s+UTC\b")
# A leading callsign token left over after the timestamp is stripped.
_CALLSIGN = re.compile(r"^(aa|ua|d|dal|ual)?\s*\d{1,4}\s*", re.I)


@dataclass(frozen=True)
class ParsedName:
    title: str
    start_utc: datetime | None


def _at(hh: int, mm: int, ss: int = 0, *, offset: timedelta = timedelta()) -> datetime | None:
    if hh > 23 or mm > 59 or ss > 59:
        return None
    return DAY + timedelta(hours=hh, minutes=mm, seconds=ss) + offset


def _clip_start(stem: str) -> datetime | None:
    m = _CLIP_TIME.match(stem)
    if not m:
        return None
    return _at(int(m.group(1)), int(m.group(2)), int(m.group(3) or 0), offset=ET_OFFSET)


def _utc_window_start(stem: str) -> datetime | None:
    m = _UTC_WINDOW.search(stem)
    if not m:
        return None
    return _at(int(m.group(1)), int(m.group(2)))


def _title(stem: str) -> str:
    rest = _CLIP_TIME.sub("", stem).strip()
    rest = _CALLSIGN.sub("", rest).strip()
    return rest or stem


def parse_key(key: str) -> ParsedName:
    """Return the title and UTC start instant implied by a bucket key."""
    stem = Path(key).stem
    start = _utc_window_start(stem)
    if start is not None:
        return ParsedName(title=stem, start_utc=start)
    start = _clip_start(stem)
    if start is not None:
        return ParsedName(title=_title(stem), start_utc=start)
    return ParsedName(title=stem, start_utc=None)
