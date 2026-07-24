# CONUS High-Fidelity Coastline Basemap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Flight Tracker map rendering the WTC/Lower-Manhattan financial district in water by layering a precise OSM-derived CONUS coastline over the coarse world basemap and giving the classic style a real water-vs-land contrast.

**Architecture:** A new offline tile artifact `conus-coast.pmtiles` (OSM `land-polygons-split-4326`, clipped to CONUS, tippecanoe z6–15) is added as a second vector source. The classic palette's background+lakes become a muted water tone, and a new `coast-land` fill draws the precise land over that water background — so ocean, harbor and the tidal Hudson/East Rivers all read as water, precise over CONUS and coarse-but-plausible elsewhere. The existing `world-basemap.pmtiles` is untouched (rollback).

**Tech Stack:** MapLibre GL + PMTiles, TypeScript/React (Vite), Vitest; GDAL/ogr2ogr + tippecanoe + pmtiles CLI + boto3 for the offline build.

**Spec:** `plans/2026-07-24-conus-coastline-basemap-design.md`

## Global Constraints

- All clock/data invariants in `packages/frontend/CLAUDE.md` are irrelevant here; this change is basemap-only.
- **Non-fatal basemap contract:** a missing/404 basemap source must never blank the map or throw — MapLibre renders empty tiles and the coarse world basemap still shows.
- **No `map.setStyle`:** changes are additive to `buildBasemapStyle`/`applyBasemapStyle` only; overlay layers (flights, trails, weather radar, 3D buildings) are never torn down.
- **`applyBasemapStyle` must mirror `buildBasemapStyle` exactly** — any layer added to one is handled by the other (live style-switch parity).
- Water tones (tunable, living numbers): classic light `#aeb9bf`, classic dark `#12151c` (used for both `background` and `lakes`). Radar/satellite palettes unchanged.
- Coast source id: `coast`; source-layer: `land`; layer id: `coast-land`; env override: `VITE_FLIGHT_COAST_BASEMAP_URL`; default `https://files.911realtime.org/maps/conus-coast.pmtiles`.
- CONUS clip bbox: `-125 24 -66 50` (lon/lat; excludes AK/HI by design).
- Run frontend commands from repo root via pnpm filters, e.g. `pnpm --filter @rt911/frontend exec vitest run src/lib/basemap/basemapStyles.test.ts`.

---

## File Structure

- `packages/frontend/src/lib/basemap/basemapStyles.ts` — the only production file changed: palette values, `BasemapUrls`/`BASEMAP_URLS`, `buildBasemapStyle` (coast source + `coast-land` layer), `applyBasemapStyle` (recolor + toggle `coast-land`).
- `packages/frontend/src/lib/basemap/basemapStyles.test.ts` — unit tests + `URLS` fixture gets a `coast` field.
- `packages/frontend/src/Applications/FlightTracker/FlightMap.test.tsx` — `TEST_URLS` fixture gets a `coast` field (type compile).
- `packages/frontend/src/Applications/Weather/WeatherMap.test.tsx` — `TEST_URLS` fixture gets a `coast` field (type compile).
- `scripts/build-basemap.md` — new "CONUS coastline overlay" build section.

No changes needed in `FlightTracker.tsx`/`Weather.tsx` (both already pass `BASEMAP_URLS`, which will carry the new `coast` field automatically).

---

### Task 1: Water-tone the classic palette

**Files:**
- Modify: `packages/frontend/src/lib/basemap/basemapStyles.ts` (`CLASSIC_LIGHT` ~64-70, `CLASSIC_DARK` ~71-77)
- Test: `packages/frontend/src/lib/basemap/basemapStyles.test.ts`

**Interfaces:**
- Consumes: existing `basemapPalette(mapStyle, darkMap)`.
- Produces: classic palette whose `background` and `lakes` are the water tones; radar/satellite unchanged.

- [ ] **Step 1: Write the failing test** — add to the existing `describe("basemapPalette", ...)` block in `basemapStyles.test.ts`:

