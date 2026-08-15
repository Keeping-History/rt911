"""Closed vocabularies for the searchable parts of a recording's metadata.

Free-text topics do not survive contact with a search box. Ask a model to say
what 755 recordings are about and you get 700 distinct phrasings — "hijacking
reported", "report of hijack", "possible hijack" — which is prose, not an index.
So the model picks from a fixed list and anything else is dropped.

The list is scoped to what this corpus actually contains: FAA/ATC position and
landline audio, NEADS/NORAD floor tapes, the four hijacked flights, and FDNY
dispatch. It is deliberately short. A vocabulary nobody can hold in their head
gets used inconsistently, which puts you back where you started.
"""
from __future__ import annotations

# What a recording is ABOUT. The model may pick several; anything outside this
# set is discarded by the validator rather than passed through.
TOPICS: frozenset[str] = frozenset({
    # the emergency itself
    "hijack-report",
    "loss-of-contact",
    "transponder-off",
    "primary-target-tracking",
    "unaccounted-aircraft",
    "bomb-threat",
    "aircraft-down",
    "wtc-impact",
    "pentagon-impact",
    "casualty-report",
    # the military response
    "scramble-order",
    "military-escort",
    "shootdown-authority",
    "rules-of-engagement",
    # the civil response
    "ground-stop",
    "airspace-closure",
    "landing-diversion",
    "evacuation",
    "notification-to-hq",
    "coordination-call",
    # ordinary traffic, which is most of the pre-attack corpus
    "routine-clearance",
    "position-handoff",
    "traffic-advisory",
    "weather",
    # a participant relaying what they are seeing on television, which happens
    # more than you would expect and is not the same as a first-hand report
    "media-report",
})

# Which organisation a facility belongs to. Keys are matched case-insensitively
# as substrings of the facility name, longest first, so "Boston Center" and
# "Boston" both resolve without listing every phrasing.
AGENCY_BY_FACILITY: dict[str, str] = {
    # FAA en-route centres, TRACONs and towers
    "atcscc": "faa", "zbw": "faa", "zdc": "faa", "zny": "faa", "zob": "faa",
    "zid": "faa", "zau": "faa", "zme": "faa",
    "boston": "faa", "new york": "faa", "washington": "faa", "cleveland": "faa",
    "indianapolis": "faa", "chicago": "faa", "memphis": "faa",
    "iad": "faa", "dca": "faa", "ewr": "faa", "bos": "faa", "pit": "faa",
    "dulles": "faa", "national": "faa", "newark": "faa", "logan": "faa",
    "command center": "faa", "faa": "faa", "herndon": "faa",
    # air defence
    "neads": "norad", "norad": "norad", "conr": "norad", "huntress": "norad",
    "otis": "usaf", "langley": "usaf", "andrews": "usaf", "adw": "usaf",
    "nmcc": "dod", "pentagon": "dod",
    # civil emergency services
    "fdny": "fdny", "nypd": "nypd", "pafd": "panynj", "port authority": "panynj",
    # carriers
    "american": "airline", "united": "airline", "delta": "airline",
    "continental": "airline", "us airways": "airline",
}

# Airframe models, which the audio names constantly ("we have a 757 inbound").
# They are not callsigns, and `aircraft:757` in the tag index is worse than no
# tag: it collides every Boeing on the morning into one bucket.
AIRCRAFT_TYPES: frozenset[str] = frozenset({
    "727", "737", "747", "757", "767", "777",
    "310", "319", "320", "321", "330", "340",
    "md80", "md11", "dc9", "dc10",
})

ROLES: frozenset[str] = frozenset({
    "atc", "military", "airline", "emergency", "aircraft", "unknown",
})

LINKS: frozenset[str] = frozenset({
    "air-ground", "landline", "internal", "conference", "unknown",
})


def agency_for(facility: str | None) -> str | None:
    """Best-guess agency for a facility name, or None.

    Longest key first so "port authority" wins over a bare substring, and
    "us airways" is not shadowed by a shorter carrier key.
    """
    if not facility:
        return None
    haystack = facility.lower()
    for key in sorted(AGENCY_BY_FACILITY, key=len, reverse=True):
        if key in haystack:
            return AGENCY_BY_FACILITY[key]
    return None
