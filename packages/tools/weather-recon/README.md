# weather-recon

Loads September 2001 weather data into Directus for the rt911 Weather app
(issue #184; design spec: `plans/weather-app-design.md`). Phase 1 ships the
curated station reference table and the three collections; observation /
radar / forecast / almanac flows follow in Phase 2.

## Layout

- `scripts/build_stations.py` — dev-run: NOAA `isd-history.csv` + curated ICAO
  list → `data/stations.csv` (committed). Re-run only to change the curation.
- `weather_recon/flow.py` — `load-weather-stations`: validates the CSV, ensures
  the `weather_stations` / `weather_observations` / `weather_forecasts`
  collections, reloads `weather_stations` (delete-all + insert; ICAO-keyed).
- `weather_recon/directus.py` — REST client + collection specs (ported from
  flight-recon; same 1 MB payload batching and cast-json rules).

## Running locally (no work pool)

    pip install -e ".[dev]"
    export DIRECTUS_URL=...            # e.g. port-forwarded rt911-api
    export DIRECTUS_API_TOKEN=...      # from the rt911 namespace secret
    python -m weather_recon.flow data/stations.csv

## Cluster deployment (mirrors flight-recon; see its k8s/ for templates)

1. Build + import the image into k3s containerd:
   `docker build -t weather-recon:0.1.0 . && docker save weather-recon:0.1.0 | sudo k3s ctr images import -`
2. Infra repo (GitOps): `weather-recon-k8s` work pool, worker Deployment
   running this image, and a `weather-recon-secrets` Secret providing
   `DIRECTUS_API_TOKEN` — copy the flight-recon manifests.
3. Register the deployment: see `weather_recon/deploy.py` docstring.

## Tests

    pytest tests/ -v
    ruff check weather_recon/ tests/ scripts/