```ts
it("classic uses a water-toned background and lakes; radar/satellite unchanged", () => {
	expect(basemapPalette("classic", false).background).toBe("#aeb9bf");
	expect(basemapPalette("classic", false).lakes).toBe("#aeb9bf");
	expect(basemapPalette("classic", true).background).toBe("#12151c");
	expect(basemapPalette("classic", true).lakes).toBe("#12151c");
	// unchanged
	expect(basemapPalette("radar", false).background).toBe("#041004");
	expect(basemapPalette("satellite", false).background).toBe("#0b1b33");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/lib/basemap/basemapStyles.test.ts -t "water-toned"`
Expected: FAIL — receives old `#efe9dd` / `#d7d3c6`.

- [ ] **Step 3: Write minimal implementation** — edit `CLASSIC_LIGHT` and `CLASSIC_DARK` in `basemapStyles.ts`:

```ts
const CLASSIC_LIGHT: BasemapPalette = {
	background: "#aeb9bf",
	land: "#e3ddcf",
	lakes: "#aeb9bf",
	countries: "#8a8574",
	states: "#b3ad9c",
};
const CLASSIC_DARK: BasemapPalette = {
	background: "#12151c",
	land: "#26262e",
	lakes: "#12151c",
	countries: "#6f6f7e",
	states: "#44444f",
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/lib/basemap/basemapStyles.test.ts`
Expected: PASS (whole file — confirm no other palette assertion regressed).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/lib/basemap/basemapStyles.ts packages/frontend/src/lib/basemap/basemapStyles.test.ts
git commit -m "feat(flight-tracker): water-tone the classic basemap palette"
```

---

### Task 2: Add the `coast` source and `coast-land` layer to `buildBasemapStyle`

**Files:**
- Modify: `packages/frontend/src/lib/basemap/basemapStyles.ts` (`BasemapUrls` ~10-15, `BASEMAP_URLS` ~19-34, `buildBasemapStyle` sources ~255-281 and layers ~282-304)
- Modify (fixtures, for type compile): `packages/frontend/src/lib/basemap/basemapStyles.test.ts` (`URLS` ~17-22), `packages/frontend/src/Applications/FlightTracker/FlightMap.test.tsx` (`TEST_URLS` ~196-201), `packages/frontend/src/Applications/Weather/WeatherMap.test.tsx` (`TEST_URLS` ~105-110)
- Test: `packages/frontend/src/lib/basemap/basemapStyles.test.ts`

**Interfaces:**
- Consumes: `BasemapUrls`, `basemapPalette`, `groundVisibility`.
- Produces: `buildBasemapStyle` output containing `sources.coast` (`{ type: "vector", url: "pmtiles://<coast>" }`) and a layer `{ id: "coast-land", source: "coast", "source-layer": "land" }` ordered after `land` and before `lakes`, painted `p.land`, layout visibility = `g.vector`; `BasemapUrls` now has a required `coast: string`; `BASEMAP_URLS.coast` defaults to the hosted file.

- [ ] **Step 1: Add `coast` to the three test fixtures first** (so the file type-checks once `BasemapUrls` gains the field). In each fixture object add a line:

`basemapStyles.test.ts` `URLS`:
```ts
	coast: "https://x.example/coast.pmtiles",
```
`FlightMap.test.tsx` `TEST_URLS` and `WeatherMap.test.tsx` `TEST_URLS`:
```ts
	coast: "coast.pmtiles",
