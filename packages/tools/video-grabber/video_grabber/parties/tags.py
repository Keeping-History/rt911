"""Turn an identified `parties` block into flat, searchable tags.

Tags are **derived**, never separately generated. Asking the model for tags as
well as parties would give you two accounts of the same recording that quietly
disagree — a `facility:zob` tag on a row whose parties block says Cleveland.
Everything here is a pure function of the block, so the only way a tag can be
wrong is if the block is, and the containment gate already governs that.

The one exception is `topic:`, which has no equivalent in the block and comes
from the model's pick out of `vocab.TOPICS`.

Tags are namespaced (`facility:zob`, not `zob`) for two reasons: a bare tag list
cannot be filtered by kind, and names collide across kinds — "Boston" is a
facility, and Boston is also a surname.

Participating and merely-mentioned entities both get tagged. Someone searching
for Cleveland Center wants the calls that discuss it, not only the ones it spoke
on; the parties block keeps the distinction for anyone who needs it.
"""
from __future__ import annotations

import re
from collections.abc import Iterable

from video_grabber.parties.spoken import spoken_to_digits
from video_grabber.parties.vocab import (
    AIRCRAFT_TYPES,
    TOPICS,
    agency_for,
    canonical_facility,
)

_NON_ALNUM = re.compile(r"[^a-z0-9]+")
_CALLSIGN = re.compile(r"^([a-z]*)0*(\d+)$")

# Spoken airline names and their ICAO-ish prefixes, so "American 11", "AAL11"
# and "AA11" all land on one tag instead of three.
_AIRLINE_PREFIX: dict[str, str] = {
    "american": "aal", "aa": "aal", "aal": "aal",
    "united": "ual", "ua": "ual", "ual": "ual",
    "delta": "dal", "dl": "dal", "dal": "dal",
    "continental": "coa", "coa": "coa",
    "usair": "usa", "usairways": "usa",
    "midwest": "mep", "northwest": "nwa", "nwa": "nwa",
}


def slugify(value: str) -> str:
    return _NON_ALNUM.sub("-", (value or "").lower()).strip("-")


def normalize_callsign(callsign: str) -> str:
    """`American 11` / `AAL11` / `AA 11` -> `aal11`; `Gofer 06` -> `gofer06`.

    Military and unmatched callsigns keep their own prefix — the point is to
    collapse the ways one aircraft is written, not to force everything into an
    airline scheme. Leading zeros go so `Quit 2-5` and `QUIT25` agree.
    """
    # "Delta Eighty Nine" has to reach the same tag as "DAL89".
    compact = _NON_ALNUM.sub("", spoken_to_digits(callsign or "").lower())
    m = _CALLSIGN.match(compact)
    if not m:
        return compact
    prefix, digits = m.group(1), m.group(2)
    return f"{_AIRLINE_PREFIX.get(prefix, prefix)}{digits}"


def build_tags(parties: dict, curated: Iterable[str] = ()) -> list[str]:
    """Every tag implied by an identified parties block, sorted and deduped.

    `curated` is merged in verbatim. It exists because the obvious way to
    preserve hand-added tags — merging the new derived set into whatever `tags`
    already held — is wrong: derived tags could then only ever accumulate. A
    facility the model stops identifying, or one removed because the gate now
    rejects it, would linger in the index forever with nothing able to retract
    it. Re-running would silently entrench old mistakes.

    So the derived set is always rebuilt from scratch and is authoritative for
    itself, and human additions live in their own column (`tags_curated`) that
    the flow reads but never writes. Nothing a curator types can be clobbered,
    and nothing the model retracts can survive.

    Curated values are taken as given — not slugged, not namespaced — since a
    curator may need vocabulary this module has never heard of.
    """
    tags: set[str] = {t.strip() for t in curated if t and t.strip()}

    if parties.get("tier"):
        tags.add(f"tier:{slugify(parties['tier'])}")
    if parties.get("link"):
        tags.add(f"link:{slugify(parties['link'])}")

    facilities: list[str] = []
    for p in parties.get("participants") or []:
        if p.get("role"):
            tags.add(f"role:{slugify(p['role'])}")
        if p.get("facility"):
            facilities.append(p["facility"])
        if p.get("person"):
            tags.add(f"person:{slugify(p['person'])}")

    mentions = parties.get("mentions") or {}
    facilities += list(mentions.get("facilities") or [])
    for person in mentions.get("people") or []:
        tags.add(f"person:{slugify(person)}")

    for facility in facilities:
        # Resolve to the index's name for the place, so "Boston", "Boston Center"
        # and "ZBW" are one tag instead of three. Unlisted facilities keep their
        # own slug rather than being dropped.
        slug = canonical_facility(facility) or slugify(facility)
        if not slug:
            continue
        tags.add(f"facility:{slug}")
        agency = agency_for(facility) or agency_for(slug)
        if agency:
            tags.add(f"agency:{agency}")

    aircraft = list(parties.get("aircraft") or []) + list(mentions.get("aircraft") or [])
    for callsign in aircraft:
        slug = normalize_callsign(str(callsign))
        if slug and slug not in AIRCRAFT_TYPES:
            tags.add(f"aircraft:{slug}")

    for topic in parties.get("topics") or []:
        if topic in TOPICS:
            tags.add(f"topic:{topic}")

    # 'various' is the tape tier's placeholder for "many counterparties"; it is
    # not a facility and must never become one. A curator who types it anyway
    # means it, so this only removes what derivation produced.
    if "facility:various" not in curated:
        tags.discard("facility:various")
    return sorted(tags)
