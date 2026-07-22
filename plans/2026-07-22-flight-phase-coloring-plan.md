# Flight Tracker Per-Phase Track Coloring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Color the Flight Tracker's 2D track line and 3D track tube per flight phase (Takeoff→TRACON→ARTCC→Hijack→Course Change→ATC Alert→Descent→Down) for the four hijacked flights AA11/UA175/AA77/UA93.

**Architecture:** Curated per-flight phase boundaries live in `data/notable_flights/*.json`; the `notable.py` loader interval-assigns each per-minute `flight_positions` row a phase (overriding the coarse altitude-trend phase). The frontend fetches `phase` alongside the altitude profile and colors both the 2D line (per-phase LineString segments + a data-driven `match` expression) and the 3D tube (per-vertex color attribute). No backend/Go/wire change — `phase` already crosses the wire and the selected track is served over Directus REST.

**Tech Stack:** Python (flight-recon pipeline, pytest), TypeScript/React (Vite frontend, vitest), MapLibre GL JS, custom WebGL2 layer.

## Global Constraints

- Phase slugs are exactly: `takeoff`, `tracon`, `artcc`, `hijack`, `course_change`, `atc_alert`, `descent`, `down` (snake_case, lowercase). Copy verbatim everywhere.
- Phase→color map (escalation ramp): `takeoff #2e7d32`, `tracon #0097a7`, `artcc #1565c0`, `hijack #f9a825`, `course_change #ef6c00`, `atc_alert #d84315`, `descent #c62828`, `down #7f0000`. Default/fallback color = `#b22222` (equals the existing `TRACK_LINE_COLOR`).
- Coloring applies ONLY to the four flights in `NOTABLE_FLIGHTS` (`["AA11","UA175","AA77","UA93"]`, `notableFlights.ts`). Any other selected flight keeps today's flat line/tube.
- Rule: a per-minute sample belongs to the last phase whose boundary `utc` is `≤` the sample's `utc` (boundary-inclusive; the boundary sample gets the *new* phase).
- Rule: phase boundaries are authored in real chronological order per flight — UA93's `atc_alert` precedes `course_change`.
- Frontend tests: co-locate `*.test.ts` next to source; pure-logic modules need no RTL cleanup.
- `flight_positions` / `flight_tracks` are public-read on `api-beta.911realtime.org`; no schema change (the `phase` column already exists).

---

## File Structure

**Pipeline (Python, `packages/tools/flight-recon/`)**
- `flight_recon/resample.py` — add pure `assign_curated_phases(samples, phases)`.
- `flight_recon/notable.py` — call it in `build_flight` when the flight JSON has a `phases` block.
- `data/notable_flights/{aa11,ua175,aa77,ua93}.json` — add a `phases` array.
- `tests/test_resample.py`, `tests/test_notable.py` — unit + integration tests.

**Frontend (TypeScript, `packages/frontend/src/Applications/FlightTracker/`)**
- `flightPhases.ts` (NEW) — phase→color map, `phaseColorHex`, `phaseColorRgb01`, `phaseLineColorExpression`.
- `flightTrackSegments.ts` (NEW) — `buildTrackSegments(points)` → per-phase LineString features.
- `flightAltitude.ts` — add `phase?: string` to `AltitudeSample`.
- `useAltitudeProfile.ts` — fetch `phase` in `profileUrl`.
- `trackTube.ts` — carry phase through `splineTrack`; emit per-vertex `colors` from `buildTrackTube`.
- `trackTubeLayer.ts` — add `a_color` attribute + `u_useVertexColor` uniform; upload per-vertex colors.
- `FlightMap.tsx` — phase `match` expression on `track-line`; pass `colors` to the tube.
- `FlightTracker.tsx` — build the 2D `track` source as a phase-segmented `FeatureCollection` for notable flights.

---

## Task 1: Pure curated-phase assignment (pipeline core)

**Files:**
- Modify: `packages/tools/flight-recon/flight_recon/resample.py`
- Test: `packages/tools/flight-recon/tests/test_resample.py`

**Interfaces:**
- Produces: `assign_curated_phases(samples: list[dict], phases: list[dict]) -> None` — mutates each sample's `["phase"]` in place. `samples` are resample dicts with a `"utc"` datetime; `phases` are `{"phase": str, "utc": str|datetime}` boundaries.

- [ ] **Step 1: Write the failing test**

Add to `packages/tools/flight-recon/tests/test_resample.py`:

```python
from datetime import datetime, timezone
from flight_recon.resample import assign_curated_phases


def _mins(*hhmmss):
    return [{"utc": datetime(2001, 9, 11, h, m, s, tzinfo=timezone.utc), "phase": "cruise"}
            for (h, m, s) in hhmmss]


def test_assign_curated_phases_boundary_inclusive_and_ordered():
    samples = _mins((12, 0, 0), (12, 9, 0), (12, 24, 0), (12, 25, 0))
    phases = [
        {"phase": "tracon", "utc": "2001-09-11T12:00:00Z"},
        {"phase": "artcc", "utc": "2001-09-11T12:09:00Z"},
        {"phase": "atc_alert", "utc": "2001-09-11T12:24:38Z"},
    ]
    assign_curated_phases(samples, phases)
    # boundary-inclusive: 12:09 sample takes the artcc boundary exactly;
    # the off-minute 12:24:38 boundary leaves the 12:24 sample in artcc.
    assert [s["phase"] for s in samples] == ["tracon", "artcc", "artcc", "atc_alert"]


def test_assign_curated_phases_before_first_boundary_uses_first_phase():
    samples = _mins((11, 59, 0))
    phases = [{"phase": "takeoff", "utc": "2001-09-11T12:00:00Z"}]
    assign_curated_phases(samples, phases)
    assert samples[0]["phase"] == "takeoff"


def test_assign_curated_phases_out_of_list_order_by_time():
    # UA93: atc_alert (earlier) authored before course_change (later).
    samples = _mins((13, 33, 0), (13, 37, 0))
    phases = [
        {"phase": "atc_alert", "utc": "2001-09-11T13:32:00Z"},
        {"phase": "course_change", "utc": "2001-09-11T13:36:00Z"},
    ]
    assign_curated_phases(samples, phases)
    assert [s["phase"] for s in samples] == ["atc_alert", "course_change"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tools/flight-recon && pytest tests/test_resample.py -k curated -v`
Expected: FAIL — `ImportError: cannot import name 'assign_curated_phases'`

- [ ] **Step 3: Write minimal implementation**

Append to `packages/tools/flight-recon/flight_recon/resample.py`:

```python
def assign_curated_phases(samples, phases):
    """Override each sample's ``phase`` from curated ``{phase, utc}`` boundaries.

    A sample takes the last boundary whose ``utc`` is <= the sample's ``utc``
    (boundary-inclusive: the boundary sample gets the NEW phase). Boundaries are
    sorted by time here, so they may be authored in real chronological order
    even when that differs from any nominal phase list (UA93's atc_alert before
    course_change). Samples before the first boundary take the first phase."""
    bounds = sorted(
        ((b["utc"] if isinstance(b["utc"], datetime) else parse_utc(b["utc"]), b["phase"])
         for b in phases),
        key=lambda bp: bp[0],
    )
    if not bounds:
        return
    for s in samples:
        t = s["utc"]
        label = bounds[0][1]
        for bt, ph in bounds:
            if bt <= t:
                label = ph
            else:
                break
        s["phase"] = label
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/tools/flight-recon && pytest tests/test_resample.py -k curated -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/tools/flight-recon/flight_recon/resample.py packages/tools/flight-recon/tests/test_resample.py
git commit -m "feat(flight-recon): pure curated-phase interval assignment"
```

---

## Task 2: Wire curated phases into the loader + author the 4 phase blocks

**Files:**
- Modify: `packages/tools/flight-recon/flight_recon/notable.py:138-141` (`build_flight`)
- Modify: `packages/tools/flight-recon/data/notable_flights/{aa11,ua175,aa77,ua93}.json`
- Test: `packages/tools/flight-recon/tests/test_notable.py`

**Interfaces:**
- Consumes: `assign_curated_phases` (Task 1).
- Produces: `build_flight` positions carry the 8-phase taxonomy when the JSON has a `"phases"` block.

- [ ] **Step 1: Add the `phases` block to each notable JSON**

Add a top-level `"phases"` array (sibling of `"waypoints"`) to each file. Times are the confirmed EDT timeline converted to UTC (EDT = UTC−4); `down` is set to the impact-minute floor so the off-minute impact sample is labeled `down`.

`data/notable_flights/aa11.json`:
```json
"phases": [
  { "phase": "takeoff",       "utc": "2001-09-11T11:59:00Z" },
  { "phase": "tracon",        "utc": "2001-09-11T12:00:00Z" },
  { "phase": "artcc",         "utc": "2001-09-11T12:09:00Z" },
  { "phase": "hijack",        "utc": "2001-09-11T12:14:00Z" },
  { "phase": "course_change", "utc": "2001-09-11T12:21:00Z" },
  { "phase": "atc_alert",     "utc": "2001-09-11T12:24:38Z" },
  { "phase": "descent",       "utc": "2001-09-11T12:44:00Z" },
  { "phase": "down",          "utc": "2001-09-11T12:46:00Z" }
]
```

`data/notable_flights/ua175.json`:
```json
"phases": [
  { "phase": "takeoff",       "utc": "2001-09-11T12:14:00Z" },
  { "phase": "tracon",        "utc": "2001-09-11T12:15:00Z" },
  { "phase": "artcc",         "utc": "2001-09-11T12:19:00Z" },
  { "phase": "hijack",        "utc": "2001-09-11T12:44:00Z" },
  { "phase": "course_change", "utc": "2001-09-11T12:47:00Z" },
  { "phase": "atc_alert",     "utc": "2001-09-11T12:53:00Z" },
  { "phase": "descent",       "utc": "2001-09-11T13:02:00Z" },
  { "phase": "down",          "utc": "2001-09-11T13:03:00Z" }
]
```

`data/notable_flights/aa77.json`:
```json
"phases": [
  { "phase": "takeoff",       "utc": "2001-09-11T12:20:00Z" },
  { "phase": "tracon",        "utc": "2001-09-11T12:21:00Z" },
  { "phase": "artcc",         "utc": "2001-09-11T12:40:00Z" },
  { "phase": "hijack",        "utc": "2001-09-11T12:52:00Z" },
  { "phase": "course_change", "utc": "2001-09-11T12:54:00Z" },
  { "phase": "atc_alert",     "utc": "2001-09-11T12:56:00Z" },
  { "phase": "descent",       "utc": "2001-09-11T13:34:00Z" },
  { "phase": "down",          "utc": "2001-09-11T13:37:00Z" }
]
```