```

- [ ] **Step 2: Write the failing test** — add a new `describe` block to `basemapStyles.test.ts`:

```ts
describe("coast overlay (CONUS coastline)", () => {
	const style = buildBasemapStyle(URLS, "classic", false);

	it("adds the coast vector source", () => {
		expect(style.sources.coast).toEqual({
			type: "vector",
			url: "pmtiles://https://x.example/coast.pmtiles",
		});
	});

	it("adds a coast-land fill ordered after land and before lakes", () => {
		const ids = style.layers.map((l) => l.id);
		expect(ids).toContain("coast-land");
		expect(ids.indexOf("coast-land")).toBeGreaterThan(ids.indexOf("land"));
		expect(ids.indexOf("coast-land")).toBeLessThan(ids.indexOf("lakes"));
	});

	it("paints coast-land with the land color and shows it wherever the vector ground shows", () => {
		const layer = style.layers.find((l) => l.id === "coast-land");
		expect(layer).toMatchObject({
			source: "coast",
			"source-layer": "land",
			paint: { "fill-color": basemapPalette("classic", false).land },
			layout: { visibility: "visible" },
		});
	});

	it("hides coast-land in satellite mode (raster is the ground)", () => {
		const sat = buildBasemapStyle(URLS, "satellite", false);
		const layer = sat.layers.find((l) => l.id === "coast-land");
		expect(layer?.layout?.visibility).toBe("none");
	});

	it("BASEMAP_URLS.coast defaults to the hosted conus-coast file", () => {
		expect(BASEMAP_URLS.coast).toContain("/maps/conus-coast.pmtiles");
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/lib/basemap/basemapStyles.test.ts -t "coast overlay"`
Expected: FAIL — `style.sources.coast` is undefined / `coast-land` not found / `BASEMAP_URLS.coast` undefined.

- [ ] **Step 4: Write the implementation** in `basemapStyles.ts`:

Add to the `BasemapUrls` interface:
```ts
	coast: string;
```
Add to `BASEMAP_URLS` (after `vector`):
```ts
	coast:
		(import.meta.env.VITE_FLIGHT_COAST_BASEMAP_URL as string | undefined) ??
		// CONUS-only high-res OSM coastline (issue: WTC-in-water). Layered over
		// the coarse world vector; world stays the z0-7 base + rollback.
		"https://files.911realtime.org/maps/conus-coast.pmtiles",
```
Add the source inside `sources` (after `basemap`):
```ts
	coast: { type: "vector", url: `pmtiles://${urls.coast}` },
```
Insert the layer in `layers` immediately after the `land` layer and before `lakes`:
```ts
	{ id: "coast-land", type: "fill", source: "coast", "source-layer": "land",
		layout: vis(g.vector), paint: { "fill-color": p.land } },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/lib/basemap/basemapStyles.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/lib/basemap/basemapStyles.ts \
  packages/frontend/src/lib/basemap/basemapStyles.test.ts \
  packages/frontend/src/Applications/FlightTracker/FlightMap.test.tsx \
  packages/frontend/src/Applications/Weather/WeatherMap.test.tsx
git commit -m "feat(flight-tracker): layer CONUS OSM coastline over the world basemap"
```

---

### Task 3: Make `applyBasemapStyle` recolor and toggle `coast-land` (live-switch parity) + full green gate

**Files:**
- Modify: `packages/frontend/src/lib/basemap/basemapStyles.ts` (`applyBasemapStyle` ~316-347)
- Test: `packages/frontend/src/lib/basemap/basemapStyles.test.ts`

**Interfaces:**
- Consumes: `applyBasemapStyle(map, mapStyle, darkMap, terrainEnabled)`, the `recordingMap()` stub already in the test file, `basemapPalette`, `groundVisibility`.
- Produces: on every live switch, `coast-land` `fill-color` is set to `p.land` and its `visibility` to `g.vector` — mirroring `buildBasemapStyle`.

- [ ] **Step 1: Write the failing test** — add to `describe("applyBasemapStyle", ...)`:

```ts
it("recolors coast-land and shows it in classic, hides it in satellite", () => {
	const classicMap = recordingMap();
	applyBasemapStyle(classicMap, "classic", false);
	expect(classicMap.layout["coast-land"].visibility).toBe("visible");
	expect(classicMap.paint["coast-land"]["fill-color"]).toBe(
		basemapPalette("classic", false).land,
	);

	const satMap = recordingMap();
	applyBasemapStyle(satMap, "satellite", false);
	expect(satMap.layout["coast-land"].visibility).toBe("none");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/lib/basemap/basemapStyles.test.ts -t "recolors coast-land"`
Expected: FAIL — `classicMap.layout["coast-land"]` is undefined.

- [ ] **Step 3: Write the implementation** — in `applyBasemapStyle`, alongside the existing `land`/`lakes` handling (after the `map.setPaintProperty("land", ...)` and the `setLayoutProperty("land"/"lakes", ...)` lines):

```ts
	map.setPaintProperty("coast-land", "fill-color", p.land);
	map.setLayoutProperty("coast-land", "visibility", g.vector ? "visible" : "none");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/lib/basemap/basemapStyles.test.ts`
Expected: PASS.

- [ ] **Step 5: Full typecheck + lint + suite gate** (last code change — prove the whole frontend is green before touching data)

Run: `pnpm --filter @rt911/frontend exec tsc -b`
Expected: no errors.
Run: `pnpm --filter @rt911/frontend exec eslint src/lib/basemap src/Applications/FlightTracker src/Applications/Weather`
Expected: clean.
Run: `pnpm --filter @rt911/frontend exec vitest run src/lib/basemap/basemapStyles.test.ts src/Applications/FlightTracker/FlightMap.test.tsx src/Applications/Weather/WeatherMap.test.tsx`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/lib/basemap/basemapStyles.ts packages/frontend/src/lib/basemap/basemapStyles.test.ts
git commit -m "feat(flight-tracker): apply coast-land on live basemap style switch"
```

---

### Task 4: Build, upload, and document `conus-coast.pmtiles`

Operational task (no unit test — the deliverable is a hosted artifact + a reproducible recipe). Work in the scratchpad dir `/tmp/claude-1001/-home-robbiebyrd-rt911/e57fc8ba-f37d-4105-ae75-4f58d51b38c6/scratchpad`.

**Files:**
- Create (hosted): `s3://.../maps/conus-coast.pmtiles` on Wasabi (`files.911realtime.org`)
- Modify: `scripts/build-basemap.md` (new section)

- [ ] **Step 1: Install tippecanoe** (not present on the box; GDAL + pmtiles CLI already are)

```bash
git clone --depth 1 https://github.com/felt/tippecanoe /tmp/tippecanoe && \
  make -C /tmp/tippecanoe -j"$(nproc)" && sudo make -C /tmp/tippecanoe install
tippecanoe --version
```
Expected: prints a version ≥ 2.x.

- [ ] **Step 2: Download OSM land polygons and clip to CONUS**

```bash
cd "$SCRATCH"
curl -L -o land-polygons-split-4326.zip \
  https://osmdata.openstreetmap.de/download/land-polygons-split-4326.zip
unzip -o land-polygons-split-4326.zip
ogr2ogr -f GeoJSON -clipsrc -125 24 -66 50 conus_land.geojson \
  land-polygons-split-4326/land_polygons.shp
```
Expected: `conus_land.geojson` written, non-trivial size (hundreds of MB is fine — it's split polygons).

- [ ] **Step 3: Tile to PMTiles (z6–15, one `land` layer)**

```bash
tippecanoe -o conus-coast.pmtiles -Z6 -z15 \
  -L land:conus_land.geojson \
  --coalesce-densest-as-needed --simplification=4 --force
```
Expected: writes `conus-coast.pmtiles` (tens of MB order).

- [ ] **Step 4: Sanity-check the archive** — `land` layer present and NYC tile non-empty

```bash
pmtiles show conus-coast.pmtiles | grep -A3 -i "vector_layers\|land"
# z15 tile covering Lower Manhattan (~ -74.013, 40.71): x=9649 y=12319 at z15
pmtiles tile conus-coast.pmtiles 15 9649 12319 | wc -c
```
Expected: metadata lists layer `land`; the tile byte count is > 0 (decodes to precise land near the WTC).

- [ ] **Step 5: Upload to Wasabi** using the video-grabber creds + the Wasabi checksum workaround (see `packages/tools/video-grabber/video_grabber/storage/wasabi.py`)

```bash
python3 - <<'PY'
import os, boto3
from botocore.config import Config
s = boto3.client("s3",
    endpoint_url=os.environ["WASABI_ENDPOINT"],
    aws_access_key_id=os.environ["WASABI_ACCESS_KEY"],
    aws_secret_access_key=os.environ["WASABI_SECRET_KEY"],
    config=Config(request_checksum_calculation="when_required"))
s.upload_file("conus-coast.pmtiles", os.environ["WASABI_BUCKET"],
    "maps/conus-coast.pmtiles", ExtraArgs={"ContentType": "application/octet-stream"})
print("uploaded")
PY
```
(Resolve the four `WASABI_*` env values from the video-grabber secret at execution time.)
Expected: prints `uploaded`.

- [ ] **Step 6: Verify the hosted URL serves range requests**

```bash
curl -I -H 'Range: bytes=0-16' https://files.911realtime.org/maps/conus-coast.pmtiles
```
Expected: `206 Partial Content` (retry after a minute if a stale CF 404 lingers).

- [ ] **Step 7: Document the recipe** — append a "CONUS coastline overlay (`conus-coast.pmtiles`)" section to `scripts/build-basemap.md` capturing Steps 1–6 verbatim, plus these notes: the app contract (source `coast`, source-layer `land`, layers draw over the coarse world `land`); GDAL/ogr2ogr is now a build prereq (unlike the world build); 2001 accuracy (Lower Manhattan/DC shorelines match modern OSM — Battery Park City predates 2001, no relevant landfill since); the archive is CONUS-only by design (bbox `-125 24 -66 50`, no AK/HI).

- [ ] **Step 8: Commit the doc**

```bash
git add scripts/build-basemap.md
git commit -m "docs: build recipe for conus-coast.pmtiles CONUS coastline overlay"
```

---

### Task 5: Runtime verification (frontend:verify)

Verification only — no code, no commit. Confirms the real map renders correctly against the now-hosted artifact.

**REQUIRED SUB-SKILL:** Use `packages/frontend:verify` to launch and drive the desktop.

- [ ] **Step 1:** Start the Vite dev server (`pnpm dev`) per the verify skill and open the app.
- [ ] **Step 2:** Open the Flight Tracker app; ensure the classic style + light map are active.
- [ ] **Step 3:** Zoom/pan to Lower Manhattan (the WTC/financial district) at building zoom.
- [ ] **Step 4:** Confirm visually: the WTC and financial-district buildings sit on **land** (land-toned fill), and the Hudson River, East River, and harbor render in the **water** tone. Take a screenshot.
- [ ] **Step 5:** Toggle Dark Map and (optionally) Satellite/Radar to confirm the switch is clean — no torn-down overlays, coast-land hidden under satellite imagery, water tone correct in dark mode.
- [ ] **Step 6:** If anything is off (e.g. seam, wrong z, tile 404), capture console/network evidence and stop for review rather than patching blind.

---

## Self-Review

**1. Spec coverage:**
- Data artifact `conus-coast.pmtiles` (OSM land, CONUS clip, z6–15, upload, verify) → Task 4. ✓
- `coast` on `BasemapUrls`/`BASEMAP_URLS` + `VITE_FLIGHT_COAST_BASEMAP_URL` → Task 2. ✓
- `coast` vector source + `coast-land` fill after `land` before `lakes`, paint `p.land`, visibility `g.vector` → Task 2. ✓
- Classic water-tone background+lakes; radar/satellite unchanged → Task 1. ✓
- `applyBasemapStyle` live-switch parity → Task 3. ✓
- Non-fatal + no-setStyle contracts → additive-only design, asserted structurally in Tasks 2–3, exercised in Task 5. ✓
- Weather inherits the fix (shared basemap) → no code change needed; `TEST_URLS` updated in Task 2; verified conceptually. ✓
- Temporal-accuracy note + build doc → Task 4 Step 7. ✓
- Unit tests (source/layer/order/paint/backgrounds/apply) → Tasks 1–3. Runtime WTC-on-land verify → Task 5. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows exact code; the only runtime-resolved values are the `WASABI_*` creds (explicitly flagged) and the NYC tile x/y (given as concrete numbers). ✓

**3. Type consistency:** `coast` (string) added to `BasemapUrls` and all three fixtures before use (Task 2 Step 1); ids/paths consistent — source `coast`, source-layer `land`, layer `coast-land`, env `VITE_FLIGHT_COAST_BASEMAP_URL` — identical across Tasks 2, 3, 4. `g.vector`/`p.land` come from existing `groundVisibility`/`basemapPalette`. ✓
