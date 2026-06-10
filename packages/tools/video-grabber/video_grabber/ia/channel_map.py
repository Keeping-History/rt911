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
    return None


def _slug_from_text(text: str) -> str | None:
    lower = text.lower()
    for pattern, slug in KNOWN_CHANNELS.items():
        if pattern in lower:
            return slug
    m = _LOCAL_CALL_SIGN.search(text.upper())
    if m:
        return m.group(1).lower()
    return None