`data/notable_flights/ua93.json` (note `atc_alert` before `course_change`):
```json
"phases": [
  { "phase": "takeoff",       "utc": "2001-09-11T12:42:00Z" },
  { "phase": "tracon",        "utc": "2001-09-11T12:43:00Z" },
  { "phase": "artcc",         "utc": "2001-09-11T13:23:00Z" },
  { "phase": "hijack",        "utc": "2001-09-11T13:28:00Z" },
  { "phase": "atc_alert",     "utc": "2001-09-11T13:32:00Z" },
  { "phase": "course_change", "utc": "2001-09-11T13:36:00Z" },
  { "phase": "descent",       "utc": "2001-09-11T13:58:00Z" },
  { "phase": "down",          "utc": "2001-09-11T14:03:00Z" }
]
```

Do NOT add a `phases` block to `gofer06.json` — the observer keeps the coarse altitude phase.

- [ ] **Step 2: Write the failing integration test**

Add to `packages/tools/flight-recon/tests/test_notable.py`:

```python
from flight_recon.notable import build_all, NOTABLE_FLIGHTS

CURATED_PHASES = {"takeoff", "tracon", "artcc", "hijack",
                  "course_change", "atc_alert", "descent", "down"}


def test_notable_positions_use_curated_phases():
    positions, _ = build_all()
    by_flight = {}
    for p in positions:
        by_flight.setdefault(p["flight"], []).append(p["phase"])
    for flight in ("AA11", "UA175", "AA77", "UA93"):
        phases = by_flight[flight]
        # every position of a hijacked flight carries an 8-phase value...
        assert set(phases) <= CURATED_PHASES, f"{flight}: {set(phases) - CURATED_PHASES}"
        # ...and the story spans at least takeoff -> down.
        assert phases[0] == "takeoff"
        assert phases[-1] == "down"


def test_gofer06_keeps_altitude_phase():
    positions, _ = build_all()
    gofer = {p["phase"] for p in positions if p["flight"] == "GOFER06"}
    assert gofer <= {"climb", "cruise", "descent"}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/tools/flight-recon && pytest tests/test_notable.py -k "curated_phases or gofer06" -v`
Expected: FAIL — hijacked-flight positions still carry `climb`/`cruise`/`descent` (assert on `takeoff` fails).

- [ ] **Step 4: Wire `assign_curated_phases` into `build_flight`**

In `packages/tools/flight-recon/flight_recon/notable.py`, update the import at line 48 and `build_flight` at lines 138-140:

```python
from flight_recon.resample import (
    assign_curated_phases, decimate_polyline, fmt_utc, parse_utc, resample_track,
)
```

```python
    flight = data["flight"]
    samples = resample_track(data["waypoints"])
    curated = data.get("phases")
    if curated:
        assign_curated_phases(samples, curated)
```

