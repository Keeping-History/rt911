"""Compute the current virtual UTC time from the channel content window in Directus.

All tv_channels share a common start_date and end_date (the 9-day archive window).
The virtual clock starts at start_date when VIRTUAL_EPOCH_REAL real-world time
passes, then advances 1:1 with real time, looping back to start_date after each
full window duration.
"""
from datetime import datetime, timedelta, timezone

import httpx

from video_grabber.config import Config


def _fetch_window(cfg: Config, client=httpx) -> tuple[datetime, datetime]:
    """Return (start_date, end_date) from any approved tv_channels row."""
    resp = client.get(
        f"{cfg.directus_url}/items/tv_channels",
        params={"filter[approved][_eq]": 1, "fields": "start_date,end_date", "limit": 1},
        headers={"Authorization": f"Bearer {cfg.directus_api_token}"},
        timeout=10,
    )
    resp.raise_for_status()
    row = resp.json()["data"][0]
    # Directus stores datetimes without a timezone suffix; treat as UTC.
    start = datetime.fromisoformat(row["start_date"]).replace(tzinfo=timezone.utc)
    end = datetime.fromisoformat(row["end_date"]).replace(tzinfo=timezone.utc)
    return start, end


def virtual_utc_now(cfg: Config, *, client=httpx) -> datetime:
    """Return the current virtual UTC datetime.

    Reads start_date and end_date from Directus tv_channels, then computes:
        virtual_now = start_date + elapsed % window_duration
    where elapsed = real_now - VIRTUAL_EPOCH_REAL. The modulo means the clock
    loops back to start_date after each full pass through the 9-day archive.
    """
    start, end = _fetch_window(cfg, client)
    window = end - start
    epoch_real = datetime.fromisoformat(cfg.virtual_epoch_real).astimezone(timezone.utc)
    elapsed = datetime.now(timezone.utc) - epoch_real
    return start + timedelta(seconds=elapsed.total_seconds() % window.total_seconds())
