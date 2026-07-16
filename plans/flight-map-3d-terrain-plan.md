# Flight Tracker 3D Terrain + Hillshade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add hillshade relief and true 3D terrain (`map.setTerrain`) to the Flight Tracker map, on all three basemap styles, from one self-hosted terrarium DEM PMTiles archive, behind one persisted toolbar toggle.

**Architecture:** One `raster-dem` source and three per-style hillshade layers join the shared basemap superset style (`lib/basemap/basemapStyles.ts`), expressed — like everything else there — as always-present layers whose look is pure paint + visibility. A new `terrain: boolean` in `FlightMapSettings` drives a MapControls toggle; FlightMap turns it into hillshade visibility (via the existing `applyMapColors` path) and a `setTerrain` call. No custom-layer geometry changes: 10×-exaggerated MSL altitudes always clear 1× terrain (see spec).

**Tech Stack:** MapLibre GL JS v5 (`raster-dem`, `hillshade`, `setTerrain`), PMTiles, React 19, Vitest + RTL, Classicy UI.

**Spec:** `plans/flight-map-3d-terrain-design.md` — read it first. Companion (do NOT implement here): `plans/satellite-imagery-global-period-design.md`.

## Global Constraints

- Never call `map.setStyle()` for style changes — live switches are paint/visibility via `applyBasemapStyle`/`applyMapColors` only (tears down app overlay layers otherwise).
- `buildBasemapStyle` and `applyBasemapStyle` must stay exact mirrors; tests enforce this.
- Weather app (`WeatherMap.tsx`) behavior must be unchanged — new parameters default to today's behavior (`terrainEnabled = false`); do not edit WeatherMap.
- New settings merge via the existing per-field-fallback in `readFlightMapSettings` — no migrations.
- Terrain source id is `"terrain"`; archive URL `https://files.911realtime.org/maps/terrain-dem.pmtiles`, env override `VITE_TERRAIN_DEM_URL`.
- Vertical exaggeration is fixed at `1` — no slider, no option.
- Tile fetches must not happen while the toggle is off (`visibility: "none"` + no `setTerrain`).
- Hillshade colors are living tuning values — tests guard structure (keys defined, exactly-one-visible), never exact color strings, matching the sky-spec test convention.
- Missing DEM tiles are non-fatal: map must render normally if the archive 404s.
- Run all frontend commands from the repo root with `pnpm --filter @rt911/frontend exec …`.
- Commit after every task; the classicy version bump riding along in `pnpm-lock.yaml` from the pre-commit hook is expected.

---

### Task 1: `terrain` flag in FlightMapSettings

