"""
Prefect flow: fetch 2001-09-09..12 METAR/SPECI observations for every curated
station from NCEI and load them into Directus weather_observations.

Idempotency: delete_all("weather_observations") before insert — the entire
collection is exactly this flow's window, so a full reload is the simplest
correct re-run story (same rationale as the stations reference table).

$DIRECTUS_API_TOKEN env-only, as in flow.py.
"""

import uuid
from pathlib import Path

import httpx
from prefect import flow, get_run_logger, task

from weather_recon.fetch_ncei import fetch_station_csv
from weather_recon.flow import NETWORK_RETRIES, _client
from weather_recon.obs import shape_station_rows
from weather_recon.stations import load_stations

FETCH_TIMEOUT = 120.0


@task(**NETWORK_RETRIES)
def fetch_all_observations(stations_path, start, end, cache_dir):
    """Fetch + shape every station serially (NCEI is happier without bursts).

    Task-level retries give the whole sweep another pass on transient NCEI
    failures; the per-(station, window) cache makes that second pass cheap —
    already-fetched stations replay from disk.
    """
    log = get_run_logger()
    stations = load_stations(stations_path)
    cache = Path(cache_dir) if cache_dir else None
    out, empty = [], []
    with httpx.Client(timeout=FETCH_TIMEOUT, follow_redirects=True) as client:
        for i, st in enumerate(stations, 1):
            rows = fetch_station_csv(client, st["isd_id"], start, end, cache)
            shaped = shape_station_rows(rows, st["station_id"])
            if not shaped:
                empty.append(st["station_id"])
            out.extend(shaped)
            if i % 25 == 0:
                log.info("fetched %d/%d stations (%d observations so far)",
                         i, len(stations), len(out))
    log.info("fetched %d observations from %d stations (%d empty: %s)",
             len(out), len(stations) - len(empty), len(empty),
             ", ".join(empty) or "none")
    return out, empty


@task(**NETWORK_RETRIES)
def load_observations_into_directus(observations, run_id, directus_url):
    log = get_run_logger()
    client = _client(directus_url)
    try:
        for name in ("weather_observations",):
            for action in client.ensure_collection(name):
                log.warning("schema change: %s", action)
        deleted = client.delete_all("weather_observations")
        if deleted:
            log.warning("window reload: deleted %d existing observations", deleted)
        rows = [{**o, "run_id": run_id} for o in observations]
        inserted = client.insert_many("weather_observations", rows)
        log.info("weather_observations: inserted %d rows (run_id=%s)",
                 inserted, run_id)
        return inserted
    finally:
        client.close()


@flow(name="load-weather-observations", log_prints=True)
def load_weather_observations(
    start: str = "2001-09-09",
    end: str = "2001-09-12",          # NCEI endDate is inclusive
    stations_path: str = "/app/data/stations.csv",
    cache_dir: str | None = "/tmp/ncei-cache",
    directus_url: str | None = None,
):
    log = get_run_logger()
    run_id = uuid.uuid4().hex
    observations, empty = fetch_all_observations(stations_path, start, end,
                                                 cache_dir)
    n = load_observations_into_directus(observations, run_id, directus_url)
    log.info("done: %d observations in Directus, run_id=%s", n, run_id)
    return {"observations_loaded": n,
            "stations_with_data": len(set(o["station_id"] for o in observations)),
            "stations_empty": empty, "run_id": run_id}


if __name__ == "__main__":
    # Local/dev execution: python -m weather_recon.flow_observations [stations.csv]
    import sys
    path = sys.argv[1] if len(sys.argv) > 1 else "data/stations.csv"
    load_weather_observations(stations_path=path)
