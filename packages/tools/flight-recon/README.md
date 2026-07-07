# flight-recon

Reconstructs plausible per-flight aircraft trajectories from BTS Airline
On-Time Performance data (great-circle interpolation between actual wheels-off
and wheels-on, diverted flights ending at their diversion airport) and loads
them into Directus, keyed to the 911realtime.org replay clock.

Runs as a Prefect 3 flow on the local k3s cluster: a Kubernetes work pool
(`flight-recon-k8s`) + in-cluster worker spawn one Kubernetes Job per flow run.
The reconstruction math lives in `reconstruct.py`, which also still works as a
standalone CLI.

## Data model (Directus)

Created idempotently by the flow's `ensure_schema` task (every creation is
logged at WARNING level):

| Collection | Contents | Key fields |
|---|---|---|
| `flight_positions` | one row per flight per minute | `flight`, `flight_date`, `utc`, `et_seconds` (secs since ET midnight of that day), `clock_seconds` (continuous secs since window start), `lat`/`lon`/`alt_ft`/`phase`, `diverted`, `run_id` |
| `flight_tracks` | one row per flight | route metadata + `geometry` (GeoJSON LineString), `run_id` |
| `reconstruction_runs` | one row per run, append-only provenance | `run_id` (PK), window, `source_file`, counts, `cancelled_by_day`, `created_at` |

**Why `geometry` is a `json` field, not a Directus `geometry` field:** rt911-db
is stock `postgres:16` without PostGIS, which Directus geometry types want. A
JSON column keeps the LineString structured and queryable — the frontend
consumes it directly over the items API — and we use no server-side spatial
operators, so nothing is lost.

**Directus gotcha (learned the hard way):** `json`-typed fields must be
declared with `meta.special = ["cast-json"]`; without it, `POST /collections`
fails with an opaque 400 (`Validation failed for field "collection"`). Also
avoid rapid-fire schema create/delete churn against this Directus instance —
a burst of collection deletes wedged its in-process schema introspection
("hit infinite loop" on every request) until the pod was restarted.

## Position loading: Postgres COPY fast path

Real windows are millions of position rows, and the Directus items API tops
out around 300 rows/s on rt911-api even with activity logging disabled
(`meta.accountability = null`, which the schema sets — bulk audit rows are
noise; provenance lives in `reconstruction_runs`). The default
`positions_loader="copy"` therefore bulk-COPYs positions straight into the
`flight_positions` table Directus manages (same pattern as the 447k-row pager
tables), using `$RT911_DB_DSN` from the secret. It also ensures the
replay-clock indexes `(flight_date, et_seconds)` and `(clock_seconds)`, which
Directus can't manage. Tracks and the run ledger stay on the items API.
Pass `--param positions_loader=items` to force the pure-API path (fine for
sample-sized loads; hours for real ones).

## Real BTS data

1. Download a monthly PREZIP from TranStats (no API):
   `https://transtats.bts.gov/PREZIP/On_Time_Reporting_Carrier_On_Time_Performance_1987_present_<YYYY>_<M>.zip`
2. Unzip and map onto the input contract (renames
   `Flight_Number_Reporting_Airline`, collapses `Div1..Div5` legs into
   `DivAirport`+`WheelsOn`, handles latin-1):
   `python -m flight_recon.prep_bts --raw <raw.csv> --out /srv/flight-recon-data/bts_2001-09.csv`
3. Airports reference: `/srv/flight-recon-data/airports.csv` was built from
   OpenFlights + IANA tz offsets computed at 2001-09-11 (DST-aware; 5,201
   IATA codes, whole-hour zones).
4. Run with `--param flights_path=/data/bts_2001-09.csv --param airports_path=/data/airports.csv`.

Known source limitation: BTS only records diversion detail (`Div*Airport`/
`Div*WheelsOn`) from 2003 onward — the 584 diverted 9/11 flights have no
recorded landing in the data and are skipped as "no usable airborne
interval" (visible in the run summary's skip list).

## Idempotency

