"""
Prefect flow: validate the curated station list and load it into Directus,
creating the three weather collections on the way.

$DIRECTUS_API_TOKEN must be in the environment (weather-recon-secrets k8s
Secret in cluster, kubectl-extracted for local runs — never a parameter,
never logged). directus_url overrides $DIRECTUS_URL.
"""

import os

from prefect import flow, get_run_logger, task

from weather_recon.directus import COLLECTIONS, DirectusClient
from weather_recon.stations import load_stations

# NB: scalar retry_delay_seconds — list-valued delays 422 on this server (see
# packages/tools/video-grabber/CLAUDE.md).
NETWORK_RETRIES = dict(retries=4, retry_delay_seconds=15, retry_jitter_factor=0.3)


def _client(directus_url):
    url = directus_url or os.environ["DIRECTUS_URL"]
    token = os.environ["DIRECTUS_API_TOKEN"]
    return DirectusClient(url, token)


@task
def validate_stations(stations_path):
    log = get_run_logger()
    rows = load_stations(stations_path)
    by_country = {c: sum(1 for r in rows if r["country"] == c) for c in ("US", "CA", "MX")}
    log.info("stations ok: %d rows (%s)", len(rows), by_country)
    return rows


@task(**NETWORK_RETRIES)
def ensure_schema(directus_url):
    log = get_run_logger()
    client = _client(directus_url)
    try:
        for name in COLLECTIONS:
            for action in client.ensure_collection(name):
                log.warning("schema change: %s", action)
        log.info("schema ensured for %s", list(COLLECTIONS))
    finally:
        client.close()


@task(**NETWORK_RETRIES)
def load_stations_into_directus(rows, directus_url):
    log = get_run_logger()
    client = _client(directus_url)
    try:
        deleted = client.delete_all("weather_stations")
        if deleted:
            log.warning("reference-table reload: deleted %d existing stations", deleted)
        inserted = client.insert_many("weather_stations", rows)
        log.info("weather_stations: inserted %d rows", inserted)
        return inserted
    finally:
        client.close()


@flow(name="load-weather-stations", log_prints=True)
def load_weather_stations(
    stations_path: str = "/app/data/stations.csv",
    directus_url: str | None = None,
):
    log = get_run_logger()
    rows = validate_stations(stations_path)
    ensure_schema(directus_url)
    n = load_stations_into_directus(rows, directus_url)
    log.info("done: %d stations in Directus", n)
    return {"stations_loaded": n}


if __name__ == "__main__":
    # Local/dev execution without a deployment: python -m weather_recon.flow
    import sys
    path = sys.argv[1] if len(sys.argv) > 1 else "data/stations.csv"
    load_weather_stations(stations_path=path)
