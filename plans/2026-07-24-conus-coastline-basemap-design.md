# CONUS high-fidelity coastline for the Flight Tracker basemap

**Date:** 2026-07-24
**Status:** Design approved
**Area:** `packages/frontend` (map style) + `scripts/build-basemap.md` (offline data build)

## Problem

At building-level zoom the Flight Tracker map places the WTC complex and the Lower
Manhattan financial district in water (see the 2026-07-23 screenshot). The cause is
**data resolution**, not a rendering bug:

- The vector basemap (`world-basemap.pmtiles`) is built from **Natural Earth 1:50m**
  land data, tiled at **tippecanoe zoom 0–7** (`scripts/build-basemap.md`).
- At ~z15 the map overzooms the z7 tile, but NE 50m barely resolves Lower Manhattan
  as a shape — the tip of the island falls *outside* the coarse `land` polygon and
  renders as background, which reads as water.
- Compounding it: in the `classic` palette the `land` fill (`#e3ddcf`) and the
  background/"water" (`#efe9dd`) are nearly the same beige, so even a correct
  coastline wouldn't read as land-vs-water.

The current vector style has only four source-layers — `land`, `lakes`, `countries`,
`states` — and no real coastline/water concept.

## Decisions (from brainstorming)

1. **Coverage:** CONUS gets the high-resolution coastline; the world stays coarse
   (all flights are US domestic; precision only matters where you zoom to city level).
2. **Detail level:** precise coastline geometry **plus** water bodies that read in a
   distinct water color (ocean, harbor, tidal Hudson/East Rivers). No roads/labels.
3. **Approach A** (separate coast PMTiles + water background): lowest risk, no bbox
   seam, world file untouched as rollback.
4. **Execution:** build + upload the new tiles on the dev box (this machine is the
   k3s node and has the video-grabber Wasabi creds); not left as a gated manual step.

## Architecture

Two independent pieces: an offline data artifact and a frontend style change.

### 1. Data artifact — `conus-coast.pmtiles` (offline, gated build)

New section in `scripts/build-basemap.md`. Prerequisite: `tippecanoe` ≥ 2.x
(not currently installed on the box; GDAL/ogr2ogr and the `pmtiles` CLI are present).

Build steps:

1. Download OSM **`land-polygons-split-4326`** from `osmdata.openstreetmap.de` — the
   canonical coastline-derived land mask, precise to individual piers. (Shapefile.)
2. Clip to a generous CONUS bbox with `ogr2ogr`:
   ```
   ogr2ogr -f GeoJSON -clipsrc -125 24 -66 50 conus_land.geojson land_polygons.shp
   ```
3. Tile with tippecanoe, one `land` layer (matching the style contract), z6–15:
   ```
   tippecanoe -o conus-coast.pmtiles -Z6 -z15 \
     -L land:conus_land.geojson \
     --coalesce-densest-as-needed --simplification=4 --force
   ```
4. Sanity-check: PMTiles metadata `vector_layers` lists `land`; a sampled tile over
   NYC decodes to non-empty precise land features.
5. Upload to Wasabi under `maps/conus-coast.pmtiles` (video-grabber creds with boto3
   `request_checksum_calculation="when_required"`, per `storage/wasabi.py`). The
   `/maps` Traefik allow-list already covers it — **no infra change**.
6. Verify: `curl -I -H 'Range: bytes=0-16' https://files.911realtime.org/maps/conus-coast.pmtiles`
   returns `206`.

`world-basemap.pmtiles` is **not modified** — it remains the z0–7 world base and the
rollback.

### 2. Frontend style — `src/lib/basemap/basemapStyles.ts`

- Add `coast` to the `BasemapUrls` interface and `BASEMAP_URLS`
  (`VITE_FLIGHT_COAST_BASEMAP_URL` override; default
  `https://files.911realtime.org/maps/conus-coast.pmtiles`).
- Add a `coast` vector source:
  `{ type: "vector", url: "pmtiles://${urls.coast}" }`.
- Add a **`coast-land`** fill layer: `source: "coast"`, `source-layer: "land"`,
  `paint: { "fill-color": p.land }`, inserted **after** the world `land` layer and
  **before** `lakes` — so precise CONUS land covers the coarse coastline, while
  `lakes`, the hillshade layers, and the `countries`/`states` borders still draw on
  top.
- Change the **classic** palette background + lakes to a muted water tone (living
  tuning numbers, like the rest of the palette):
  - `CLASSIC_LIGHT`: `background: "#aeb9bf"`, `lakes: "#aeb9bf"`
  - `CLASSIC_DARK`: `background: "#12151c"`, `lakes: "#12151c"`
  - Radar and satellite palettes are unchanged (they have their own backgrounds; the
    background is per-style via `basemapPalette`).
- `applyBasemapStyle` recolors `coast-land` (`fill-color` → `p.land`) alongside the
  existing layers, keeping the live style-switch (`applyBasemapStyle`) in exact
  parity with `buildBasemapStyle`.

Rendering model: land is drawn over a water-colored background, so everything that is
not land — ocean, harbor, and the tidal Hudson/East Rivers (which OSM excludes from
the land mask automatically) — reads as water at every zoom. Precise over CONUS,
coarse-but-plausible elsewhere. No bbox seam because water is the background
everywhere, not a clipped fill.

## Contracts preserved

- **Non-fatal basemap:** if `conus-coast.pmtiles` 404s, MapLibre renders empty tiles
  for the `coast` source and the coarse world basemap still shows. Existing
  "basemap failure is non-fatal" contract holds.
- **No `map.setStyle`:** the change is additive to `buildBasemapStyle` /
  `applyBasemapStyle`; app overlay layers (flights, trails, weather radar, 3D
  buildings) are never torn down.
- **Weather app** renders the same shared basemap and inherits the fix for free.
- **Temporal accuracy:** Lower Manhattan and DC shorelines are effectively identical
  to modern OSM (Battery Park City predates 2001; no relevant landfill since 2001),
  so modern OSM coastline is period-correct for this use. Noted in the build doc.

## Testing

- **Unit** (`basemapStyles.test.ts`):
  - `buildBasemapStyle` output includes the `coast` source and a `coast-land` layer;
    `coast-land` is visible in `classic`, sourced from `coast`/`land`, painted `p.land`.
  - `coast-land` is ordered after `land` and before `lakes`.
  - Classic light/dark backgrounds and lakes use the new water tones; radar/satellite
    backgrounds are unchanged.
  - `applyBasemapStyle` sets `coast-land` `fill-color` to `p.land`.
- **Runtime** (frontend:verify / Playwright against the Vite dev server): open Flight
  Tracker, zoom to the WTC, confirm the buildings sit on land and the surrounding
  rivers/harbor read as water. Capture a screenshot for the before/after.

## Out of scope

- Roads, urban land-use, and place labels (would require a planetiler OSM build and
  change the minimalist aesthetic).
- High-resolution coastline outside CONUS (no flights leave the US).
- Rebuilding or replacing `world-basemap.pmtiles`.
