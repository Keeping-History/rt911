# building-recon

Reconstructs the 2001 Lower Manhattan and Pentagon/Arlington skylines by fetching
building footprints from open-data portals, filtering to the state as of
September 11, 2001, restoring the curated World Trade Center complex (absent from
source datasets), and publishing both a Wasabi GeoJSON snapshot and a Directus
collection for the frontend 3D visualization.

Runs as a Prefect 3 flow on the local k3s cluster: a Kubernetes work pool
(`building-recon-k8s`) + in-cluster worker spawn one Kubernetes Job per flow run.

## Data model (Directus)

Created idempotently by the flow (collection deletion + full re-insert on each run):

| Collection | Contents | Key fields |
|---|---|---|
| `buildings` | one row per 2001 building polygon | `geometry` (GeoJSON Polygon), `height_m`, `base_elevation_m`, `area` (manhattan/pentagon), `source` (nyc/arlington/wtc-curated), `name`, `cnstrct_yr` |

Directus is the **canonical** store: the flow builds `buildings` rows from the
rich, pre-strip feature list (`build_2001.assemble`'s second return value, via
`directus.rows_from_building_features`), so `source`, `name`, and `cnstrct_yr`
are always populated (`cnstrct_yr` is `null` only where the source portal
didn't supply one — e.g. the curated WTC complex, which has no construction
year since it predates the open-data feeds). The Wasabi GeoJSON snapshot
(`maps/buildings-2001.geojson`) is a separate, deliberately **stripped**
projection built from the same assembly: the frontend contract is exactly
three properties (`height_m`, `base_elevation_m`, `area`) and must stay that
way — see `build_2001.build_feature_collection()` and
`tests/test_geojson_contract.py`.

**Why `geometry` is a `json` field, not a Directus `geometry` field:** rt911-db
is stock `postgres:16` without PostGIS, which Directus geometry types want. A
JSON column keeps the footprint structured and queryable — the frontend
consumes it directly over the items API — and we use no server-side spatial
operators, so nothing is lost.

**Directus gotcha (learned the hard way):** `json`-typed fields must be
declared with `meta.special = ["cast-json"]`; without it, `POST /collections`
fails with an opaque 400 (`Validation failed for field "collection"`).

## Areas of interest

Two impact-zone bounding boxes filter which buildings are fetched:

- **Manhattan:** Lower Manhattan from Battery Park north to City Hall, centered
  on the World Trade Center site (`-74.020, 40.701 to -74.002, 40.720`).
- **Pentagon:** Pentagon proper and immediate Arlington surroundings
  (`-77.064, 38.865 to -77.048, 38.876`). This AOI is entirely in Arlington, VA
  (west of the Potomac); DC data is not used.

## Data sources and field confirmation

Source field names + geometry were confirmed against live metadata on
2026-07-24 (URLs are hardcoded in `sources.py::SOURCES`; re-confirm each run to
catch upstream schema changes):

- **NYC (Socrata `5zhs-2jue`, Building Footprints):** `height_roof` (feet),
  `construction_year` (integer), `ground_elevation` (feet, base elevation).
  Geometry is **MultiPolygon** (the parser takes the first sub-polygon's outer
  ring). Fetched via `within_box()` SoQL against
  `https://data.cityofnewyork.us/resource/5zhs-2jue.geojson`.

- **Arlington (ArcGIS `od_Building_Height_Polygons`, "Building Heights"):**
  `Est_Building_Height_ft` (feet), `Est_Ground_Elevation_ft` (feet); the layer
  carries **no construction year**, so all its buildings are kept by the 2001
  filter (unknown-year → kept). Geometry is Polygon. This layer includes the
  Pentagon at its real ~77 ft height. Fetched via an ArcGIS envelope query
  (`f=geojson`) against
  `https://arlgis.arlingtonva.us/arcgis/rest/services/Open_Data/od_Building_Height_Polygons/FeatureServer/0`.

DC (ArcGIS Building Heights 1999) was evaluated and **dropped**: the Pentagon is
in Arlington, VA, so DC footprints fall outside the pentagon AOI entirely.

## World Trade Center provenance

The four hijacked planes destroyed a significant portion of the WTC complex on
9/11/2001. NYC's open-data footprints do not include buildings demolished after
2001, so the destroyed structures are restored from curated, publicly documented
heights:

- **1 WTC (North Tower):** 417 m (1,368 ft)
- **2 WTC (South Tower):** 415 m (1,362 ft)
- **7 WTC:** 174 m (570 ft)
- **3 WTC (Marriott):** 73 m (240 ft)
- **4 WTC (American Express):** 36 m (119 ft)
- **5 WTC:** 40 m (132 ft)
- **6 WTC (US Custom House):** 27 m (89 ft)

