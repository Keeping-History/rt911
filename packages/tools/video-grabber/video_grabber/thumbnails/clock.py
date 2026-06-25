"""Compute the current virtual UTC time from a configurable real-time epoch offset.

The classicy frontend clock was initialised at a known real-time instant
(``VIRTUAL_EPOCH_REAL``) to a known virtual instant (``VIRTUAL_EPOCH_VIRTUAL``)
and advances at a 1:1 real-time rate since then.
"""
from datetime import datetime, timezone

from video_grabber.config import Config


def virtual_utc_now(cfg: Config) -> datetime:
    """Return the current virtual UTC datetime based on the configured epoch offset."""
    epoch_real = datetime.fromisoformat(cfg.virtual_epoch_real)
    epoch_virtual = datetime.fromisoformat(cfg.virtual_epoch_virtual)
    real_now = datetime.now(timezone.utc)
    # Both datetimes must be tz-aware for subtraction; fromisoformat preserves the
    # offset, but normalise to UTC to be safe.
    epoch_real_utc = epoch_real.astimezone(timezone.utc)
    epoch_virtual_utc = epoch_virtual.astimezone(timezone.utc)
    elapsed = real_now - epoch_real_utc
    return epoch_virtual_utc + elapsed
