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

# US registration grammar: N + 1-5 digits, or N + 1-4 digits + 1 letter, or
# N + 1-3 digits + 2 letters; no leading zero. Used to gate passthrough of
# raw values when a decode map is active — a value like "N334A1" is
# format-invalid (digit after letter) and must not be stored as a tail.
VALID_TAIL = re.compile(
    r"^N[1-9]\d{0,4}$|^N[1-9]\d{0,3}[A-Z]$|^N[1-9]\d{0,2}[A-Z]{2}$")


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


def load_tail_decode(path):
    """Load a decode-map CSV (CARRIER,RAW_TAIL,TAIL_NUMBER) into
    {(carrier, raw): tail}. Produced by analysis/decode_2001_tails.py — maps
    the September 2001 BTS file's mangled tail values (botched EBCDIC
    conversion, see that script's docstring) to real registrations."""
    out = {}
    with open(path, newline="", encoding="latin-1") as fh:
        for row in csv.DictReader(fh):
            carrier = (row.get("CARRIER") or "").strip()
            raw = (row.get("RAW_TAIL") or "").strip()
            tail = (row.get("TAIL_NUMBER") or "").strip()
            if carrier and raw and tail:
                out[(carrier, raw)] = tail
    return out


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