These are stored in `data/wtc_complex_2001.geojson` (committed, reviewed) and
loaded via `build_2001.load_wtc_complex()` regardless of source fetch results.

## 2001 filter policy

The 2001 skyline reconstruction works as follows:

1. **Drop known-post-2001 buildings:** Rows with `cnstrct_yr > 2001` are
   excluded from all sources.
2. **Keep unknown-year buildings:** Rows with missing construction year are
   kept: the vast majority of unknown-year footprints in these two zones predate
   2001, and demolished structures we care about are re-added explicitly
   (the WTC complex), never inferred from a null year.
3. **Restore curated WTC:** Load the seven WTC buildings from the committed
   GeoJSON and append to the normalized result, overwriting any partial source
   records.

See `build_2001.py::keep_for_2001()` and `build_2001.assemble()` for the exact
logic (unit-tested).

## Prerequisites

- The in-cluster Prefect server (`video-grabber` namespace, Prefect 3.7.4);
  API at `http://prefect-server.video-grabber.svc.cluster.local:4200/api`
  (UI: prefect-ui.dev.keepinghistory.org).
- Directus at `http://rt911-api.rt911.svc.cluster.local:8055`.
- Docker on the dev node (images are imported straight into k3s containerd —
  there is no registry, hence `imagePullPolicy: IfNotPresent` and the
  `kubernetes.io/hostname: dev.keepinghistory.org` node pin on the job template).
- Source URLs (NYC Socrata, Arlington ArcGIS) are hardcoded in
  `sources.py::SOURCES` — no per-source env vars are required.

## Setup

```sh
# 1. Secret — copies DIRECTUS_API_TOKEN + other credentials from video-grabber-secrets
#    and external URLs; the token never touches disk or git.
k8s/create-secret.sh

# 2. Image — build and load into the node's containerd (bump the tag when iterating).
docker build -t building-recon:0.1.0 .
docker save building-recon:0.1.0 | sudo k3s ctr -n k8s.io images import -

# 3. Work pool (once) — base template pins the node, injects the secret via
#    envFrom, and sets environment variables.
PREFECT_API_URL=http://prefect-server.video-grabber.svc.cluster.local:4200/api \
  prefect work-pool create building-recon-k8s --type kubernetes \
  --base-job-template k8s/base-job-template.json

# 4. Worker — GitOps: apps/video-grabber/building-recon-worker.yaml in the
#    keeping-history/infra repo; push to main and ArgoCD rolls it out.
#    (Manual fallback: prefect worker start --pool building-recon-k8s --type kubernetes)

# 5. Deployment (manual run only — no cron schedule)
PREFECT_API_URL=... BUILDING_RECON_IMAGE=building-recon:0.1.0 \
  .venv/bin/python -m building_recon.deploy
```

## Running

```sh
PREFECT_API_URL=... prefect deployment run \
  'reconstruct-2001-buildings/reconstruct-2001-buildings-k8s' \
  --watch
```

Parameters (defaults are sample fixtures baked into the image):
- `directus_url`: Directus API URL (default: `$DIRECTUS_URL`)
- `sources`: List of source names to fetch (default: `["nyc", "arlington"]`)
- `upload`: Whether to upload the GeoJSON to Wasabi (default: `True`)
- `load_directus`: Whether to load the buildings collection to Directus
  (default: `True`)

## Verifying

Query the buildings collection after a successful run:

```
GET /items/buildings
    ?filter[area][_eq]=manhattan
    &fields=name,height_m,source
```

`name` and `source` are populated for every row (the canonical store is built
from the rich feature list, not the stripped Wasabi GeoJSON — see "Data model"
above), so this query returns real values rather than nulls. Expected sources:
`nyc`, `wtc-curated`. Check one WTC building by name to verify height
restoration.

## Cloudflare cache purge

After publishing a new GeoJSON to Wasabi, the `purge.purge_urls()` call triggers
a Cloudflare cache purge (via `CF_API_TOKEN` + `CF_ZONE_ID` in the secret).
Confirm the purge completed by checking the published Wasabi URL in a browser.

## Local development

```sh
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/pytest tests/ -v

# Pure CLI (no Prefect, no network, no DB):
.venv/bin/python build_2001.py   # (imports only; see tests/ for examples)
```

## Deployment: GitOps and never `kubectl set image`

Worker Deployments are managed by ArgoCD via manifests in the **separate**
`github.com/Keeping-History/infra` repository under `apps/video-grabber/`.

**NEVER manually run `kubectl set image` or edit resources in the cluster:**
`automated.selfHeal: true` means any imperative cluster edit gets reverted
within seconds. Landing on `main` and letting the infra repo's automation +
ArgoCD sync do its thing is the correct way to ship.

See `packages/tools/flight-recon/README.md`'s "Deployment: GitOps" section for
full mechanics — the same pattern applies here.
