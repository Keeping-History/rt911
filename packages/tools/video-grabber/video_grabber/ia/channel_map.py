"""
Canonical channel slug map. Defined here before scanner implementation
so both collections produce consistent slugs.

Normalization priority: creator field → subject field → regex on title.
"""
from __future__ import annotations

import re

KNOWN_CHANNELS: dict[str, str] = {
    "cable news network": "cnn",
    "cnn": "cnn",
    "msnbc": "msnbc",
    "abc news": "abc-news",
    "abc": "abc-news",
    "cbs news": "cbs-news",
    "cbs": "cbs-news",
    "nbc news": "nbc-news",
    "nbc": "nbc-news",
    "pbs": "pbs",
    "bbc": "bbc",
    "bbc news": "bbc",
    "fox news": "fox-news",
    "fox": "fox-news",
    "c-span": "c-span",
    "cspan": "c-span",
    "univision": "univision",
    "telemundo": "telemundo",
    "cctv4": "cctv4",
}

# Local affiliate call-sign pattern: W/K followed by 3 uppercase letters
_LOCAL_CALL_SIGN = re.compile(r"\b([WK][A-Z]{3})\b")

# Channel-code prefix of an IA identifier, e.g. "ANT1" in
# "ANT1_20010914_010000_Antenna_1_Greece". The Sept-11 archive names every
# capture <CHANNEL>_<YYYYMMDD>_<HHMMSS>_<desc>, so the leading token is a clean,
# stable per-channel code. Used as a last-resort slug source for broadcasters
# not in KNOWN_CHANNELS (mostly international feeds: NHK, CCTV3, ANT1, WORLDNET,
# …). Requires a leading letter so a date- or number-led identifier never
# becomes a "channel".
_IDENT_PREFIX = re.compile(r"^([A-Za-z][A-Za-z0-9]{1,15})_")


def normalize_slug(item: dict) -> str | None:
    """Return a channel slug from IA item metadata, or None if unrecognized.

    Priority:
      1. A *known network* named in creator/subject/title (e.g. "ABC News").
      2. The IA identifier's channel-code prefix (``CNN_``, ``WETA_``, ``ANT1_``,
         …) — the authoritative per-capture broadcaster code in the Sept-11
         archive.
      3. A bare W/K call sign found in the text — last resort only.

    Step 2 must precede step 3: the ``[WK][A-Z]{3}`` call-sign pattern also
    matches ordinary four-letter title words ("WOLF" in *Wolf Blitzer*, "KING"
    in *Larry King Live*, "WITH"/"WALL"/"WILD"/"WIND"/…), which previously minted
    bogus channels out of program titles. The identifier prefix is unambiguous,
    so trust it before guessing from free text.
    """
    for field in ("creator", "subject", "title"):
        slug = _known_network(_as_text(item.get(field)))
        if slug:
            return slug

    ident = _slug_from_identifier(item.get("identifier", ""))
    if ident:
        return ident

    for field in ("creator", "subject", "title"):
        slug = _call_sign(_as_text(item.get(field)))
        if slug:
            return slug
    return None


def _as_text(value) -> str:
    if isinstance(value, list):
        return " ".join(value)
    return value or ""


def _slug_from_identifier(identifier: str) -> str | None:
    m = _IDENT_PREFIX.match(identifier or "")
    if not m:
        return None
    raw = m.group(1).lower()
    # Normalize aliases (e.g. an "ABC_" prefix -> abc-news); unknown codes
    # (nhk, weta, ant1, …) pass through unchanged.
    return KNOWN_CHANNELS.get(raw, raw)


def _known_network(text: str) -> str | None:
    lower = text.lower()
    for pattern, slug in KNOWN_CHANNELS.items():
        if pattern in lower:
            return slug
    return None


def _call_sign(text: str) -> str | None:
    m = _LOCAL_CALL_SIGN.search(text.upper())
    return m.group(1).lower() if m else None
