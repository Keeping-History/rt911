# Flight Tracker basemap (na-basemap.pmtiles)

A one-time North America vector basemap for the Flight Tracker app. Regenerate
only when the coastline/border data changes.

## Contract with the app
The style (`packages/frontend/src/Applications/FlightTracker/flightMapStyle.ts`)
expects these vector source-layer names: `land`, `countries`, `states`, `lakes`.
Keep tippecanoe's layer names matching, or the basemap renders blank (planes
still show — basemap failure is non-fatal).

## Build (requires only tippecanoe ≥ 2.x — no pmtiles CLI, no GDAL)
1. Download Natural Earth 1:50m GeoJSON: `ne_50m_land`, `ne_50m_admin_0_countries`,
   `ne_50m_admin_1_states_provinces_lines`, `ne_50m_lakes` — e.g. from the
   `nvkelso/natural-earth-vector` `geojson/` mirror.
2. Build the tiles and write PMTiles in one step, one named layer per file, zoom
   0–7, clipped to the North America bbox `-150,18,-65,65`:
   ```
   tippecanoe -o na-basemap.pmtiles -Z0 -z7 \
     --clip-bounding-box=-150,18,-65,65 \
     -L land:ne_50m_land.geojson \
     -L countries:ne_50m_admin_0_countries.geojson \
     -L states:ne_50m_admin_1_states_provinces_lines.geojson \
     -L lakes:ne_50m_lakes.geojson \
     --coalesce-densest-as-needed --force
   ```
   (~2 MB.) Notes:
   - Use `-L name:file` (named layer per input). Do **not** use `-l name file`
     — a bare `-l` forces *every* input into a single output layer (the last
     name wins), so the archive ends up with only one layer and the map renders
     blank. This is the trap that left the first build with just `lakes`.
   - `--clip-bounding-box` replaces the old `ogr2ogr -clipsrc` step, and
     tippecanoe writes PMTiles directly, so the separate `pmtiles convert` /
     intermediate `.mbtiles` are no longer needed.
3. Sanity-check the layers before uploading — the PMTiles metadata
   `vector_layers` must list all four (`land`, `countries`, `states`, `lakes`),
   and a sampled tile over North America should decode to non-empty features.

## Host (GATED — infra + prod) — DONE 2026-07-08
1. Upload `na-basemap.pmtiles` to the file-proxy's Wasabi bucket
   (`files.911realtime.org`) under `maps/na-basemap.pmtiles`. Use the
   video-grabber Wasabi creds with boto3 `request_checksum_calculation=
   "when_required"` (Wasabi rejects boto3 ≥ 1.36's default checksum header —
   see `storage/wasabi.py`).
2. In the `keeping-history/infra` repo, add a `/maps` path to the file-proxy
   Traefik Ingress allow-list (`apps/file-proxy/ingress.yaml`, mirrors `/images`).
   The nginx-s3-gateway already supports HTTP Range + CORS. Land on infra `main`;
   ArgoCD syncs. If a stale Cloudflare 404 lingers on the URL, it clears on its
   own (CF caches 404s only briefly) or purge it.
3. Verify: `curl -I -H 'Range: bytes=0-16' https://files.911realtime.org/maps/na-basemap.pmtiles`
   returns `206 Partial Content`.
