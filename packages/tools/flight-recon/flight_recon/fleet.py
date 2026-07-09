"""
BTS Schedule B-43 aircraft inventory: tail number -> aircraft type.

The B-43 ("Air Carrier Financial: Schedule B-43 Inventory") is the
historically-correct fleet reference for 2001 — the current FAA registry
reflects today's registrations and N-numbers get reassigned. Input contract
is a prepped CSV with TAIL_NUMBER, MANUFACTURER, MODEL columns (see the
"Acquire B-43" runbook step in the flight-metadata plan).

Never guess: an unmatched or malformed tail yields None and the flight simply
has no aircraft_type.
"""

import csv
import re

_TAIL_JUNK = re.compile(r"[^A-Z0-9]")
# Sentinels seen in BTS tail columns, plus "NAN" (a pandas NaN stringified
# upstream) which would otherwise normalize to a plausible-looking tail.
_NOT_A_TAIL = {"", "UNKNOW", "UNKNOWN", "NONE", "NAN"}


def normalize_tail(raw):
    """Return the canonical N-number for a BTS/B-43 tail cell, or None."""
    if raw is None:
        return None
    t = _TAIL_JUNK.sub("", str(raw).upper())
    if t in _NOT_A_TAIL:
        return None
    if not t.startswith("N"):
        t = "N" + t
    return t


def load_fleet(path):
    """Load a prepped B-43 CSV into {normalized_tail: "Manufacturer Model"}."""
    fleet = {}
    with open(path, newline="", encoding="latin-1") as fh:
        for row in csv.DictReader(fh):
            tail = normalize_tail(row.get("TAIL_NUMBER"))
            model = (row.get("MODEL") or "").strip()
            if not tail or not model:
                continue
            mfr = (row.get("MANUFACTURER") or "").strip().title()
            fleet[tail] = f"{mfr} {model}".strip()
    return fleet
