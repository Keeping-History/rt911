# Flight Tracker basemap (world-basemap.pmtiles)

A one-time world vector basemap for the Flight Tracker/Weather apps.
Regenerate only when the coastline/border data changes.

> **History:** the original build was clipped to a North America bbox
> (`na-basemap.pmtiles`). Globe mode (issue #220, 2026-07) made the coverage
> cliff visible, so the shipped file is now the unclipped **world** build
> below; `na-basemap.pmtiles` stays hosted as a rollback
> (`VITE_FLIGHT_BASEMAP_URL` can point back at it).

## Contract with the app
The style (`packages/frontend/src/Applications/FlightTracker/flightMapStyle.ts`)
expects these vector source-layer names: `land`, `countries`, `states`, `lakes`.
Keep tippecanoe's layer names matching, or the basemap renders blank (planes
still show — basemap failure is non-fatal).

## Build (requires only tippecanoe ≥ 2.x — no pmtiles CLI, no GDAL)
1. Download Natural Earth 1:50m GeoJSON: `ne_50m_land`, `ne_50m_admin_0_countries`,
   `ne_50m_admin_1_states_provinces_lines`, `ne_50m_lakes` — e.g. from the
   `nvkelso/natural-earth-vector` `geojson/` mirror.
2. Build the tiles and write PMTiles in one step, one named layer per file,
   zoom 0–7, world coverage (no clip):
   ```
   tippecanoe -o world-basemap.pmtiles -Z0 -z7 \
     -L land:ne_50m_land.geojson \
     -L countries:ne_50m_admin_0_countries.geojson \
     -L states:ne_50m_admin_1_states_provinces_lines.geojson \
     -L lakes:ne_50m_lakes.geojson \
     --coalesce-densest-as-needed --force
   ```
   (~16 MB. For an NA-clipped build add `--clip-bounding-box=-150,18,-65,65`
   — that's the original ~2 MB `na-basemap.pmtiles`.) Notes:
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
3. Verify: `curl -I -H 'Range: bytes=0-16' https://files.911realtime.org/maps/world-basemap.pmtiles`
   returns `206 Partial Content`.

## Glyph fonts (cluster-count labels) — DONE 2026-07-15

Symbol text layers (the Flight Tracker cluster counts, issue #222) need glyph
PBFs at the style's `glyphs` URL,
`https://files.911realtime.org/maps/fonts/{fontstack}/{range}.pbf`. The
hosted set is `Noto Sans Regular` (256 range files), copied verbatim from the
`maplibre/demotiles` repo's `font/` directory and uploaded to the same Wasabi
bucket under `maps/fonts/`:

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/maplibre/demotiles.git
cd demotiles && git sparse-checkout set font
# upload font/"Noto Sans Regular"/*.pbf → s3://files.911realtime.org/maps/fonts/Noto Sans Regular/
```

Missing fonts are non-fatal: labels just don't draw. Verify:
`curl -I 'https://files.911realtime.org/maps/fonts/Noto%20Sans%20Regular/0-255.pbf'` → 200.

## CONUS coastline overlay (conus-coast.pmtiles) — DONE 2026-07-24

The world basemap above is Natural Earth 1:50m at z0–7. At city zoom the app
overzooms that coarse z7 coastline, so Lower Manhattan (WTC/financial district)
and other coastal cities render in "water". This overlay adds a precise
OpenStreetMap coastline for the continental US, layered **over** the coarse
world basemap by the style (`src/lib/basemap/basemapStyles.ts`): a `coast`
vector source whose single **`land`** source-layer draws on top of the world
`land` layer, so the precise CONUS shoreline wins at high zoom. The world file
is untouched and stays the low-zoom base + rollback.

> **Prereqs:** `tippecanoe` ≥ 2.x **and** GDAL/`ogr2ogr` (the OSM source is a
> shapefile — unlike the Natural-Earth world build, this one needs GDAL).

### Build
1. Download OSM land polygons (coastline-derived land mask, precise to piers)
   and unzip — it expands to `land-polygons-split-4326/land_polygons.shp`:
   ```sh
   curl -fL -o land-polygons-split-4326.zip \
     https://osmdata.openstreetmap.de/download/land-polygons-split-4326.zip
   unzip land-polygons-split-4326.zip
   ```
2. Clip to a generous CONUS bbox (`-125 24 -66 50`; excludes AK/HI by design —
   no flights there) → GeoJSON (~178 MB; ~30 s):
   ```sh
   ogr2ogr -f GeoJSON conus_land.geojson \
     land-polygons-split-4326/land_polygons.shp -clipsrc -125 24 -66 50
   ```
3. Tile to PMTiles, one `land` layer, **z6–15**, attributes dropped:
   ```sh
   tippecanoe -o conus-coast.pmtiles -Z6 -z15 -X \
     -L land:conus_land.geojson \
     --coalesce-densest-as-needed --simplification=4 --force
   ```
   - **Max zoom 15.** An earlier z13 build put Manhattan on land but the
     coastline was visibly *jagged/faceted* at building zoom (z15–16), because
     MapLibre overzooms the z13 geometry 4–8× and its ~14 m vertex spacing shows
     as facets. z15 (~3.5 m vertices) renders smooth at building zoom. MapLibre
     reads maxzoom from the PMTiles header and overzooms automatically, so the
     style needs no maxzoom setting.
   - **`simplification=4`, not lower.** At z15, `=4` (~5 m tolerance) is already
     visually crisp; `=2` bloats the archive with near-every OSM vertex for no
     visible gain.
   - **`-X` drops all feature attributes** — the style only fills geometry, so
     the OSM FIDs would be pure tile bloat.
   - Result: **~51 MB**, but the tiling is slow (~1 h; heavy on the whole US
     coast + Great Lakes at z15).
   - ⚠️ **Do not judge the size mid-run.** tippecanoe's *intermediate* working
     file grows huge (it hit ~900 MB during this build) and only compacts to the
     final ~51 MB in its last clustering pass — watching the in-progress `.pmtiles`
     size and killing it as a "runaway" is a mistake (it cost two aborted builds
     here). Wait for tippecanoe to exit and check the final size then.
4. Sanity-check before uploading — the `land` layer is present, a Lower-
   Manhattan tile decodes to non-empty land, and an offshore tile is empty:
   ```sh
   pmtiles show --metadata conus-coast.pmtiles   # vector_layers → ["land"], z6–15
   pmtiles tile conus-coast.pmtiles 15 9648 12318 | wc -c   # WTC tile → >0 bytes
   pmtiles tile conus-coast.pmtiles 15 12000 12319 | wc -c  # mid-Atlantic → 0 bytes
   ```

### Host (GATED — prod)
1. Upload to Wasabi under `maps/conus-coast.pmtiles` with the video-grabber
   Wasabi creds (`WASABI_ACCESS_KEY_ID`/`WASABI_SECRET_ACCESS_KEY` in the
   `video-grabber-secrets` k8s secret) and boto3 `request_checksum_calculation
   ="when_required"` (Wasabi rejects boto3 ≥ 1.36's default checksum header —
   see `storage/wasabi.py`). Endpoint `https://s3.us-central-1.wasabisys.com`,
   bucket `files.911realtime.org`.
2. **No infra change:** the `/maps` path is already on the file-proxy Traefik
   allow-list (added for the world basemap).
3. ⚠️ **Purge Cloudflare for the URL after any re-upload.** Overwriting the same
   key changes the whole byte layout, so a client (or edge) holding cached
   ranges from the old archive reads them at the new file's offsets → corrupt
   tiles. Purge with `CF_API_TOKEN`/`CF_ZONE_ID` (also in `video-grabber-secrets`):
   ```sh
   curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache" \
     -H "Authorization: Bearer ${CF_API_TOKEN}" -H "Content-Type: application/json" \
     --data '{"files":["https://files.911realtime.org/maps/conus-coast.pmtiles"]}'
   ```
   Same filename ⇒ **no app redeploy needed** — clients fetch the new tiles from
   the same URL. (A `cf-cache-status: MISS` on the next HEAD confirms the purge.)
4. Verify: `curl -I -H 'Range: bytes=0-16' https://files.911realtime.org/maps/conus-coast.pmtiles`
   returns `206 Partial Content`; a full `curl -I` shows the new `content-length`
   (~51 MB) and a fresh `etag` (with CORS `access-control-allow-origin: *`).

### Notes
- **App wiring:** the style reads `VITE_FLIGHT_COAST_BASEMAP_URL` (default the
  hosted file above) and adds the `coast` source + `coast-land` fill; a missing
  file is non-fatal (MapLibre renders empty tiles, the coarse world coastline
  still shows). The classic palette's background/lakes are water-toned so land
  reads against water. Regenerate only when the coastline data changes.
- **2001 accuracy:** Lower Manhattan and DC shorelines are effectively identical
  to modern OSM (Battery Park City predates 2001; no relevant landfill since),
  so the modern OSM coastline is period-correct for this use.
