"""
Prefect flow: GHCN-Daily -> per-station almanac JSON on Wasabi.

GHCN id resolution (flow-internal by design — see the phase plan): derive
USW000+WBAN, else nearest ghcnd-stations.txt entry within 20 km, else
GHCN_OVERRIDES, else recorded gap. A derived/matched id that returns zero
daily rows demotes to the next strategy rather than publishing an empty
almanac. All math cuts off at 2001-09-08 (anachronism rule).
"""

import json
import uuid
from pathlib import Path

import httpx
from prefect import flow, get_run_logger, task

from weather_recon.flow import NETWORK_RETRIES
from weather_recon.ghcn import (compute_almanac, derive_ghcn_id, nearest_ghcn,
                                parse_daily_rows, parse_ghcnd_stations)
from weather_recon.stations import load_stations
from weather_recon.wasabi import make_client, upload_bytes

GHCND_STATIONS_URL = "https://www.ncei.noaa.gov/pub/data/ghcn/daily/ghcnd-stations.txt"
DAILY_URL = "https://www.ncei.noaa.gov/access/services/data/v1"
MONTH_DAYS = ["09-09", "09-10", "09-11", "09-12"]
KEY_PREFIX = "weather/almanac/"

# Hand-curated GHCN ids for stations neither derivation nor 20 km matching
# resolves. Populate only with ids verified to return daily data.
GHCN_OVERRIDES: dict[str, str] = {}


def _fetch_daily(client, ghcn_id, cutoff, cache_dir):
    cache_file = cache_dir / f"daily_{ghcn_id}.csv" if cache_dir else None
    if cache_file is not None and cache_file.is_file():
        return cache_file.read_text(encoding="utf-8")
    r = client.get(DAILY_URL, params={
        "dataset": "daily-summaries", "stations": ghcn_id,
        "startDate": "1900-01-01", "endDate": cutoff,
        "dataTypes": "TMAX,TMIN,PRCP", "format": "csv"}, timeout=180)
    r.raise_for_status()
    if cache_file is not None:
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(r.text, encoding="utf-8")
    return r.text


def _ghcnd_station_list(client, cache_dir):
    cache_file = cache_dir / "ghcnd-stations.txt" if cache_dir else None
    if cache_file is not None and cache_file.is_file():
        text = cache_file.read_text(encoding="utf-8")
    else:
        r = client.get(GHCND_STATIONS_URL, timeout=300)
        r.raise_for_status()
        text = r.text
        if cache_file is not None:
            cache_dir.mkdir(parents=True, exist_ok=True)
            cache_file.write_text(text, encoding="utf-8")
    return parse_ghcnd_stations(text)


@task(**NETWORK_RETRIES)
def build_and_publish(stations_path, cache_dir, cutoff, run_id):
    log = get_run_logger()
    stations = load_stations(stations_path)
    cache = Path(cache_dir) if cache_dir else None
    s3 = make_client()
    published, gaps = [], []
    with httpx.Client(follow_redirects=True) as client:
        ghcnd = _ghcnd_station_list(client, cache)
        for i, st in enumerate(stations, 1):
            sid = st["station_id"]
            candidates = []
            if sid in GHCN_OVERRIDES:
                candidates.append(GHCN_OVERRIDES[sid])
            derived = derive_ghcn_id(st["isd_id"])
            if derived:
                candidates.append(derived)
            near = nearest_ghcn(st["lat"], st["lon"], ghcnd)
            if near and near not in candidates:
                candidates.append(near)
            almanac, used = None, None
            for gid in candidates:
                rows = parse_daily_rows(_fetch_daily(client, gid, cutoff, cache))
                if sum(1 for r in rows if r["tmax_c"] is not None) >= 300:
                    almanac, used = compute_almanac(rows, MONTH_DAYS, cutoff), gid
                    break
            if almanac is None:
                gaps.append(sid)
                continue
            body = json.dumps({"station_id": sid, "ghcn_id": used,
                               "cutoff": cutoff, "days": almanac,
                               "run_id": run_id}).encode("utf-8")
            upload_bytes(s3, f"{KEY_PREFIX}{sid}.json", body,
                         "application/json", "max-age=31536000")
            published.append(sid)
            if i % 25 == 0:
                log.info("almanac %d/%d (published %d, gaps %d)",
                         i, len(stations), len(published), len(gaps))
    index = {"stations": sorted(published), "gaps": sorted(gaps),
             "cutoff": cutoff, "key_prefix": KEY_PREFIX,
             "key_pattern": "{station_id}.json"}
    upload_bytes(s3, f"{KEY_PREFIX}index.json", json.dumps(index).encode("utf-8"),
                 "application/json", "max-age=300")
    log.info("published %d almanacs, %d gaps (%s)", len(published), len(gaps),
             ", ".join(gaps) or "none")
    return len(published), gaps


@flow(name="load-weather-almanac", log_prints=True)
def load_weather_almanac(
    stations_path: str = "/app/data/stations.csv",
    cache_dir: str | None = "/tmp/ghcn-cache",
    cutoff: str = "2001-09-08",
):
    log = get_run_logger()
    run_id = uuid.uuid4().hex
    n, gaps = build_and_publish(stations_path, cache_dir, cutoff, run_id)
    log.info("done: %d almanacs on Wasabi, run_id=%s", n, run_id)
    return {"published": n, "gaps": gaps, "run_id": run_id}


if __name__ == "__main__":
    import sys
    path = sys.argv[1] if len(sys.argv) > 1 else "data/stations.csv"
    load_weather_almanac(stations_path=path)
