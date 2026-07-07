# Flight-Reconstruction Pipeline — Design

**Date:** 2026-07-07
**Status:** Approved (spec supplied fully-formed by Robbie; environment confirmed by direct inspection — session ran autonomously, so no interactive design review occurred)

## Goal

Productionize `reconstruct.py` (BTS On-Time → plausible per-flight trajectories keyed to the
replay clock) as a Prefect flow that runs as a Kubernetes Job on the local cluster and lands
its output in Directus. Reconstruction math is wrapped, not changed.

## Confirmed environment (inspected 2026-07-07)

| Question | Answer |
|---|---|
| Prefect version | **3.7.4** (server pod `prefect-server` in ns `video-grabber`) |
| PREFECT_API_URL | `http://prefect-server.video-grabber.svc.cluster.local:4200/api` (UI: prefect-ui.dev.keepinghistory.org) |
| Existing work pools | none — the video-grabber worker uses an in-pod Prefect runner; this project creates the cluster's first Kubernetes work pool |
| Cluster | single-node **k3s** (`dev.keepinghistory.org` — this dev box is the node); Docker 26 on the host |
| Image delivery | `docker build` on host → `docker save … \| sudo k3s ctr -n k8s.io images import -`; job template pins the tag and uses `imagePullPolicy: IfNotPresent`. No registry round-trip needed; GHCR/GitOps can adopt the Dockerfile later. |
| Target namespace | `video-grabber` (co-located with the Prefect server; reuses its Secret material) |
| Directus base URL | `http://rt911-api.rt911.svc.cluster.local:8055` (`directus/directus:latest`, public `api-beta.911realtime.org`) |
| Directus token | `video-grabber-secrets/DIRECTUS_API_TOKEN` (verified working). Copied server-side into a `flight-recon-secrets` Secret — never written to disk or git. |
| Target collections | `flight_positions`, `flight_tracks`, `reconstruction_runs` — **do not exist**; created idempotently by the flow (creation is logged) |
| Sample inputs | absent from the repo; authored as fixtures (`data/airports.csv`, `data/sample_bts_2001-09-09_2001-09-12.csv`) matching the acceptance criteria |

## Deviations from the task brief (on-disk reality)

The brief describes `reconstruct.py` as already having a `--start/--end/--flights/--airports`
CLI and emitting `flight_date`, `clock_seconds`, and `phase`. The file on disk is an earlier
single-day script: hardcoded `DATE = "2001-09-11"`, hardcoded input filenames, no CLI, no
those columns. The "minimal refactor" therefore *adds* the described interface:

- argparse CLI exactly as specified; the script stays runnable standalone.
- Per-row `FlightDate` replaces the `DATE` constant (multi-day windows).
- `flight_date` (from BTS), `clock_seconds` (seconds since ET midnight of the window start,
  continuous across days), and `phase` (climb/cruise/descent, derived from the same
  `CLIMB_FRAC` thresholds `altitude()` already uses) are added to each position row.
- `utc` becomes a full ISO-8601 timestamp (the old `%H:%M:%S` is ambiguous across a
  multi-day window).
- `reconstruct(start, end, flights_path, airports_path) -> (positions, tracks, summary)`
  returns in-memory data; CSV/GeoJSON/PNG writing moves behind the CLI (`--plot` optional).

**Unchanged:** `gc_interp`, `altitude`, `local_hhmm_to_utc` semantics (incl. the 2400
edge case), `et_seconds`, `STEP_SECONDS`/`CRUISE_ALT_FT`/`CLIMB_FRAC` constants, the
skip rules (cancelled, unknown airport, unusable airborne interval), and diverted-endpoint
selection. That is the reconstruction math.

## Architecture