Re-running a window must not duplicate rows. Each run mints a fresh `run_id`
(so delete-by-run_id can't dedupe re-runs), and the Directus items API has no
natural-key upsert. The loader therefore **deletes by window before insert**:
all `flight_positions`/`flight_tracks` rows with `flight_date` inside
`[start, end]` are bulk-deleted (counted and logged first), then the new rows
are inserted tagged with the new `run_id`. `reconstruction_runs` is never
deleted — it's the audit trail of every load.

## Prerequisites

- The in-cluster Prefect server (`video-grabber` namespace, Prefect 3.7.4);
  API at `http://prefect-server.video-grabber.svc.cluster.local:4200/api`
  (UI: prefect-ui.dev.keepinghistory.org).
- Directus at `http://rt911-api.rt911.svc.cluster.local:8055`.
- Docker on the dev node (images are imported straight into k3s containerd —
  there is no registry, hence `imagePullPolicy: IfNotPresent` and the
  `kubernetes.io/hostname: dev.keepinghistory.org` node pin on both the worker
  and the job template).

## Setup

```sh
# 1. Secret — copies DIRECTUS_API_TOKEN from video-grabber-secrets server-side;
#    the token never touches disk or git.
k8s/create-secret.sh

# 2. Image — build and load into the node's containerd (bump the tag when iterating).
docker build -t flight-recon:0.1.1 .
docker save flight-recon:0.1.1 | sudo k3s ctr -n k8s.io images import -

# 3. Work pool (once) — base template pins the node, injects the secret via
#    envFrom, and mounts /srv/flight-recon-data at /data for real BTS drops.
PREFECT_API_URL=http://prefect-server.video-grabber.svc.cluster.local:4200/api \
  prefect work-pool create flight-recon-k8s --type kubernetes \
  --base-job-template k8s/base-job-template.json

# 4. Worker — GitOps: apps/video-grabber/flight-recon-worker.yaml in the
#    keeping-history/infra repo; push to main and ArgoCD rolls it out.
#    (Manual fallback: prefect worker start --pool flight-recon-k8s --type kubernetes)

# 5. Deployment
PREFECT_API_URL=... FLIGHT_RECON_IMAGE=flight-recon:0.1.1 \
  .venv/bin/python -m flight_recon.deploy
```

`FLIGHT_RECON_CRON="0 6 * * 1"` (etc.) on step 5 attaches a schedule; without
it the deployment is manual-run only.

## Running

```sh
PREFECT_API_URL=... prefect deployment run \
  'reconstruct-flights/reconstruct-flights-k8s' \
  --param start=2001-09-09 --param end=2001-09-12 --watch
```

Parameters: `start`, `end`, `flights_path`, `airports_path`, `run_id`
(autogenerated when omitted), `directus_url` (defaults to `$DIRECTUS_URL`).
Defaults point at the sample fixtures baked into the image under `/app/data`.
For a real BTS month, drop the CSV in `/srv/flight-recon-data` on the dev node
and pass `--param flights_path=/data/<file>.csv`. (BTS has no clean API — the
CSV is downloaded manually from TranStats.)

## Verifying

The airborne set at a replay-clock instant — 9:45 AM ET on 9/11 (`et_seconds`
= 9×3600 + 45×60 = 34500 + 600 = 35100):

```
GET /items/flight_positions
    ?filter[flight_date][_eq]=2001-09-11
    &filter[et_seconds][_eq]=35100
    &fields=flight,lat,lon,alt_ft,phase
```

On the sample fixtures this returns exactly US800, NW300, AA100, UA50, CO400.
A track for the map: `GET /items/flight_tracks?filter[flight][_eq]=AA100` —
`geometry` is a ready-to-render GeoJSON LineString. Run provenance:
`GET /items/reconstruction_runs`.

## Local development

```sh
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/pytest tests/ -v           # includes the acceptance invariant
.venv/bin/python reconstruct.py --start 2001-09-09 --end 2001-09-12 \
  --flights data/sample_bts_2001-09-09_2001-09-12.csv \
  --airports data/airports.csv --out-dir out --plot   # CLI still works
```

Prefect quirk (this server): task/flow `retry_delay_seconds` must be a
**scalar** — list values 422 on registration.