(The existing loop already reads `s["phase"]` into each position dict, so no further change there.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/tools/flight-recon && pytest tests/test_notable.py -v`
Expected: PASS (all, including the two new tests)

- [ ] **Step 6: Commit**

```bash
git add packages/tools/flight-recon/flight_recon/notable.py packages/tools/flight-recon/data/notable_flights/*.json packages/tools/flight-recon/tests/test_notable.py
git commit -m "feat(flight-recon): curated 8-phase boundaries for the 4 hijacked flights (#229)"
```

---

## Task 3: Frontend phase→color module

**Files:**
- Create: `packages/frontend/src/Applications/FlightTracker/flightPhases.ts`
- Test: `packages/frontend/src/Applications/FlightTracker/flightPhases.test.ts`

**Interfaces:**
- Produces:
  - `PHASE_COLORS: Record<string, string>` — the 8 slug→hex entries.
  - `phaseColorHex(phase?: string): string` — hex for a phase, else `#b22222`.
  - `phaseColorRgb01(phase?: string): [number, number, number]` — RGB in 0..1 for WebGL.
  - `phaseLineColorExpression(): ExpressionSpecification` — a MapLibre `match` on `["get","phase"]`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { PHASE_COLORS, phaseColorHex, phaseColorRgb01, phaseLineColorExpression } from "./flightPhases";

describe("flightPhases", () => {
	it("maps known phases and falls back to the track red", () => {
		expect(phaseColorHex("hijack")).toBe("#f9a825");
		expect(phaseColorHex("down")).toBe("#7f0000");
		expect(phaseColorHex("cruise")).toBe("#b22222"); // coarse phase → default
		expect(phaseColorHex(undefined)).toBe("#b22222");
	});

	it("converts to 0..1 RGB for WebGL", () => {
		const [r, g, b] = phaseColorRgb01("takeoff"); // #2e7d32
		expect(r).toBeCloseTo(0x2e / 255);
		expect(g).toBeCloseTo(0x7d / 255);
		expect(b).toBeCloseTo(0x32 / 255);
	});

	it("builds a match expression covering all 8 phases with a default", () => {
		const expr = phaseLineColorExpression() as unknown[];
		expect(expr[0]).toBe("match");
		for (const slug of Object.keys(PHASE_COLORS)) {
			expect(expr).toContain(slug);
		}
		expect(expr[expr.length - 1]).toBe("#b22222"); // default is last
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/FlightTracker/flightPhases.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/frontend/src/Applications/FlightTracker/flightPhases.ts`:

```ts
import type { ExpressionSpecification } from "maplibre-gl";

// Escalation-ramp palette for the 4 hijacked flights (issue #229): calm
// green→teal→blue for normal ops, warming to red/maroon as the crisis
// escalates. Slugs match flight_positions.phase written by the notable loader.
export const PHASE_COLORS: Record<string, string> = {
	takeoff: "#2e7d32",
	tracon: "#0097a7",
	artcc: "#1565c0",
	hijack: "#f9a825",
	course_change: "#ef6c00",
	atc_alert: "#d84315",
	descent: "#c62828",
	down: "#7f0000",
};

// Coarse altitude phases (climb/cruise/descent) and unknowns fall back to the
// existing flat track red, so non-notable flights render exactly as before.
export const DEFAULT_PHASE_COLOR = "#b22222";

export function phaseColorHex(phase?: string): string {
	return (phase && PHASE_COLORS[phase]) ?? DEFAULT_PHASE_COLOR;
}

export function phaseColorRgb01(phase?: string): [number, number, number] {
	const n = Number.parseInt(phaseColorHex(phase).slice(1), 16);
	return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Data-driven line-color for the 2D track: each per-phase segment feature
// carries properties.phase; unknown/absent phases hit the default red.
export function phaseLineColorExpression(): ExpressionSpecification {
	const cases: (string)[] = [];
	for (const [slug, hex] of Object.entries(PHASE_COLORS)) {
		cases.push(slug, hex);
	}
	return [
		"match",
		["get", "phase"],
		...cases,
		DEFAULT_PHASE_COLOR,
	] as unknown as ExpressionSpecification;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/FlightTracker/flightPhases.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/FlightTracker/flightPhases.ts packages/frontend/src/Applications/FlightTracker/flightPhases.test.ts
git commit -m "feat(flight-tracker): phase color palette + line-color expression (#229)"
```

---

## Task 4: Fetch `phase` in the altitude profile

**Files:**
- Modify: `packages/frontend/src/Applications/FlightTracker/flightAltitude.ts:71-76`
- Modify: `packages/frontend/src/Applications/FlightTracker/useAltitudeProfile.ts:17`
- Test: `packages/frontend/src/Applications/FlightTracker/useAltitudeProfile.test.ts`

**Interfaces:**
- Produces: `AltitudeSample` gains `phase?: string`; `profileUrl` requests it.

- [ ] **Step 1: Write the failing test**

Create `packages/frontend/src/Applications/FlightTracker/useAltitudeProfile.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { profileUrl } from "./useAltitudeProfile";

describe("profileUrl", () => {
	it("requests the phase field for per-phase coloring", () => {
		const url = profileUrl("AA11", "2001-09-11");
		const fields = new URL(url).searchParams.get("fields");
		expect(fields).toContain("phase");
		expect(fields).toContain("lat");
		expect(fields).toContain("lon");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/FlightTracker/useAltitudeProfile.test.ts`
Expected: FAIL — `fields` is `"lat,lon,alt_ft,utc"`, no `phase`.

- [ ] **Step 3: Implement**

`flightAltitude.ts` — add the field:

```ts
export interface AltitudeSample {
	lat: number;
	lon: number;
	alt_ft: number;
	utc: string;
	phase?: string;
}
```

`useAltitudeProfile.ts` line 17 — add `phase` to the fetched fields:

```ts
		fields: "lat,lon,alt_ft,utc,phase",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/FlightTracker/useAltitudeProfile.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/FlightTracker/flightAltitude.ts packages/frontend/src/Applications/FlightTracker/useAltitudeProfile.ts packages/frontend/src/Applications/FlightTracker/useAltitudeProfile.test.ts
git commit -m "feat(flight-tracker): fetch position phase for track coloring (#229)"
```

---

## Task 5: 2D per-phase segment builder

**Files:**
- Create: `packages/frontend/src/Applications/FlightTracker/flightTrackSegments.ts`
- Test: `packages/frontend/src/Applications/FlightTracker/flightTrackSegments.test.ts`

**Interfaces:**
- Consumes: `AltitudeSample` (has `lat`, `lon`, `phase?`).
- Produces: `buildTrackSegments(points: {lat:number; lon:number; phase?:string}[]): GeoJSON.Feature[]` — one `LineString` Feature per maximal run of same-phase points; adjacent segments share the boundary vertex (no gap); each Feature's `properties.phase` is the run's phase. Fewer than 2 points → `[]`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { buildTrackSegments } from "./flightTrackSegments";

const P = (lon: number, phase: string) => ({ lat: 40, lon, phase });

describe("buildTrackSegments", () => {
	it("splits maximal same-phase runs into features sharing boundary vertices", () => {
		const feats = buildTrackSegments([
			P(-1, "takeoff"), P(-2, "takeoff"), P(-3, "artcc"), P(-4, "artcc"),
		]);
		expect(feats).toHaveLength(2);
		expect(feats[0].properties?.phase).toBe("takeoff");
		expect(feats[1].properties?.phase).toBe("artcc");
		// boundary vertex is shared: last coord of seg0 == first coord of seg1.
		const g0 = feats[0].geometry as GeoJSON.LineString;
		const g1 = feats[1].geometry as GeoJSON.LineString;
		expect(g0.coordinates.at(-1)).toEqual(g1.coordinates[0]);
		expect(g0.coordinates).toEqual([[-1, 40], [-2, 40], [-3, 40]]);
	});

	it("returns [] for degenerate input", () => {
		expect(buildTrackSegments([])).toEqual([]);
		expect(buildTrackSegments([P(-1, "takeoff")])).toEqual([]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/FlightTracker/flightTrackSegments.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/frontend/src/Applications/FlightTracker/flightTrackSegments.ts`:

```ts
interface PhasePoint {
	lat: number;
	lon: number;
	phase?: string;
}

/**
 * Split a phase-tagged point list into one LineString Feature per maximal run
 * of the same phase. Adjacent segments SHARE the boundary vertex (the run's
 * last point is repeated as the next run's first) so the colored line has no
 * gap at the phase change. Each Feature carries properties.phase. Fewer than
 * two points cannot form a line → [].
 */
export function buildTrackSegments(points: PhasePoint[]): GeoJSON.Feature[] {
	if (points.length < 2) return [];
	const features: GeoJSON.Feature[] = [];
	let start = 0;
	const flush = (end: number) => {
		// include the boundary vertex at `end` so segments join seamlessly.
		const slice = points.slice(start, end + 1);
		if (slice.length < 2) return;
		features.push({
			type: "Feature",
			properties: { phase: points[start].phase ?? null },
			geometry: {
				type: "LineString",
				coordinates: slice.map((p) => [p.lon, p.lat]),
			},
		});
	};
	for (let i = 1; i < points.length; i++) {
		if (points[i].phase !== points[start].phase) {
			flush(i); // boundary vertex i belongs to both runs
			start = i;
		}
	}
	flush(points.length - 1);
	return features;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/FlightTracker/flightTrackSegments.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/FlightTracker/flightTrackSegments.ts packages/frontend/src/Applications/FlightTracker/flightTrackSegments.test.ts
git commit -m "feat(flight-tracker): per-phase 2D track segment builder (#229)"
```

---

## Task 6: Color the 2D track line

**Files:**
- Modify: `packages/frontend/src/Applications/FlightTracker/FlightTracker.tsx:73` (import), `:778-780` (`trackGeoJSON`), `:1113` (prop)
- Modify: `packages/frontend/src/Applications/FlightTracker/FlightMap.tsx:11-12,296-298` (imports/prop type), `:696-700` (pitch effect), `:746-747` (layer paint), `:1206-1212` (track push effect)
- Test: manual (visual) — no unit test; the segment builder (Task 5) and expression (Task 3) are already covered.

**Interfaces:**
- Consumes: `buildTrackSegments` (Task 5), `phaseLineColorExpression` (Task 3), `isNotable` (`notableFlights.ts`), `profile` (Task 4).
- Produces: the `FlightMapProps.trackGeoJSON` prop becomes `GeoJSON.FeatureCollection | null` (was `GeoJSON.Feature | null`).

- [ ] **Step 1: Build a phase-segmented FeatureCollection in `FlightTracker.tsx`**

At line 73 the import already includes `isNotable`. Replace the `trackGeoJSON` memo (currently lines 778-780) with a `FeatureCollection` that is phase-segmented for notable flights and a single plain feature otherwise:

```tsx
	const trackGeoJSON: FeatureCollection | null = useMemo(() => {
		if (!track?.geometry) return null;
		if (selection && isNotable(selection.flight) && profile && profile.length >= 2) {
			const features = buildTrackSegments(profile);
			if (features.length) return { type: "FeatureCollection", features };
		}
		// non-notable (or no profile yet): the decimated track as one plain feature.
		return {
			type: "FeatureCollection",
			features: [{ type: "Feature", geometry: track.geometry, properties: {} }],
		};
	}, [track?.geometry, selection, profile]);
```

Add the imports near the other FlightTracker imports (top of file, alongside line 42-43):

```tsx
import type { FeatureCollection } from "geojson";
import { buildTrackSegments } from "./flightTrackSegments";
```

(`Feature` may become unused — remove it from the existing `geojson` import if eslint flags it.)

- [ ] **Step 2: Widen the prop type in `FlightMap.tsx`**

At line 297, change the prop type:

```tsx
	trackGeoJSON: GeoJSON.FeatureCollection | null;
```

- [ ] **Step 3: Paint the layer with the phase expression**

Add to the `flightMapStyle` import block (lines 11-12 area of `FlightMap.tsx`) — actually import from the new module:

```tsx
import { phaseLineColorExpression } from "./flightPhases";
```

At the layer creation (lines 746-747), use the phase expression instead of the flat color:

```tsx
			id: "track-line", type: "line", source: "track",
			paint: { "line-color": phaseLineColorExpression(), "line-width": 2 },
```

In the pitch effect (lines 696-700), keep the shadow when pitched but restore the phase expression when flat:

```tsx
		map.setPaintProperty(
			"track-line",
			"line-color",
			pitchedRef.current ? TRACK_SHADOW_COLOR : phaseLineColorExpression(),
		);
```

- [ ] **Step 4: Feed the FeatureCollection to the source**

The track push effect (lines 1206-1212) currently wraps a single Feature. Since `trackGeoJSON` is now already a `FeatureCollection`, set it directly:

```tsx
		const src = map.getSource("track") as maplibregl.GeoJSONSource | undefined;
		src?.setData(trackGeoJSON ?? EMPTY_FC);
```

- [ ] **Step 5: Verify the build and lint pass**

Run: `pnpm --filter @rt911/frontend exec tsc -b && pnpm --filter @rt911/frontend exec eslint src/Applications/FlightTracker`
Expected: no type errors, no lint errors. (Fix an unused `Feature`/`TRACK_LINE_COLOR` import if flagged — `TRACK_LINE_COLOR` is still used by the tube default in Task 7 and the shadow logic, so keep it.)

- [ ] **Step 6: Visual check**

Run the dev server (`pnpm dev`), open Flight Tracker, select AA11 in the flat (2D) view. Confirm the ground track shows the green→…→maroon ramp with color breaks near the sourced times, and that selecting a non-notable flight shows a plain red line.

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/src/Applications/FlightTracker/FlightTracker.tsx packages/frontend/src/Applications/FlightTracker/FlightMap.tsx
git commit -m "feat(flight-tracker): color the 2D track line per phase (#229)"
```

---

## Task 7: Color the 3D track tube per phase

**Files:**
- Modify: `packages/frontend/src/Applications/FlightTracker/trackTube.ts` (`TrackPoint`, `splineTrack`, `TrackTube`, `buildTrackTube`, `EMPTY_TUBE`)
- Modify: `packages/frontend/src/Applications/FlightTracker/trackTubeLayer.ts` (shader + attribute + uniform + buffer)
- Modify: `packages/frontend/src/Applications/FlightTracker/FlightMap.tsx:974` (drop the flat `setColor` for the track tube)
- Test: `packages/frontend/src/Applications/FlightTracker/trackTube.test.ts`

**Interfaces:**
- Consumes: `phaseColorRgb01` (Task 3), `AltitudeSample.phase` (Task 4).
- Produces: `TrackTube` gains `colors?: Float32Array` (vec3 per vertex, length `vertexCount*3`); `buildTrackTube` populates it from each vertex's phase. `buildTrailTubes` leaves it undefined (trail ribbons keep the uniform-color path).

- [ ] **Step 1: Write the failing test**

Create `packages/frontend/src/Applications/FlightTracker/trackTube.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildTrackTube } from "./trackTube";
import type { AltitudeSample } from "./flightAltitude";
import { phaseColorRgb01 } from "./flightPhases";

const S = (lon: number, phase: string): AltitudeSample => ({
	lat: 40, lon, alt_ft: 30000, utc: "2001-09-11T12:00:00Z", phase,
});

describe("buildTrackTube colors", () => {
	it("emits one vec3 color per vertex, keyed on each vertex's phase", () => {
		const tube = buildTrackTube([S(-1, "takeoff"), S(-2, "takeoff"), S(-3, "down")]);
		expect(tube.colors).toBeDefined();
		expect(tube.colors!.length).toBe(tube.vertexCount * 3);
		// takeoff green appears somewhere; down maroon appears somewhere.
		const [tr, tg, tb] = phaseColorRgb01("takeoff");
		const [dr, dg, db] = phaseColorRgb01("down");
		const colors = Array.from(tube.colors!);
		const has = (r: number, g: number, b: number) => {
			for (let i = 0; i < colors.length; i += 3) {
				if (Math.abs(colors[i] - r) < 1e-6 && Math.abs(colors[i + 1] - g) < 1e-6 && Math.abs(colors[i + 2] - b) < 1e-6) return true;
			}
			return false;
		};
		expect(has(tr, tg, tb)).toBe(true);
		expect(has(dr, dg, db)).toBe(true);
	});

	it("falls back to the default color for coarse phases", () => {
		const tube = buildTrackTube([S(-1, "cruise"), S(-2, "cruise")]);
		const [r, g, b] = phaseColorRgb01("cruise"); // default red
		expect(tube.colors![0]).toBeCloseTo(r);
		expect(tube.colors![1]).toBeCloseTo(g);
		expect(tube.colors![2]).toBeCloseTo(b);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/FlightTracker/trackTube.test.ts`
Expected: FAIL — `tube.colors` is `undefined`.

- [ ] **Step 3: Carry phase through `splineTrack` and emit colors in `buildTrackTube`**

In `trackTube.ts`:

Add the phase to `TrackPoint` (interface at lines 20-24):

```ts
export interface TrackPoint {
	lon: number;
	lat: number;
	alt_ft: number;
	phase?: string;
}
```

Add `colors` to `TrackTube` (interface at lines 72-81) and `EMPTY_TUBE`:

```ts
export interface TrackTube {
	/** vec4 per vertex: mercX, mercY, exaggerated elevation (m), mercator units per meter. */
	centers: Float32Array;
	/** vec4 per vertex: ENU unit offset (xyz = normal) + opacity multiplier (w). */
	offsets: Float32Array;
	/** vec3 per vertex: RGB (0..1). Present for the phase-colored track tube;
	 * undefined for trail ribbons (which use the layer's uniform color). */
	colors?: Float32Array;
	vertexCount: number;
}
```

```ts
const EMPTY_TUBE: TrackTube = {
	centers: new Float32Array(0),
	offsets: new Float32Array(0),
	vertexCount: 0,
};
```

In `splineTrack` (lines 48-70), propagate the phase of the segment's start point (`p1`) to its interpolated points, and the last point's own phase to the final vertex:

```ts
		for (let s = 0; s < steps; s++) {
			const t = s / steps;
			pts.push({
				lon: catmullRom(p0.lon, p1.lon, p2.lon, p3.lon, t),
				lat: catmullRom(p0.lat, p1.lat, p2.lat, p3.lat, t),
				alt_ft: catmullRom(p0.alt_ft, p1.alt_ft, p2.alt_ft, p3.alt_ft, t),
				phase: p1.phase, // hard color break at each real sample (snap-to-point)
			});
		}
	}
	const last = profile[profile.length - 1];
	pts.push({ lon: last.lon, lat: last.lat, alt_ft: last.alt_ft, phase: last.phase });
```

In `buildTrackTube`, precompute a per-point color and emit it per vertex. Add the import at the top of `trackTube.ts`:

```ts
import { phaseColorRgb01 } from "./flightPhases";
```

After `const n = pts.length;` (line 102), add:

```ts
	const pointColor = pts.map((p) => phaseColorRgb01(p.phase));
```

Change the vertex-buffer allocation (lines 149-150) to also allocate colors, and set color inside `emit`:

```ts
	const centers = new Float32Array(vertexCount * 4);
	const offsets = new Float32Array(vertexCount * 4);
	const colors = new Float32Array(vertexCount * 3);
	let v = 0;
	const emit = (ring: number, side: number) => {
		const c4 = v * 4;
		centers[c4] = cx[ring];
		centers[c4 + 1] = cy[ring];
		centers[c4 + 2] = ce[ring];
		centers[c4 + 3] = cm[ring];
		const o4 = v * 4;
		const d = dirs[ring];
		const k = side * 3;
		offsets[o4] = d[k];
		offsets[o4 + 1] = d[k + 1];
		offsets[o4 + 2] = d[k + 2];
		offsets[o4 + 3] = 1; // the selected track never fades
		const g3 = v * 3;
		const col = pointColor[ring];
		colors[g3] = col[0];
		colors[g3 + 1] = col[1];
		colors[g3 + 2] = col[2];
		v++;
	};
```

Change the return (line 178) to include colors:

```ts
	return { centers, offsets, colors, vertexCount };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/FlightTracker/trackTube.test.ts`
Expected: PASS

- [ ] **Step 5: Add the per-vertex color path to the WebGL layer**

In `trackTubeLayer.ts`:

Extend the vertex shader (`VERTEX_BODY`, lines 10-36) with a color attribute and toggle:

```glsl
in vec4 a_center; // mercX, mercY, elevExaggeratedMeters, mercUnitsPerMeter
in vec4 a_offset; // ENU unit offset from the centerline (xyz, also the normal) + fade (w)
in vec3 a_color;  // per-vertex RGB (phase color); used only when u_useVertexColor=1

uniform float u_radius; // meters
uniform vec3 u_color;
uniform float u_useVertexColor; // 1 = a_color (phase-colored tube), 0 = u_color (ribbons)
uniform float u_shaded; // 1 = light by the offset normal (tube), 0 = flat (ribbon)

out vec3 v_color;
out float v_alpha;

const vec3 LIGHT = vec3(0.30151, 0.30151, 0.90453); // pre-normalized

void main() {
	vec2 posMerc = a_center.xy + vec2(a_offset.x, -a_offset.y) * u_radius * a_center.w;
	float elevMeters = a_center.z + a_offset.z * u_radius;
#ifdef GLOBE
	gl_Position = projectTileFor3D(posMerc, elevMeters);
#else
	gl_Position = projectTileFor3D(posMerc, elevMeters * a_center.w);
#endif
	float shade = mix(1.0, 0.6 + 0.4 * max(dot(a_offset.xyz, LIGHT), 0.0), u_shaded);
	vec3 base = mix(u_color, a_color, u_useVertexColor);
	v_color = base * shade;
	v_alpha = a_offset.w;
}
```

Add the attribute-location constant (after line 53, `const A_OFFSET = 1;`):

```ts
const A_COLOR = 2;
```

Add a color buffer + storage to the class fields (near lines 99-103):

```ts
	private colorBuffer: WebGLBuffer | null = null;
	private colors: Float32Array = new Float32Array(0);
	private hasVertexColor = false;
```

Create/delete the buffer in `onAdd`/`onRemove` (lines 135-152):

```ts
	// in onAdd, after offsetBuffer:
	this.colorBuffer = this.gl.createBuffer();
```
```ts
	// in onRemove, inside `if (gl)`:
	if (this.colorBuffer) gl.deleteBuffer(this.colorBuffer);
```

Store colors in `setGeometry` (lines 120-126):

```ts
	setGeometry(tube: TrackTube): void {
		this.centers = tube.centers;
		this.offsets = tube.offsets;
		this.colors = tube.colors ?? new Float32Array(0);
		this.hasVertexColor = (tube.colors?.length ?? 0) > 0;
		this.vertexCount = tube.vertexCount;
		this.geometryDirty = true;
		this.map?.triggerRepaint();
	}
```

Bind `a_color` in `getProgram` (after the `bindAttribLocation` calls, line 184) and register the uniform (line 194-196 list):

```ts
	gl.bindAttribLocation(program, A_COLOR, "a_color");
```
```ts
	for (const name of [
		...PROJECTION_UNIFORMS, "u_color", "u_radius", "u_opacity", "u_shaded", "u_useVertexColor",
	]) {
```

In `render`, set the toggle uniform and upload/enable the color attribute (near lines 230-240):

```ts
	if (u.u_shaded) gl.uniform1f(u.u_shaded, this.shaded ? 1 : 0);
	if (u.u_useVertexColor) gl.uniform1f(u.u_useVertexColor, this.hasVertexColor ? 1 : 0);
```
```ts
	gl.bindBuffer(gl.ARRAY_BUFFER, this.offsetBuffer);
	if (this.geometryDirty) gl.bufferData(gl.ARRAY_BUFFER, this.offsets, gl.DYNAMIC_DRAW);
	gl.enableVertexAttribArray(A_OFFSET);
	gl.vertexAttribPointer(A_OFFSET, 4, gl.FLOAT, false, 0, 0);
	if (this.hasVertexColor) {
		gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
		if (this.geometryDirty) gl.bufferData(gl.ARRAY_BUFFER, this.colors, gl.DYNAMIC_DRAW);
		gl.enableVertexAttribArray(A_COLOR);
		gl.vertexAttribPointer(A_COLOR, 3, gl.FLOAT, false, 0, 0);
	}
	this.geometryDirty = false;
```

And disable it after the draw (near lines 249-250):

```ts
	gl.disableVertexAttribArray(A_CENTER);
	gl.disableVertexAttribArray(A_OFFSET);
	if (this.hasVertexColor) gl.disableVertexAttribArray(A_COLOR);
```

- [ ] **Step 6: Stop forcing a flat tube color in `FlightMap.tsx`**

The track tube now carries its own per-vertex colors, so the flat `setColor` at line 974 is redundant (and for non-notable flights the vertex colors are the same default red). Leave `trackTube.setColor(TRACK_LINE_COLOR)` in place as the fallback for any tube built without colors — it is harmless (u_useVertexColor=0 only when colors are empty). No change required at line 974; the trail tube keeps its `setColor` at line 984. Confirm no other caller sets the track tube color.

- [ ] **Step 7: Verify build, lint, and full test run**

Run: `pnpm --filter @rt911/frontend exec tsc -b && pnpm --filter @rt911/frontend exec eslint src/Applications/FlightTracker && pnpm --filter @rt911/frontend exec vitest run src/Applications/FlightTracker`
Expected: clean build, no lint errors, all tests pass.

- [ ] **Step 8: Visual check (3D)**

Run `pnpm dev`, select AA11, right-drag to pitch into the 3D view. Confirm the elevated tube shows the phase color ramp (not flat red), the flat ground line drops to its shadow color, and a non-notable flight's tube renders red as before.

- [ ] **Step 9: Commit**

```bash
git add packages/frontend/src/Applications/FlightTracker/trackTube.ts packages/frontend/src/Applications/FlightTracker/trackTubeLayer.ts packages/frontend/src/Applications/FlightTracker/trackTube.test.ts
git commit -m "feat(flight-tracker): per-phase color on the 3D track tube (#229)"
```

---

## Deployment note (not a code task)

The enriched `phase` values only appear after the notable loader re-runs against the database. Per `packages/tools/flight-recon/CLAUDE.md` and `notable.py`'s docstring, run a `--dry-run` first, then the scoped load (deletes/rewrites only the 5 notable flight IDs). The selected track is read from Directus REST, so no streamer cache rewarm is needed. Loading synthesized 9/11 paths to prod is gated on the human PROD-LOAD REVIEW GATE — leave the actual prod run to the user.

---

## Self-Review

**Spec coverage:**
- 8-phase taxonomy + Taxi-folds-into-Takeoff → Tasks 1-2 (curated boundaries, no `taxi` slug). ✓
- Escalation-ramp palette → Task 3 `PHASE_COLORS`. ✓
- Snap-to-nearest-real-point, no synthetic vertices → Task 1 interval assignment + Task 7 `splineTrack` uses `p1.phase` (hard break at real samples). ✓
- Event-time ordering (UA93 atc_alert before course_change) → Task 1 sorts boundaries by time; Task 2 UA93 JSON authored that way + `test_assign_curated_phases_out_of_list_order_by_time`. ✓
- 2D line + 3D tube both colored → Tasks 6 and 7. ✓
- Notable-only scope → Task 6 `isNotable` gate; Task 3 default color keeps non-notable red. ✓
- No backend/wire change → confirmed; only pipeline + frontend touched. ✓
- Out of scope (streamer, trails, Taxi, legend) → not implemented; trail ribbons keep the uniform-color path (Task 7 `colors?` optional). ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `AltitudeSample.phase?` (Task 4) flows into `buildTrackSegments` points (Task 5/6) and `buildTrackTube` via `TrackPoint.phase?` (Task 7). `TrackTube.colors?` optional so `buildTrailTubes` is unaffected. `trackGeoJSON` widened to `FeatureCollection` in both the producer (FlightTracker) and consumer (FlightMap prop type). `phaseColorRgb01`/`phaseColorHex`/`phaseLineColorExpression` names match across Tasks 3, 6, 7.
