"""
Prefect flow: archived ZFP zone forecasts -> Directus weather_forecasts.

One row per product segment: wfo, zone = comma-joined EXPANDED zone ids,
product_type ZFP, issued_at from the WMO header (UTC), raw_text = the full
segment (UGC + area names + local time line + forecast text). Idempotent
full reload (delete_all + insert) — the collection is exactly this window.
sdate is 09-08 so a "latest issued <= clock" product exists at 09-09 00:00Z.

The stored `wfo` is always the MODERN cwa from stations.csv (that's what the
CSV joins on) — fetch_afos.fetch_wfo_products resolves the 2001-era AFOS PIL
internally, so callers here never see the override.
"""

import uuid
from pathlib import Path

import httpx
from prefect import flow, get_run_logger, task

from weather_recon.afos import parse_wmo_issued, split_products, split_segments
from weather_recon.fetch_afos import fetch_wfo_products
from weather_recon.flow import NETWORK_RETRIES, _client
from weather_recon.stations import load_stations


@task(**NETWORK_RETRIES)
def fetch_and_parse(stations_path, sdate, edate, cache_dir):
    log = get_run_logger()
    wfos = sorted({s["wfo"] for s in load_stations(stations_path) if s["wfo"]})
    cache = Path(cache_dir) if cache_dir else None
    rows, empty_wfos = [], []
    year, month = int(sdate[:4]), int(sdate[5:7])
    with httpx.Client(timeout=120, follow_redirects=True) as client:
        for i, wfo in enumerate(wfos, 1):
            text = fetch_wfo_products(client, wfo, sdate, edate, cache)
            products = split_products(text)
            if not products:
                empty_wfos.append(wfo)
                continue
            for prod in products:
                issued = parse_wmo_issued(prod, year, month)
                for seg in split_segments(prod):
                    if not seg["zones"]:
                        continue
                    rows.append({"wfo": wfo, "zone": ",".join(seg["zones"]),
                                 "product_type": "ZFP", "issued_at": issued,
                                 "raw_text": seg["text"]})
            if i % 10 == 0:
                log.info("parsed %d/%d WFOs (%d segments)", i, len(wfos), len(rows))
    log.info("parsed %d segment rows from %d WFOs (%d empty: %s)",
             len(rows), len(wfos) - len(empty_wfos), len(empty_wfos),
             ", ".join(empty_wfos) or "none")
    return rows, empty_wfos


@task(**NETWORK_RETRIES)
def load_forecasts_into_directus(rows, run_id, directus_url):
    log = get_run_logger()
    client = _client(directus_url)
    try:
        for action in client.ensure_collection("weather_forecasts"):
            log.warning("schema change: %s", action)
        deleted = client.delete_all("weather_forecasts")
        if deleted:
            log.warning("window reload: deleted %d existing forecasts", deleted)
        inserted = client.insert_many(
            "weather_forecasts", [{**r, "run_id": run_id} for r in rows], chunk=500)
        log.info("weather_forecasts: inserted %d rows (run_id=%s)", inserted, run_id)
        return inserted
    finally:
        client.close()


@flow(name="load-weather-forecasts", log_prints=True)
def load_weather_forecasts(
    sdate: str = "2001-09-08",
    edate: str = "2001-09-13",     # retrieve.py edate behaves end-exclusive-ish; window covers 09-08..09-12 issuances
    stations_path: str = "/app/data/stations.csv",
    cache_dir: str | None = "/tmp/afos-cache",
    directus_url: str | None = None,
):
    log = get_run_logger()
    run_id = uuid.uuid4().hex
    rows, empty = fetch_and_parse(stations_path, sdate, edate, cache_dir)
    n = load_forecasts_into_directus(rows, run_id, directus_url)
    log.info("done: %d forecast segments in Directus, run_id=%s", n, run_id)
    return {"forecasts_loaded": n, "wfos_empty": empty, "run_id": run_id}


if __name__ == "__main__":
    import sys
    path = sys.argv[1] if len(sys.argv) > 1 else "data/stations.csv"
    load_weather_forecasts(stations_path=path)