**Files:**
- Modify: `packages/frontend/src/Applications/FlightTracker/flightMapSettings.ts`
- Test: `packages/frontend/src/Applications/FlightTracker/flightMapSettings.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `FlightMapSettings.terrain: boolean` (default `true`) — read by Tasks 5–6.

- [ ] **Step 1: Write the failing test**

In `flightMapSettings.test.ts`, find the existing `describe`/`it` block asserting defaults (it checks e.g. `globe: false`) and add alongside it:

```ts
it("defaults terrain on and honors a stored false", () => {
	expect(readFlightMapSettings(undefined).terrain).toBe(true);
	expect(readFlightMapSettings({ mapSettings: { terrain: false } }).terrain).toBe(false);
	// Pre-terrain stored state (no key at all) upgrades to the default.
	expect(readFlightMapSettings({ mapSettings: { globe: true } }).terrain).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/FlightTracker/flightMapSettings.test.ts`
Expected: FAIL — `terrain` is `undefined`, not `true`.

- [ ] **Step 3: Implement**

In `flightMapSettings.ts`, extend the interface (after `threeD: boolean;`):

```ts
	// Topographic relief (hillshade + 3D ground mesh) — one switch for both.
	terrain: boolean;
```

and the defaults object (after `threeD: false,`):

```ts
	terrain: true,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/FlightTracker/flightMapSettings.test.ts`
Expected: PASS (all tests in file).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/FlightTracker/flightMapSettings.ts packages/frontend/src/Applications/FlightTracker/flightMapSettings.test.ts
git commit -m "feat(flight-tracker): terrain flag in persisted map settings"
```

---

### Task 2: Hillshade palette + visibility helpers

**Files:**
- Modify: `packages/frontend/src/lib/basemap/basemapStyles.ts`
- Test: `packages/frontend/src/lib/basemap/basemapStyles.test.ts`

**Interfaces:**
- Consumes: `BasemapStyleId`, `BasemapTone`, `effectiveTone` (existing).
- Produces (used by Tasks 3–4):
  - `interface HillshadePalette { shadow: string; highlight: string; accent: string; exaggeration: number }`
  - `hillshadePalette(mapStyle: BasemapStyleId, darkMap: boolean): HillshadePalette`
  - `interface HillshadeVisibility { classic: boolean; radar: boolean; satellite: boolean }`
  - `hillshadeVisibility(mapStyle: BasemapStyleId, terrainEnabled: boolean): HillshadeVisibility`

- [ ] **Step 1: Write the failing tests**

Add to `basemapStyles.test.ts` (import `hillshadePalette` and `hillshadeVisibility` in the header import list):

```ts
describe("hillshadePalette", () => {
	it("every style×tone provides a complete palette (colors are hand-tuned, not pinned)", () => {
		for (const style of ALL_STYLES) {
			for (const dark of [false, true]) {
				const p = hillshadePalette(style, dark);
				expect(typeof p.shadow).toBe("string");
				expect(typeof p.highlight).toBe("string");
				expect(typeof p.accent).toBe("string");
				expect(p.exaggeration).toBeGreaterThan(0);
				expect(p.exaggeration).toBeLessThanOrEqual(1);
			}
		}
	});
	it("radar ignores darkMap and its shading stays in the phosphor family", () => {
		expect(hillshadePalette("radar", true)).toEqual(hillshadePalette("radar", false));
	});
	it("classic tones differ so relief reads on both paper and slate", () => {
		expect(hillshadePalette("classic", true)).not.toEqual(hillshadePalette("classic", false));
	});
});

describe("hillshadeVisibility", () => {
	it("terrain off hides every hillshade layer", () => {
		for (const style of ALL_STYLES) {
			expect(hillshadeVisibility(style, false)).toEqual({
				classic: false, radar: false, satellite: false,
			});
		}
	});
	it("terrain on shows exactly the active style's layer", () => {
		expect(hillshadeVisibility("classic", true)).toEqual({
			classic: true, radar: false, satellite: false,
		});
		expect(hillshadeVisibility("radar", true)).toEqual({
			classic: false, radar: true, satellite: false,
		});
		expect(hillshadeVisibility("satellite", true)).toEqual({
			classic: false, radar: false, satellite: true,
		});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @rt911/frontend exec vitest run src/lib/basemap/basemapStyles.test.ts`
Expected: FAIL — `hillshadePalette is not a function` (import error).

- [ ] **Step 3: Implement**

In `basemapStyles.ts`, after the `skyFor` function, add:

```ts
// Hillshade relief (3D-terrain feature): per-style shading so topography reads
// as part of each look — neutral on classic, phosphor clutter on radar, a
// subtle deepening on satellite imagery. Values are living tuning numbers.
export interface HillshadePalette {
	shadow: string;
	highlight: string;
	accent: string;
	exaggeration: number;
}

const HILLSHADE_CLASSIC_LIGHT: HillshadePalette = {
	shadow: "#6b6250", highlight: "#ffffff", accent: "#8a8574", exaggeration: 0.35,
};
const HILLSHADE_CLASSIC_DARK: HillshadePalette = {
	shadow: "#000000", highlight: "#565664", accent: "#44444f", exaggeration: 0.4,
};
const HILLSHADE_RADAR: HillshadePalette = {
	shadow: "#020c02", highlight: "#2f9e4f", accent: "#1e6434", exaggeration: 0.5,
};
const HILLSHADE_SAT_DAY: HillshadePalette = {
	shadow: "#000000", highlight: "#ffffff", accent: "#000000", exaggeration: 0.15,
};
const HILLSHADE_SAT_NIGHT: HillshadePalette = {
	shadow: "#000000", highlight: "#1a2338", accent: "#000000", exaggeration: 0.2,
};

export function hillshadePalette(
	mapStyle: BasemapStyleId,
	darkMap: boolean,
): HillshadePalette {
	const tone = effectiveTone(mapStyle, darkMap);
	if (mapStyle === "radar") return HILLSHADE_RADAR;
	if (mapStyle === "satellite")
		return tone === "dark" ? HILLSHADE_SAT_NIGHT : HILLSHADE_SAT_DAY;
	return tone === "dark" ? HILLSHADE_CLASSIC_DARK : HILLSHADE_CLASSIC_LIGHT;
}

export interface HillshadeVisibility {
	classic: boolean;
	radar: boolean;
	satellite: boolean;
}

/** Exactly one hillshade layer visible while terrain is on; zero while off. */
export function hillshadeVisibility(
	mapStyle: BasemapStyleId,
	terrainEnabled: boolean,
): HillshadeVisibility {
	return {
		classic: terrainEnabled && mapStyle === "classic",
		radar: terrainEnabled && mapStyle === "radar",
		satellite: terrainEnabled && mapStyle === "satellite",
	};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @rt911/frontend exec vitest run src/lib/basemap/basemapStyles.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/lib/basemap/basemapStyles.ts packages/frontend/src/lib/basemap/basemapStyles.test.ts
git commit -m "feat(basemap): hillshade palette and visibility helpers"
```

---

### Task 3: DEM source + hillshade layers in the superset style

**Files:**
- Modify: `packages/frontend/src/lib/basemap/basemapStyles.ts`
- Test: `packages/frontend/src/lib/basemap/basemapStyles.test.ts`

**Interfaces:**
- Consumes: Task 2's helpers.
- Produces (used by Tasks 4–5):
  - `BasemapUrls.terrainDem: string` (new required field) and `BASEMAP_URLS.terrainDem`
  - `export const TERRAIN_SOURCE = "terrain"`
  - `buildBasemapStyle(urls, mapStyle, darkMap, terrainEnabled = false)` — 4th param, default preserves Weather behavior
  - Style layers `hillshade-classic` / `hillshade-radar` / `hillshade-satellite` between `lakes` and `countries`

- [ ] **Step 1: Write the failing tests**

In `basemapStyles.test.ts`, first extend the `URLS` fixture (it's typed against `BasemapUrls`, so the build breaks without this):

```ts
const URLS = {
	vector: "https://x.example/na.pmtiles",
	satelliteDay: "https://x.example/day.pmtiles",
	satelliteNight: "https://x.example/night.pmtiles",
	terrainDem: "https://x.example/dem.pmtiles",
};
```

Update the existing layer-order test to the new expected order:

```ts
	it("orders layers background → rasters → land/lakes → hillshades → countries/states", () => {
		expect(style.layers.map((l) => l.id)).toEqual([
			"background", "satellite-day", "satellite-night",
			"land", "lakes",
			"hillshade-classic", "hillshade-radar", "hillshade-satellite",
			"countries", "states",
		]);
	});
```

Add new tests:

```ts
describe("terrain source + hillshade layers", () => {
	it("BASEMAP_URLS includes the terrain DEM archive", () => {
		expect(BASEMAP_URLS.terrainDem).toContain("/maps/terrain-dem.pmtiles");
	});

	it("declares a terrarium raster-dem source bounded to NA", () => {
		const style = buildBasemapStyle(URLS, "classic", false);
		const dem = style.sources[TERRAIN_SOURCE] as {
			type: string; url: string; encoding: string; tileSize: number; bounds: number[];
		};
		expect(dem.type).toBe("raster-dem");
		expect(dem.url).toBe("pmtiles://https://x.example/dem.pmtiles");
		expect(dem.encoding).toBe("terrarium");
		expect(dem.tileSize).toBe(512);
		expect(dem.bounds).toEqual([-150, 18, -65, 65]);
	});

	it("bakes hillshade visibility from the terrain flag (default off)", () => {
		const vis = (style: ReturnType<typeof buildBasemapStyle>, id: string) =>
			(style.layers.find((l) => l.id === id) as { layout?: { visibility?: string } })
				.layout?.visibility;
		const off = buildBasemapStyle(URLS, "radar", false);
		expect(vis(off, "hillshade-classic")).toBe("none");
		expect(vis(off, "hillshade-radar")).toBe("none");
		expect(vis(off, "hillshade-satellite")).toBe("none");
		const on = buildBasemapStyle(URLS, "radar", false, true);
		expect(vis(on, "hillshade-radar")).toBe("visible");
		expect(vis(on, "hillshade-classic")).toBe("none");
		expect(vis(on, "hillshade-satellite")).toBe("none");
	});

	it("each hillshade layer carries its own style's palette", () => {
		const style = buildBasemapStyle(URLS, "classic", true, true);
		const paint = (id: string) =>
			(style.layers.find((l) => l.id === id) as { paint: Record<string, unknown> }).paint;
		expect(paint("hillshade-radar")["hillshade-shadow-color"]).toBe(
			hillshadePalette("radar", true).shadow,
		);
		expect(paint("hillshade-classic")["hillshade-exaggeration"]).toBe(
			hillshadePalette("classic", true).exaggeration,
		);
	});
});
```

Add `TERRAIN_SOURCE` to the test file's import list.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @rt911/frontend exec vitest run src/lib/basemap/basemapStyles.test.ts`
Expected: FAIL — no `TERRAIN_SOURCE` export; layer-order mismatch.

- [ ] **Step 3: Implement**

In `basemapStyles.ts`:

1. Extend `BasemapUrls` and `BASEMAP_URLS`:

```ts
export interface BasemapUrls {
	vector: string;
	satelliteDay: string;
	satelliteNight: string;
	terrainDem: string;
}
```

```ts
	terrainDem:
		(import.meta.env.VITE_TERRAIN_DEM_URL as string | undefined) ??
		"https://files.911realtime.org/maps/terrain-dem.pmtiles",
```

2. Near `NA_BBOX`, add:

```ts
/** Source id for the raster-dem archive — shared by hillshade and setTerrain. */
export const TERRAIN_SOURCE = "terrain";

const hillshadePaint = (p: HillshadePalette) => ({
	"hillshade-shadow-color": p.shadow,
	"hillshade-highlight-color": p.highlight,
	"hillshade-accent-color": p.accent,
	"hillshade-exaggeration": p.exaggeration,
});
```

3. Give `buildBasemapStyle` the 4th parameter and wire the source + layers:

```ts
export function buildBasemapStyle(
	urls: BasemapUrls,
	mapStyle: BasemapStyleId,
	darkMap: boolean,
	terrainEnabled = false,
): StyleSpecification {
	const p = basemapPalette(mapStyle, darkMap);
	const g = groundVisibility(mapStyle, darkMap);
	const h = hillshadeVisibility(mapStyle, terrainEnabled);
```

In `sources`, after `"satellite-night"`:

```ts
			// Terrarium DEM (3D-terrain feature). Fetches nothing until a
			// hillshade layer is visible or setTerrain names it.
			[TERRAIN_SOURCE]: {
				type: "raster-dem",
				url: `pmtiles://${urls.terrainDem}`,
				encoding: "terrarium",
				tileSize: 512,
				bounds: NA_BBOX,
				attribution: "Mapterhorn",
			},
```

In `layers`, between the `lakes` and `countries` entries:

```ts
			// One hillshade per style: relief shading tuned to each look. Exactly
			// one is visible while the terrain toggle is on (hillshadeVisibility).
			{ id: "hillshade-classic", type: "hillshade", source: TERRAIN_SOURCE,
				layout: vis(h.classic), paint: hillshadePaint(hillshadePalette("classic", darkMap)) },
			{ id: "hillshade-radar", type: "hillshade", source: TERRAIN_SOURCE,
				layout: vis(h.radar), paint: hillshadePaint(hillshadePalette("radar", darkMap)) },
			{ id: "hillshade-satellite", type: "hillshade", source: TERRAIN_SOURCE,
				layout: vis(h.satellite), paint: hillshadePaint(hillshadePalette("satellite", darkMap)) },
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @rt911/frontend exec vitest run src/lib/basemap/basemapStyles.test.ts` — expected: PASS.
Run: `pnpm build` (root; runs `tsc -b`) — expected: clean. WeatherMap compiles untouched because it consumes the shared `BASEMAP_URLS` object and the new parameter defaults to `false`.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/lib/basemap/basemapStyles.ts packages/frontend/src/lib/basemap/basemapStyles.test.ts
git commit -m "feat(basemap): terrarium raster-dem source and per-style hillshade layers"
```

---

### Task 4: Live-switch mirror (`applyBasemapStyle` + `applyMapColors`)

**Files:**
- Modify: `packages/frontend/src/lib/basemap/basemapStyles.ts:219-236` (applyBasemapStyle)
- Modify: `packages/frontend/src/Applications/FlightTracker/flightMapStyle.ts:68-99` (FlightMapColors, applyMapColors)
- Test: `packages/frontend/src/lib/basemap/basemapStyles.test.ts`, `packages/frontend/src/Applications/FlightTracker/flightMapStyle.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces (used by Task 5):
  - `applyBasemapStyle(map, mapStyle, darkMap, terrainEnabled = false)`
  - `FlightMapColors.terrain: boolean` (new required field)
  - `applyMapColors` forwards `colors.terrain` into `applyBasemapStyle`

- [ ] **Step 1: Write the failing tests**

In `basemapStyles.test.ts`, inside the `describe("applyBasemapStyle")` block:

```ts
	it("terrain on shows only the active style's hillshade and re-tints it", () => {
		const map = recordingMap();
		applyBasemapStyle(map, "satellite", true, true);
		expect(map.layout["hillshade-satellite"].visibility).toBe("visible");
		expect(map.layout["hillshade-classic"].visibility).toBe("none");
		expect(map.layout["hillshade-radar"].visibility).toBe("none");
		expect(map.paint["hillshade-satellite"]["hillshade-shadow-color"]).toBe(
			hillshadePalette("satellite", true).shadow,
		);
	});

	it("terrain default (off) hides every hillshade layer", () => {
		const map = recordingMap();
		applyBasemapStyle(map, "classic", false);
		expect(map.layout["hillshade-classic"].visibility).toBe("none");
		expect(map.layout["hillshade-radar"].visibility).toBe("none");
		expect(map.layout["hillshade-satellite"].visibility).toBe("none");
	});
```

In `flightMapStyle.test.ts`, find the existing `applyMapColors` test block (it uses a recording-map helper equivalent to the one above) and add — extending every existing `applyMapColors` call site in the file with `terrain: false` in its colors object to satisfy the type:

```ts
	it("forwards the terrain flag to the shared basemap switch", () => {
		const map = recordingMap();
		applyMapColors(map, {
			mapStyle: "radar", darkMap: false,
			pinColor: "#ffd700", notablePinColor: "#ff4d4d",
			terrain: true,
		});
		expect(map.layout["hillshade-radar"].visibility).toBe("visible");
		expect(map.layout["hillshade-classic"].visibility).toBe("none");
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @rt911/frontend exec vitest run src/lib/basemap/basemapStyles.test.ts src/Applications/FlightTracker/flightMapStyle.test.ts`
Expected: FAIL — hillshade layout entries undefined; `terrain` not in `FlightMapColors`.

- [ ] **Step 3: Implement**

`applyBasemapStyle` in `basemapStyles.ts` — add the parameter and the hillshade block at the end (before `map.setSky`):

```ts
export function applyBasemapStyle(
	map: StylableMap,
	mapStyle: BasemapStyleId,
	darkMap: boolean,
	terrainEnabled = false,
): void {
```

```ts
	const h = hillshadeVisibility(mapStyle, terrainEnabled);
	for (const [id, styleId, visible] of [
		["hillshade-classic", "classic", h.classic],
		["hillshade-radar", "radar", h.radar],
		["hillshade-satellite", "satellite", h.satellite],
	] as const) {
		map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
		for (const [name, value] of Object.entries(
			hillshadePaint(hillshadePalette(styleId, darkMap)),
		)) {
			map.setPaintProperty(id, name, value);
		}
	}
```

`flightMapStyle.ts` — extend the interface and the call:

```ts
export interface FlightMapColors {
	mapStyle: BasemapStyleId;
	darkMap: boolean;
	pinColor: string;
	notablePinColor: string;
	// Topography toggle: hillshade visibility rides the shared basemap switch.
	terrain: boolean;
}
```

```ts
	applyBasemapStyle(map, colors.mapStyle, colors.darkMap, colors.terrain);
```

Fix the resulting type errors at `FlightMapColors` construction sites in `FlightMap.tsx` by adding `terrain: false` placeholders ONLY if you must to keep this commit green — Task 5 replaces them with the real prop. (There are two: the `colorsRef` seed and the re-theme effect's object literal.)

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @rt911/frontend exec vitest run src/lib/basemap/basemapStyles.test.ts src/Applications/FlightTracker/flightMapStyle.test.ts` — expected: PASS.
Run: `pnpm build` — expected: clean (FlightMap placeholder edits included).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/lib/basemap/basemapStyles.ts packages/frontend/src/lib/basemap/basemapStyles.test.ts packages/frontend/src/Applications/FlightTracker/flightMapStyle.ts packages/frontend/src/Applications/FlightTracker/flightMapStyle.test.ts packages/frontend/src/Applications/FlightTracker/FlightMap.tsx
git commit -m "feat(basemap): hillshade visibility and tint ride the live style switch"
```

---

### Task 5: FlightMap `terrain` prop + `setTerrain`

**Files:**
- Modify: `packages/frontend/src/Applications/FlightTracker/FlightMap.tsx`
- Test: `packages/frontend/src/Applications/FlightTracker/FlightMap.test.tsx`

**Interfaces:**
- Consumes: `TERRAIN_SOURCE` (Task 3), `FlightMapColors.terrain` (Task 4).
- Produces (used by Task 6): `FlightMapProps.terrain?: boolean` (destructure default `false`).

- [ ] **Step 1: Extend the maplibre mock**

In `FlightMap.test.tsx`, inside the `FakeMap` class (`vi.hoisted` block, after `setSky`):

```ts
		terrainCalls: (Record<string, unknown> | null)[] = [];
		setTerrain(spec: Record<string, unknown> | null) { this.terrainCalls.push(spec); }
```

- [ ] **Step 2: Write the failing tests**

Add to `FlightMap.test.tsx`, following the file's established pattern for rendering `<FlightMap …/>` and firing `FakeMap.last!.fire("load")` (copy the setup used by the globe/3D toggle tests in the same file):

```ts
describe("terrain toggle", () => {
	it("seeds setTerrain at load when the persisted toggle is on", () => {
		renderMap({ terrain: true }); // whatever helper/props-spread the file's other tests use
		const map = FakeMap.last!;
		map.fire("load");
		expect(map.terrainCalls).toEqual([{ source: "terrain", exaggeration: 1 }]);
	});

	it("does not call setTerrain at load when off", () => {
		renderMap({ terrain: false });
		const map = FakeMap.last!;
		map.fire("load");
		expect(map.terrainCalls).toEqual([]);
	});

	it("toggling flips the 3D mesh and the active hillshade layer", () => {
		const view = renderMap({ terrain: false, mapStyle: "classic" });
		const map = FakeMap.last!;
		map.fire("load");
		view.rerender(mapProps({ terrain: true, mapStyle: "classic" }));
		expect(map.terrainCalls.at(-1)).toEqual({ source: "terrain", exaggeration: 1 });
		expect(map.layout["hillshade-classic"].visibility).toBe("visible");
		view.rerender(mapProps({ terrain: false, mapStyle: "classic" }));
		expect(map.terrainCalls.at(-1)).toBeNull();
		expect(map.layout["hillshade-classic"].visibility).toBe("none");
	});
});
```

(`renderMap`/`mapProps` stand for the file's existing render helper and base-props builder — reuse them verbatim; if none exists for rerenders, follow the pattern of the existing `threeD` toggle test.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/FlightTracker/FlightMap.test.tsx -t "terrain toggle"`
Expected: FAIL — `terrainCalls` stays empty.

- [ ] **Step 4: Implement**

In `FlightMap.tsx`:

1. Import `TERRAIN_SOURCE` from `../../lib/basemap/basemapStyles`.
2. Add to `FlightMapProps` after `threeD?: boolean;`:

```ts
	// Topography (hillshade + 3D ground mesh); persisted in FlightMapSettings.
	terrain?: boolean;
```

3. Destructure with `terrain = false` beside `globe = false, threeD = false`.
4. Replace the Task-4 placeholder in the `colorsRef` seed: the ref object now carries `terrain` (mirror how `mapStyle`/`darkMap` flow into it).
5. In the `map.on("load", …)` handler, immediately after the existing `applyMapColors(map, colorsRef.current);` line:

```ts
			// Projection/pitch-style load-time seed for the terrain mesh: the
			// [terrain] effect below skips pre-load renders.
			if (colorsRef.current.terrain)
				map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: 1 });
```

6. Update the re-theme effect to carry the flag (hillshade visibility must follow style switches while terrain is on):

```ts
	useEffect(() => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		applyMapColors(map, { mapStyle, darkMap, pinColor, notablePinColor, terrain });
		void installPlaneIcons(map, pinColor, notablePinColor);
		planes3DRef.current?.setColors(pinColor, notablePinColor);
		replayTrail3DRef.current?.setColors(pinColor, notablePinColor);
		trailTubeRef.current?.setColor(trailColor(mapStyle, darkMap));
	}, [mapStyle, darkMap, pinColor, notablePinColor, terrain]);
```

7. Add the toggle effect after the `threeD` effect (`setTerrain` rebuilds the terrain pipeline, so it gets its own narrowly-scoped effect rather than riding the re-theme deps):

```ts
	// Terrain mesh on/off. The hillshade half of the toggle rides the re-theme
	// effect above (applyMapColors); this owns only the ground mesh.
	useEffect(() => {
		const map = mapRef.current;
		if (!map || !loadedRef.current) return;
		map.setTerrain(terrain ? { source: TERRAIN_SOURCE, exaggeration: 1 } : null);
		dirtyRef.current = true;
	}, [terrain]);
```

- [ ] **Step 5: Run the whole file, then the suite**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/FlightTracker/FlightMap.test.tsx` — expected: PASS (terrain tests and all pre-existing tests; the load-seed ordering must not disturb the visibility-matrix tests).
Run: `pnpm test` — expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/Applications/FlightTracker/FlightMap.tsx packages/frontend/src/Applications/FlightTracker/FlightMap.test.tsx
git commit -m "feat(flight-tracker): terrain prop drives setTerrain and hillshade"
```

---

### Task 6: MapControls button + FlightTracker wiring

**Files:**
- Modify: `packages/frontend/src/Applications/FlightTracker/MapControls.tsx`
- Modify: `packages/frontend/src/Applications/FlightTracker/FlightTracker.tsx` (toggle callback ~line 196; both `<MapControls…>`/`<FlightMap…>` render sites ~lines 910/953)
- Test: `packages/frontend/src/Applications/FlightTracker/MapControls.test.tsx`

**Interfaces:**
- Consumes: `FlightMapSettings.terrain` (Task 1), `FlightMapProps.terrain` (Task 5).
- Produces: `MapControlsProps.terrain: boolean` + `onToggleTerrain(): void`.

- [ ] **Step 1: Write the failing test**

In `MapControls.test.tsx`, add `terrain: false, onToggleTerrain: vi.fn(),` to the `baseProps()` builder, then:

```ts
	it("reflects and toggles the terrain state", () => {
		const p = baseProps();
		render(<MapControls {...p} terrain={true} />);
		const terrain = screen.getByRole("button", { name: "Terrain" });
		expect(terrain.getAttribute("aria-pressed")).toBe("true");
		fireEvent.click(terrain);
		expect(p.onToggleTerrain).toHaveBeenCalledOnce();
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/FlightTracker/MapControls.test.tsx`
Expected: FAIL — no button named "Terrain".

- [ ] **Step 3: Implement**

`MapControls.tsx` — extend `MapControlsProps`:

```ts
	terrain: boolean;
	onToggleTerrain(): void;
```

and render the button between the "3D" and "Cluster" buttons:

```tsx
		<ClassicyButton
			buttonSize="small"
			aria-label="Terrain"
			depressed={p.terrain}
			onClickFunc={p.onToggleTerrain}
		>
			Terrain
		</ClassicyButton>
```

`FlightTracker.tsx` — beside `toggleThreeD` (~line 196):

```ts
	const toggleTerrain = useCallback(() => {
		desktopEventDispatch(
			flightTrackerSetMapSettings({ ...settings, terrain: !settings.terrain }),
		);
	}, [settings, desktopEventDispatch]);
```

At the `<MapControls …>` render site add `terrain={settings.terrain}` and `onToggleTerrain={toggleTerrain}`; at every `<FlightMap …>` render site add `terrain={settings.terrain}` (there are two prop blocks around lines 910 and 953 — grep for `threeD={settings.threeD}` and mirror it at each hit).

- [ ] **Step 4: Run tests + full gates**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/FlightTracker/MapControls.test.tsx src/Applications/FlightTracker/FlightTracker.test.tsx` — expected: PASS (FlightTracker tests use full render; the new required MapControls props flow from real settings).
Run: `pnpm test && pnpm lint && pnpm build` — expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/FlightTracker/MapControls.tsx packages/frontend/src/Applications/FlightTracker/MapControls.test.tsx packages/frontend/src/Applications/FlightTracker/FlightTracker.tsx
git commit -m "feat(flight-tracker): Terrain toolbar toggle"
```

---

### Task 7: Build + upload the DEM archive

**Files:**
- Create: `scripts/build-terrain-dem.md`

This is data-ops, not TDD — the deliverable is the archive on Wasabi plus a reproducible recipe. The frontend (Tasks 1–6) works before this ships: a 404ing DEM source is non-fatal (hillshade just doesn't draw), so land the code and data independently.

- [ ] **Step 1: Verify the Mapterhorn source (spec's open item)**

Check https://mapterhorn.com (and its GitHub org) for the published planet PMTiles archive URL and license terms. Record both in the doc. If no extractable archive exists, use the AWS fallback in Step 2b.

- [ ] **Step 2a: Extract (preferred)**

```bash
pmtiles extract <MAPTERHORN_PLANET_URL> terrain-dem.pmtiles \
  --bbox=-150,18,-65,65 --maxzoom=11
pmtiles show terrain-dem.pmtiles   # expect: raster-dem-ish tile type, maxzoom 11, NA bounds
```

- [ ] **Step 2b: Fallback — AWS Terrain Tiles**

Terrarium PNGs from the public `elevation-tiles-prod` S3 bucket (no auth, 256px tiles — if this path is taken, change `tileSize` to `256` in the Task 3 source spec and its test): download z0–11 over the bbox with a small Python script (requests + mercantile), write into MBTiles, then `pmtiles convert`. Document the exact script in `scripts/build-terrain-dem.md`.

- [ ] **Step 3: Upload + verify**

Upload with the video-grabber Wasabi boto3 credentials exactly as `scripts/build-satellite-basemap.md` documents (aws-cli ≥ 1.36 breaks against Wasabi's checksum handling — use boto3).

```bash
curl -I -H 'Range: bytes=0-16' https://files.911realtime.org/maps/terrain-dem.pmtiles
# expect: 206 Partial Content
```

- [ ] **Step 4: Write `scripts/build-terrain-dem.md`**

Follow the structure of `scripts/build-satellite-basemap.md`: source + license/attribution, exact build commands actually used, sanity checks, upload steps, the curl verification. Record the chosen source URL and the archive's final size.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-terrain-dem.md
git commit -m "docs(scripts): terrain DEM archive build recipe"
```

---

### Task 8: End-to-end verification

- [ ] **Step 1: Full gates**

Run: `pnpm test && pnpm lint && pnpm build`
Expected: all pass (CI parity).

- [ ] **Step 2: Browser verification**

Invoke the `packages/frontend:verify` skill against the dev server and walk:

1. Flight Tracker open, classic style, terrain toggle ON (default) → hillshade relief visible over the Rockies/Appalachians top-down.
2. 3D toggle on, pinpoint near Denver/Rockies, pitch → ground mesh visibly rises; planes/tubes render above it; no z-fighting or vanishing custom layers.
3. Style → Radar Scope: shading goes phosphor-green; Style → Satellite (± Dark): subtle relief over imagery, night variant included.
4. Globe toggle on: terrain + hillshade still render; no crash (v5 globe+terrain path).
5. Terrain toggle OFF → flat map identical to pre-feature look; Network tab shows no `terrain-dem` fetches after reload with toggle off.
6. Reload → toggle state persists via `classicyDesktopState` localStorage.
7. Weather app open → identical to before (no hillshade, no DEM fetches).

- [ ] **Step 3: Update the spec's status line and close out**

Mark `plans/flight-map-3d-terrain-design.md` status as Implemented with date; note any tuning-value changes made during browser verification.

```bash
git add plans/flight-map-3d-terrain-design.md
git commit -m "docs: mark 3D terrain spec implemented"
```
