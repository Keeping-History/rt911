"""
Canonical channel slug map. Defined here before scanner implementation
so both collections produce consistent slugs.

Normalization priority: creator field → subject field → regex on title.
"""
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
    """Return a channel slug from IA item metadata, or None if unrecognized."""
    for field in ("creator", "subject", "title"):
        value = item.get(field, "")
        if isinstance(value, list):
            value = " ".join(value)
        if not value:
            continue
        slug = _slug_from_text(value)
        if slug:
            return slug
    # Last resort: the identifier's channel-code prefix. Only reached when the
    # human-readable fields named no known network and carried no call sign.
    return _slug_from_identifier(item.get("identifier", ""))


def _slug_from_identifier(identifier: str) -> str | None:
    m = _IDENT_PREFIX.match(identifier or "")
    return m.group(1).lower() if m else None


def _slug_from_text(text: str) -> str | None:
    lower = text.lower()
    for pattern, slug in KNOWN_CHANNELS.items():
        if pattern in lower:
            return slug
    m = _LOCAL_CALL_SIGN.search(text.upper())
    if m:
        return m.group(1).lower()
    return None
