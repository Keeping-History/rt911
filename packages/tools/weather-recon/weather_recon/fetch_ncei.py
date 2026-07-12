"""
Per-station subset download from NCEI's global-hourly data service.

Endpoint verified live 2026-07-12: endDate is INCLUSIVE; response columns are
dynamic (only populated ones appear), so callers parse by name. Raw CSV is
cached per (station, window) so re-runs and the live-verification re-run
don't re-hit NCEI 188 times.
"""

import csv
import io
from urllib.parse import urlencode

BASE = "https://www.ncei.noaa.gov/access/services/data/v1"


def ncei_url(isd_id, start, end):
    """Subset URL for one station; isd_id is Phase 1's 'USAF-WBAN' form."""
    return BASE + "?" + urlencode({
        "dataset": "global-hourly",
        "stations": isd_id.replace("-", ""),
        "startDate": start,
        "endDate": end,
        "format": "csv",
    })


def fetch_station_csv(client, isd_id, start, end, cache_dir):
    """Fetch (or read cached) subset CSV -> list of DictReader row dicts."""
    cache_file = None
    if cache_dir is not None:
        cache_file = cache_dir / f"{isd_id}_{start}_{end}.csv"
    if cache_file is not None and cache_file.is_file():
        text = cache_file.read_text(encoding="utf-8")
    else:
        r = client.get(ncei_url(isd_id, start, end), timeout=120)
        r.raise_for_status()
        text = r.text
        if cache_file is not None:
            cache_dir.mkdir(parents=True, exist_ok=True)
            cache_file.write_text(text, encoding="utf-8")
    return list(csv.DictReader(io.StringIO(text)))