New package `packages/tools/flight-recon/` (mirrors video-grabber's layout):

```
packages/tools/flight-recon/
├── reconstruct.py          # moved from repo root, refactored as above
├── flight_recon/
│   ├── flow.py             # @flow reconstruct-flights + @tasks
│   ├── directus.py         # schema ensure / delete-window / batched insert
│   └── deploy.py           # registers the Prefect deployment on the work pool
├── data/                   # sample fixtures (baked into the image at /app/data)
├── k8s/                    # worker Deployment + SA/RBAC, secret-creation snippet
├── tests/                  # pytest incl. the acceptance-query invariant
├── Dockerfile              # one image for worker AND flow jobs
└── README.md
```

**Flow** `reconstruct-flights(start, end, flights_path, airports_path, run_id=None,
directus_url=env)`:

1. `validate_inputs` — dates parse, start ≤ end, files exist and have required columns.
2. `run_reconstruction` — calls `reconstruct()`; logs flight/position/skip counts.
3. `ensure_schema` — creates missing collections/fields via `/collections`; logs every
   creation (idempotent no-op otherwise). Retries with backoff.
4. `load_positions` / `load_tracks` — **delete-by-window then insert** (see Idempotency);
   chunked `POST /items/{collection}` (2 000 rows/request); retries with backoff.
5. `record_run_summary` — appends one `reconstruction_runs` row (provenance is append-only).

`run_id` defaults to a fresh UUID4 per run; every inserted record carries it.

## Idempotency (the decision that matters)

`run_id` is generated per run, so delete-*by-run_id* alone cannot make re-runs idempotent —
a re-run has a new run_id. Directus's items API also has no upsert / ON CONFLICT for
non-PK natural keys. Chosen strategy:

> **Delete-by-window, then insert.** Before loading, delete `flight_positions` and
> `flight_tracks` rows where `flight_date` falls in `[start, end]` (bulk `DELETE
> /items/{collection}` with a query filter). The deletion is counted and logged before it
> runs. `reconstruction_runs` is never deleted — it keeps the full provenance history, and
> the latest run for a window owns the rows (tagged with its `run_id`).

Re-running the same window therefore replaces rather than duplicates, and partial-failure
re-runs self-heal. The natural keys (positions: `flight+flight_date+clock_seconds`; tracks:
`flight+flight_date`) stay queryable for verification.

## Directus schema

- `flight_positions` — auto-increment id; `flight`, `carrier` (string); `flight_date` (date);
  `utc` (timestamp); `et_seconds`, `clock_seconds`, `alt_ft` (integer); `lat`, `lon` (float);
  `phase` (string); `diverted` (boolean); `run_id` (string, indexed filterable).
- `flight_tracks` — auto id; `flight`, `flight_date`, `origin`, `scheduled_dest`, `landed_at`,
  `wheels_off_utc`, `wheels_on_utc`, `diverted`, `run_id`; **`geometry` (json)** holding the
  GeoJSON LineString geometry object.
- `reconstruction_runs` — `run_id` (string PK); `start`, `end` (date); `source_file` (string);
  `flights_reconstructed`, `positions_count`, `tracks_count`, `skipped_count` (integer);
  `cancelled_by_day` (json); `skipped` (json); `date_created` (Directus-managed).

**GeoJSON as a `json` field, not `geometry`:** `rt911-db` is stock `postgres:16` without
PostGIS, so Directus geometry fields (which want PostGIS for real spatial types) are out.
A `json` column keeps the LineString structured and queryable/renderable by the frontend
(it already consumes JSON over the Directus API), loses only server-side spatial operators
we don't use, and needs no new DB extension.

## Kubernetes topology

- **Work pool** `flight-recon-k8s` (type `kubernetes`), base job template overridden with:
  namespace `video-grabber`, the pinned local image, `imagePullPolicy: IfNotPresent`,
  `envFrom: flight-recon-secrets`, resource requests/limits, `ttlSecondsAfterFinished`.
- **Worker**: in-cluster Deployment `flight-recon-worker` (same image, runs
  `prefect worker start --pool flight-recon-k8s --type kubernetes`), ServiceAccount bound to
  a Role allowing job/pod create-watch in the namespace.
- **Secrets**: `flight-recon-secrets` holds `DIRECTUS_API_TOKEN` (copied server-side from
  `video-grabber-secrets`); config (`DIRECTUS_URL`, `PREFECT_API_URL`) rides in the job
  template env. Nothing sensitive in code, image, or git.
- **Input artifacts**: sample fixtures are baked into the image (`/app/data`). Real monthly
  BTS drops go in a hostPath mount (single-node cluster) documented in the README; the
  flow's `flights_path` parameter points at either.
- Applied with `kubectl apply` directly; the namespace's ArgoCD app doesn't prune untracked
  resources. Manifests live in `k8s/` for later adoption into the infra repo.

## Testing

- Unit tests: math functions untouched (golden values), skip rules, multi-day windowing,
  `clock_seconds` continuity, and the acceptance invariant — fixture yields exactly
  {US800, NW300, AA100, UA50, CO400} at `flight_date=2001-09-11`, `et_seconds=35100`.
- Loader tested against the live Directus from the host (cluster IPs are routable — the box
  is the node), then the full acceptance run through the deployment as a k8s Job, then an
  identical re-run to prove no duplicates.

## Acceptance verification query

```
GET /items/flight_positions?filter[flight_date][_eq]=2001-09-11&filter[et_seconds][_eq]=35100&fields=flight,phase,alt_ft
→ exactly US800, NW300, AA100, UA50, CO400
```
