# Flight Tracker 3D terrain + hillshade — design

**Date:** 2026-07-16
**Status:** Implemented 2026-07-16 (see plans/flight-map-3d-terrain-plan.md; archive shipped at z0–10, terrain exaggeration raised to ALT_EXAGGERATION post-verification)
**Scope:** `packages/frontend` (FlightTracker + shared basemap), one new DEM archive on Wasabi, a `scripts/` build doc.
**Companion spec:** [satellite-imagery-global-period-design.md](satellite-imagery-global-period-design.md) — independent data pipeline; neither blocks the other.

## Goal

Add topographic detail to the Flight Tracker map, in both forms MapLibre offers:

- **Hillshade** — shaded relief visible in every view, including flat/top-down.
- **True 3D terrain** (`map.setTerrain`) — the ground mesh rises when the camera pitches, under the existing 3D planes and track tubes.

Both effects apply to **all three basemap styles** (classic, radar, satellite) and their dark variants, are driven by **one self-hosted DEM source**, and are controlled by **one persisted toolbar toggle** (default on).

## Non-goals

- No vertical-exaggeration slider (fixed value; set to ALT_EXAGGERATION post-verification — see below).
- No terrain for the Weather app map (shares `lib/basemap`; may opt in later — this design must not preclude it).
- No contour-line rendering.
- No change to the plane-altitude exaggeration model (`ALT_EXAGGERATION = 10` stays).

## Data: `terrain-dem.pmtiles`

One new archive at `https://files.911realtime.org/maps/terrain-dem.pmtiles`:

- **Encoding:** terrarium (`raster-dem` `"encoding": "terrarium"`).
- **Extent:** North-America bbox `[-150, 18, -65, 65]` — matches the satellite archives.
- **Zoom:** 0–10 over the bbox (z11 measured 36 GB vs z10's 12 GB during the build; MapLibre overzooms raster-dem past native max acceptably — see scripts/build-terrain-dem.md for the size table).
- **Production (preferred):** `pmtiles extract` from Mapterhorn's published planet terrain archive (terrarium, 512px tiles). Mapterhorn's site rejected automated fetches during design; verify the archive URL/licensing at implementation time.
- **Production (fallback):** assemble from AWS Open Data `elevation-tiles-prod` terrarium PNGs (no auth) → mbtiles → pmtiles.
- **Docs:** build steps recorded in `scripts/build-terrain-dem.md`, beside `scripts/build-satellite-basemap.md`. Attribution string recorded in the source spec (Mapterhorn aggregates USGS 3DEP and other open DEMs).
- **Ops note:** `files.911realtime.org` is an allow-listed proxy (Traefik Ingress path rules) — confirm `/maps/` already passes the new object through (it should; existing pmtiles live there).

## Style: extend the shared basemap superset (`lib/basemap/basemapStyles.ts`)

The superset-style contract is preserved: every source/layer always present, active look expressed via paint + visibility, live switches via `applyBasemapStyle()` — never `map.setStyle()`.

- **New source** `terrain`: `{ type: "raster-dem", url: "pmtiles://…/terrain-dem.pmtiles", encoding: "terrarium", tileSize: 512, bounds: NA_BBOX }`. URL override via `VITE_TERRAIN_DEM_URL`, following `BASEMAP_URLS`.
- **Three hillshade layers**, one per style, inserted after the ground layers (`satellite-day`/`satellite-night`/`lakes`) and before `countries`:
  - `hillshade-classic` — neutral shading; shadow/highlight colors per light/dark palette so relief reads on both paper and slate grounds.
  - `hillshade-radar` — phosphor tint: shadows toward `#020c02`, highlight/accent toward the scope greens (`#2f9e4f` family), reading as terrain clutter on a radar scope.
  - `hillshade-satellite` — subtle dark shading over imagery (low `hillshade-exaggeration`), same layer serves day and night tones via paint.
- **Visibility XOR** extends the `groundVisibility` pattern: exactly one hillshade layer visible when terrain is enabled, zero when disabled. `visibility: "none"` layers fetch no tiles, so DEM bytes download only when the toggle is on.
- `applyBasemapStyle()` mirrors every new paint/visibility mutation exactly (it takes a new `terrainEnabled` parameter or a widened options object — implementation's choice, tests enforce the mirror).
- A `hillshadePalette(mapStyle, darkMap)` helper (same shape as `basemapPalette`) keeps the per-style×tone paint values testable as pure data.

## Control: `terrain` toggle

- New `terrain: boolean` in `FlightMapSettings` (`flightMapSettings.ts`), **default `true`**, persisted with the existing per-field-fallback merge (no migration needed).
- Toggle button in `MapControls` beside `globe`/`cluster`/`threeD`, same interaction/visual conventions (issues #218/#222/#223 lineage).
- Effect in `FlightMap`:
  - **On:** active style's hillshade visible; `map.setTerrain({ source: "terrain", exaggeration: ALT_EXAGGERATION })` (10× — updated 2026-07-16: 1× terrain read as disproportionately flat against the 10×-exaggerated flights, so the mesh shares the aircraft factor).
  - **Off:** all hillshade hidden; `map.setTerrain(null)`.
- Terrain works under both mercator and globe projection (MapLibre v5); no coupling to the `globe` or `threeD` toggles.
- The Weather map passes no terrain flag and gets today's behavior unchanged.

## Coexistence with custom 3D layers

- **No geometry can ever be buried.** `alt_ft` values are MSL and all 3D geometry renders at `ALT_EXAGGERATION = 10`× while terrain shares the same 10× factor (originally 1×; raised 2026-07-16 for proportionality). Ground elevation at any point is ≤ the MSL altitude of anything at or above that ground, so scaling both by the same factor keeps `10×alt_ft ≥ 10×terrain` everywhere — including landed planes at high-elevation airports and the notables' crash-site samples. No `queryTerrainElevation` offsets are needed (an earlier draft proposed them; the exaggeration asymmetry makes them dead code).
- **2D layers** (plane icons, replay-trail circles, cluster circles, trails, track line) drape onto the terrain mesh automatically — MapLibre's render-to-texture pass handles them.
- `projectTileFor3D` already abstracts mercator/globe projection for the custom layers; terrain alters the ground mesh and depth buffer, not their coordinate pipeline. A mountain between the camera and a tube/plane may now correctly occlude it.
- **Risk:** custom-layer depth interaction with MapLibre's terrain render-to-texture pass is the least-documented corner. Mitigation: verify early in implementation with a pitched-over-Rockies smoke test; if depth artifacts appear, fall back to enabling the 3D mesh only while `threeD` mode is active (hillshade stays global) — a one-line policy change in the toggle effect.

## Error handling

- Missing/failed DEM tiles are non-fatal, matching the existing basemap contract: hillshade simply doesn't draw; `setTerrain` with an unavailable source must not take the map down (verify; guard the call if needed).

## Testing

- `basemapStyles.test.ts`: hillshade palette per style×tone; superset style contains the `terrain` source + three hillshade layers; `applyBasemapStyle` recording-stub mirror covers hillshade visibility/paint and the terrain flag.
- `flightMapSettings.test.ts`: default `terrain: true`; stored partial state merges.
- `FlightMap.test.tsx`: maplibre mock grows `setTerrain`; assert setTerrain called with the source on toggle-on and null on toggle-off.
- Browser verification (`packages/frontend:verify`): pitched Rockies in all three styles × dark variants, mercator + globe; toggle off restores today's flat look.
