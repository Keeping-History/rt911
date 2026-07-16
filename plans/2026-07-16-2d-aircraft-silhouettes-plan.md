# 2D Per-Family Aircraft Silhouettes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 2D map mode renders each flight with its airframe family's true top-down silhouette (Wasabi-hosted SVGs), scaled relative to real aircraft size, instead of one generic plane icon.

**Architecture:** An offline script projects the 15 normalized family STLs top-down into tiny single-path SVGs and uploads them to Wasabi. At runtime a lazy per-family fetch cache (mirroring `aircraftModels.ts`) pulls each silhouette the first time its family appears, colorizes/rasterizes it through the existing `flightIcons` pipeline at a family-relative size, and registers it as `plane-<family>` / `plane-notable-<family>`. Features carry a new `family` property and all three symbol layers pick images via a `coalesce`/`image` expression that falls back to the generic icon until (or unless) a family's image registers.

**Tech Stack:** Python 3 + shapely (offline, one-off), TypeScript + MapLibre GL + Vitest (frontend).

**Spec:** `plans/2026-07-16-2d-aircraft-silhouettes-design.md`

## Global Constraints

- Frontend tests: `pnpm --filter @rt911/frontend exec vitest run <file>` from the repo root; full suite `pnpm test`.
- No RTL auto-cleanup in this repo — every NEW test file needs `afterEach(cleanup)` (`import { cleanup } from "@testing-library/react"`).
- Indentation is tabs in `packages/frontend` TypeScript; match surrounding style.
- This worktree has unrelated dirty files (`Browser.scss`, `TV.tsx`, an untracked zip). `git add` explicit paths only — never `git add -A`.
- The pre-commit hook may bump `classicy` in `pnpm-lock.yaml`; that riding along is expected (root CLAUDE.md).
- Icon SVGs must be a single `<path>` with **no fill attribute** (root-fill inheritance is what `colorizeSvg` relies on) and **nose pointing right** (all layers share `icon-rotate: heading − 90`).
- Wasabi hosting path: `maps/aircraft/icons/<family>.svg` on bucket `files.911realtime.org` (the `/maps` Ingress path is prefix-based — no infra change needed).
- The 15 families are the `AircraftFamily` union in `packages/frontend/src/Applications/FlightTracker/aircraftModels.ts:13-15`: `generic b737 b757 b767 b777 b727 md80 dc10 a319 a320 crj erj atr bizjet dc3`.

---

### Task 1: Offline silhouette bake + Wasabi upload

**Files:**
- Modify: `scripts/aircraft-models/make_icons.py`
- Modify: `scripts/aircraft-models/README.md`

**Interfaces:**
- Consumes: normalized family STLs at `https://files.911realtime.org/maps/aircraft/<family>.stl` (nose→+Y, fin→+Z, ≤6k tris); `parse_stl` from `scripts/aircraft-models/preview.py`.
- Produces: `https://files.911realtime.org/maps/aircraft/icons/<family>.svg` for all 15 families — single `<path fill-rule="evenodd">`, no fill, nose right, 256×256 viewBox, ~1–3 KB. Task 4's runtime fetcher reads these URLs.

No unit tests — one-off pipeline script per this directory's convention; verification is the contact sheet + curl.

- [ ] **Step 1: Download the normalized STLs**

```bash
cd scripts/aircraft-models
mkdir -p processed
for f in generic b737 b757 b767 b777 b727 md80 dc10 a319 a320 crj erj atr bizjet dc3; do
  curl -fsS -o processed/$f.stl https://files.911realtime.org/maps/aircraft/$f.stl
done
ls -la processed/*.stl   # expect 15 files, each well under ~1 MB
pip install shapely      # one-off dep for the union+simplify step (skip if installed)
```

- [ ] **Step 2: Rewrite `make_icons.py` for simplified single-path silhouettes**

Replace the whole file with:

```python
#!/usr/bin/env python3
"""Top-down silhouette SVG icons from NORMALIZED family STLs (the processed
maps/aircraft/<family>.stl assets: nose -> +Y, fin -> +Z), for the 2D map
mode. Each icon is one simplified <path> (~1-3 KB) with no fill of its own
(the frontend's colorizeSvg injects the pin color on the root <svg>), nose
pointing RIGHT to match plane.svg's east-facing convention (the symbol
layers all rotate by heading - 90).

Requires shapely (union + simplify). Writes <dir>/icons/<name>.svg plus an
icons.html contact sheet next to them.

Run: python3 make_icons.py processed
"""
import sys
from pathlib import Path

from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import unary_union

from preview import parse_stl  # reuse the STL parser

SIZE = 256


def silhouette_svg(tris, size=SIZE):
    # Normalized models: drop Z for the top-down view. svg x = model y puts
    # the nose (+Y) at +x (right); svg y = model x is lateral (symmetric, so
    # the mirror direction is irrelevant).
    polys = []
    for t in tris:
        p = Polygon([(v[1], v[0]) for v in t])
        if p.area > 1e-12:
            polys.append(p if p.is_valid else p.buffer(0))
    merged = unary_union(polys)
    minx, miny, maxx, maxy = merged.bounds
    span = max(maxx - minx, maxy - miny)
    # Morphological close seals hairline gaps between decimated triangles,
    # then simplify collapses the triangle-soup boundary to a clean outline.
    merged = merged.buffer(span * 0.01).buffer(-span * 0.01)
    merged = merged.simplify(span * 0.004)
    minx, miny, maxx, maxy = merged.bounds
    span = max(maxx - minx, maxy - miny)
    cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
    scale = (size * 0.92) / span

    def ring(coords):
        pts = [
            f"{size / 2 + (x - cx) * scale:.1f} {size / 2 - (y - cy) * scale:.1f}"
            for x, y in coords
        ]
        return "M" + "L".join(pts) + "Z"

    geoms = merged.geoms if isinstance(merged, MultiPolygon) else [merged]
    d = "".join(
        ring(g.exterior.coords) + "".join(ring(i.coords) for i in g.interiors)
        for g in geoms
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
        f'viewBox="0 0 {size} {size}"><path fill-rule="evenodd" d="{d}"/></svg>'
    )


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent
    out = src / "icons"
    out.mkdir(exist_ok=True)
    cards = []
    for stl in sorted(src.glob("*.stl")):
        try:
            tris = parse_stl(stl)
        except Exception as exc:  # noqa: BLE001
            print(f"SKIP {stl.name}: {exc}", file=sys.stderr)
            continue
        if not tris:
            continue
        svg = silhouette_svg(tris)
        dest = out / (stl.stem + ".svg")
        dest.write_text(svg)
        cards.append(
            f'<div class="card"><img src="icons/{dest.name}" width="180" height="180">'
            f"<p>{dest.name}</p></div>"
        )
        print(f"{dest.name}: {dest.stat().st_size} bytes")
    (src / "icons.html").write_text(
        "<!doctype html><meta charset='utf-8'><title>Top-down icons</title>"
        "<style>body{font:13px sans-serif;display:flex;flex-wrap:wrap;gap:12px;"
        "padding:12px}.card{border:1px solid #ccc;padding:6px;text-align:center}"
        "img{background:#f5f2ea}</style>" + "".join(cards)
    )
    print(f"wrote icons.html with {len(cards)} icons")


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Generate and eyeball**

```bash
cd scripts/aircraft-models
python3 make_icons.py processed
```

Expected: 15 lines like `b767.svg: 2 100 bytes` (each ≤ ~5 000 bytes; if one is 10× the others, raise the simplify factor from `0.004` to `0.008` for that run and regenerate). Open `processed/icons.html` in a browser and check every silhouette: **nose points right**, shape reads as that aircraft (T-tail on the 727, wide body on the 777/DC-10, props on the DC-3/ATR), no stray speckles.

- [ ] **Step 4: Upload to Wasabi**

Credentials come from the `video-grabber-secrets` k8s secret (this box is the k3s node). Wasabi rejects modern boto3 default checksums — the `when_required` config lines are load-bearing (same gotcha as `scripts/build-terrain-dem.md`).

```bash
cd scripts/aircraft-models
export WASABI_ACCESS_KEY_ID=$(kubectl get secret video-grabber-secrets -n video-grabber -o jsonpath='{.data.WASABI_ACCESS_KEY_ID}' | base64 -d)
export WASABI_SECRET_ACCESS_KEY=$(kubectl get secret video-grabber-secrets -n video-grabber -o jsonpath='{.data.WASABI_SECRET_ACCESS_KEY}' | base64 -d)
python3 - <<'EOF'
import os
from pathlib import Path

import boto3
from botocore.config import Config

s3 = boto3.client(
    "s3",
    endpoint_url="https://s3.us-central-1.wasabisys.com",
    region_name="us-central-1",
    aws_access_key_id=os.environ["WASABI_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["WASABI_SECRET_ACCESS_KEY"],
    config=Config(
        signature_version="s3v4",
        s3={"addressing_style": "path"},
        request_checksum_calculation="when_required",
        response_checksum_validation="when_required",
    ),
)
for svg in sorted(Path("processed/icons").glob("*.svg")):
    s3.upload_file(
        str(svg), "files.911realtime.org", f"maps/aircraft/icons/{svg.name}",
        ExtraArgs={"ContentType": "image/svg+xml"},
    )
    print("uploaded", svg.name)
EOF
```

Expected: 15 `uploaded <family>.svg` lines.

- [ ] **Step 5: Verify over the file proxy**

```bash
for f in generic b737 b757 b767 b777 b727 md80 dc10 a319 a320 crj erj atr bizjet dc3; do
  curl -fsS -o /dev/null -w "%{http_code} %{size_download} $f\n" \
    https://files.911realtime.org/maps/aircraft/icons/$f.svg
done
```

Expected: 15 lines of `200 <bytes>`. (A bare first-hit anomaly like the terrain upload saw resolves on the second request.)

- [ ] **Step 6: Document in the README**

In `scripts/aircraft-models/README.md`, replace the sentence fragment in step 4 of "Rebuilding from scratch":

```markdown
4. Review helpers: `preview.py` renders any directory of STLs to an
   isometric contact sheet; `make_icons.py` emits top-down silhouette SVGs
   (candidate 2D icons) into `icons/`.
```

with:

```markdown
4. Review helpers: `preview.py` renders any directory of STLs to an
   isometric contact sheet. `python3 make_icons.py processed` emits the 2D
   map icons — simplified single-path top-down silhouettes (nose RIGHT,
   no fill; requires shapely) — into `processed/icons/`, plus an
   `icons.html` contact sheet. These are uploaded to Wasabi under
   `maps/aircraft/icons/<family>.svg` and are derivatives of the same
   models, so `models.json`'s attribution covers them.
```

- [ ] **Step 7: Commit**

```bash
git add scripts/aircraft-models/make_icons.py scripts/aircraft-models/README.md
git commit -m "feat(flight-tracker): bake simplified top-down silhouette icons from family STLs

Uploaded to Wasabi maps/aircraft/icons/<family>.svg for the 2D map mode.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(`processed/` stays untracked — it's a scratch dir of downloaded assets.)

---

### Task 2: Family size table + icon-id helpers in `flightIcons.ts`

**Files:**
- Modify: `packages/frontend/src/Applications/FlightTracker/flightIcons.ts`
- Test: `packages/frontend/src/Applications/FlightTracker/flightIcons.test.ts` (exists — extend)

**Interfaces:**
- Consumes: `AircraftFamily` type from `./aircraftModels`.
- Produces (used by Task 5):
  - `FAMILY_ICON_PX: Record<AircraftFamily, number>`
  - `familyIconId(family: string): string` → `"plane-<family>"`
  - `familyNotableIconId(family: string): string` → `"plane-notable-<family>"`
  - `familyIconPx(family: string): number` (unknown → `PLANE_ICON_PX`)
  - `familyNotableIconPx(family: string): number` (proportional around `PLANE_NOTABLE_ICON_PX`)

- [ ] **Step 1: Write the failing tests**

Append to `flightIcons.test.ts` (inside the existing `describe`, or a new `describe("family icons")` block alongside it):

```ts
describe("family icon sizing and ids", () => {
	it("has a size for every aircraft family, within the 9-16px band", () => {
		const families: AircraftFamily[] = [
			"generic", "b737", "b757", "b767", "b777", "b727", "md80",
			"dc10", "a319", "a320", "crj", "erj", "atr", "bizjet", "dc3",
		];
		for (const f of families) {
			expect(FAMILY_ICON_PX[f], f).toBeGreaterThanOrEqual(9);
			expect(FAMILY_ICON_PX[f], f).toBeLessThanOrEqual(16);
		}
		expect(Object.keys(FAMILY_ICON_PX)).toHaveLength(families.length);
	});

	it("keeps generic at the legacy 12px slot", () => {
		expect(FAMILY_ICON_PX.generic).toBe(PLANE_ICON_PX);
	});

	it("orders sizes by real aircraft size", () => {
		expect(FAMILY_ICON_PX.b777).toBeGreaterThan(FAMILY_ICON_PX.b757);
		expect(FAMILY_ICON_PX.b757).toBeGreaterThan(FAMILY_ICON_PX.crj);
	});

	it("builds image ids from the family", () => {
		expect(familyIconId("b767")).toBe("plane-b767");
		expect(familyNotableIconId("b767")).toBe("plane-notable-b767");
	});

	it("scales notable px proportionally around the 32px slot", () => {
		// b767 is 15px regular -> round(32 * 15 / 12) = 40
		expect(familyNotableIconPx("b767")).toBe(40);
		expect(familyNotableIconPx("generic")).toBe(PLANE_NOTABLE_ICON_PX);
	});

	it("falls back to the generic sizes for unknown families", () => {
		expect(familyIconPx("nonsense")).toBe(PLANE_ICON_PX);
		expect(familyNotableIconPx("nonsense")).toBe(PLANE_NOTABLE_ICON_PX);
	});
});
```

Add to the file's imports: `FAMILY_ICON_PX, familyIconId, familyIconPx, familyNotableIconId, familyNotableIconPx` from `./flightIcons` and `import type { AircraftFamily } from "./aircraftModels";`. If the existing file lacks `afterEach(cleanup)` it's pure-logic (no render) — leave its existing conventions alone.

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @rt911/frontend exec vitest run src/Applications/FlightTracker/flightIcons.test.ts
```

Expected: FAIL — `FAMILY_ICON_PX` etc. not exported.

- [ ] **Step 3: Implement in `flightIcons.ts`**

Append (and add the type import at the top):

```ts
import type { AircraftFamily } from "./aircraftModels";
```

```ts
// Per-family display sizes for the 2D silhouettes (issue: 2D per-family
// icons). Span-based: floor 9px keeps regional jets clickable, cap 16px
// keeps wide-bodies inside their symbol slot at national zoom. generic
// stays at the legacy PLANE_ICON_PX so the fallback icon's size is
// unchanged. The zoom icon-size expression multiplies on top of these.
export const FAMILY_ICON_PX: Record<AircraftFamily, number> = {
	generic: 12,
	b727: 12,
	b737: 12,
	b757: 13,
	b767: 15,
	b777: 16,
	md80: 12,
	dc10: 15,
	a319: 12,
	a320: 12,
	crj: 9,
	erj: 9,
	atr: 10,
	bizjet: 9,
	dc3: 11,
};

export const familyIconId = (family: string): string => `plane-${family}`;
export const familyNotableIconId = (family: string): string => `plane-notable-${family}`;

export const familyIconPx = (family: string): number =>
	FAMILY_ICON_PX[family as AircraftFamily] ?? PLANE_ICON_PX;

// Notables keep their 32px-class slot; only the shape's relative size varies.
export const familyNotableIconPx = (family: string): number =>
	Math.round((PLANE_NOTABLE_ICON_PX * familyIconPx(family)) / PLANE_ICON_PX);
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @rt911/frontend exec vitest run src/Applications/FlightTracker/flightIcons.test.ts
```

Expected: PASS (all pre-existing tests too).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/FlightTracker/flightIcons.ts packages/frontend/src/Applications/FlightTracker/flightIcons.test.ts
git commit -m "feat(flight-tracker): per-family 2D icon sizes and image-id helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `family` property on flight features

**Files:**
- Modify: `packages/frontend/src/Applications/FlightTracker/flightGeoJSON.ts`
- Modify: `packages/frontend/src/Applications/FlightTracker/flightMotion.ts:152-175` (`motionPointsToGeoJSON`)
- Test: `packages/frontend/src/Applications/FlightTracker/flightGeoJSON.test.ts`, `packages/frontend/src/Applications/FlightTracker/flightMotion.test.ts` (both exist — extend)

**Interfaces:**
- Consumes: `FlightMotion` (has `item: FlightPosition` with `.flight` / `.start_date`).
- Produces (used by Task 5):
  - `FlightFeature.properties.family: string`
  - `motionPointsToGeoJSON(buffer, now, landing?, familyOf?: (m: FlightMotion) => string)` — 4th optional param; omitted → every feature gets `family: "generic"`.

- [ ] **Step 1: Write the failing tests**

In `flightGeoJSON.test.ts`, extend the existing `flightsToGeoJSON` assertions (or add):

```ts
it("stamps the static builder's features with the generic family", () => {
	const fc = flightsToGeoJSON([
		{ id: 1, flight: "AA1002", start_date: "2001-09-11T13:00:00Z", lat: 40, lon: -74, alt_ft: 30000 },
	]);
	expect(fc.features[0].properties.family).toBe("generic");
});
```

In `flightMotion.test.ts` (reuse its existing position/buffer helpers — it already builds `MotionBuffer`s via `updateMotion`):

```ts
it("motionPointsToGeoJSON defaults family to generic without a resolver", () => {
	const buf: MotionBuffer = new Map();
	updateMotion(buf, [pos({ flight: "AA11" })]);
	const fc = motionPointsToGeoJSON(buf, Date.parse("2001-09-11T13:00:00Z"));
	expect(fc.features[0].properties.family).toBe("generic");
});

it("motionPointsToGeoJSON stamps each feature via the familyOf resolver", () => {
	const buf: MotionBuffer = new Map();
	updateMotion(buf, [pos({ flight: "AA11" })]);
	const fc = motionPointsToGeoJSON(
		buf,
		Date.parse("2001-09-11T13:00:00Z"),
		undefined,
		(m) => (m.item.flight === "AA11" ? "b767" : "generic"),
	);
	expect(fc.features[0].properties.family).toBe("b767");
});
```

(`pos` here means that file's existing `FlightPosition` factory — reuse whatever helper it already defines rather than inventing a second one; if it has none, add one matching `FlightMap.test.tsx:167-170`.)

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @rt911/frontend exec vitest run src/Applications/FlightTracker/flightGeoJSON.test.ts src/Applications/FlightTracker/flightMotion.test.ts
```

Expected: FAIL — `properties.family` is undefined / TS error on the 4th argument.

- [ ] **Step 3: Implement**

`flightGeoJSON.ts` — add to `FlightFeature["properties"]` after `heading`:

```ts
		// Airframe family (aircraftModels.AircraftFamily) — drives the
		// per-family 2D silhouette via the layers' data-driven icon-image.
		family: string;
```

and in `flightsToGeoJSON`'s properties:

```ts
				family: "generic", // static builder — no route-index context
```

`flightMotion.ts` — change `motionPointsToGeoJSON`'s signature and properties:

```ts
export function motionPointsToGeoJSON(
	buffer: MotionBuffer,
	now: number,
	landing?: LandingClock,
	// Airframe family resolver (FlightMap threads aircraftFamilyOf); omitted
	// (static/test call sites) stamps everything generic.
	familyOf?: (m: FlightMotion) => string,
): FlightFeatureCollection {
```

and inside the feature's `properties`:

```ts
				family: familyOf?.(m) ?? "generic",
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @rt911/frontend exec vitest run src/Applications/FlightTracker/flightGeoJSON.test.ts src/Applications/FlightTracker/flightMotion.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/FlightTracker/flightGeoJSON.ts packages/frontend/src/Applications/FlightTracker/flightGeoJSON.test.ts packages/frontend/src/Applications/FlightTracker/flightMotion.ts packages/frontend/src/Applications/FlightTracker/flightMotion.test.ts
git commit -m "feat(flight-tracker): stamp flight features with their airframe family

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `aircraftIcons.ts` — lazy per-family SVG fetch cache

**Files:**
- Create: `packages/frontend/src/Applications/FlightTracker/aircraftIcons.ts`
- Test: `packages/frontend/src/Applications/FlightTracker/aircraftIcons.test.ts` (new)

**Interfaces:**
- Consumes: `AircraftFamily` from `./aircraftModels`; `VITE_AIRCRAFT_MODELS_URL` env (same base as the STLs).
- Produces (used by Task 5):
  - `loadAircraftIconSvg(family: AircraftFamily): Promise<string | null>` — SVG text, or `null` on any failure (no retry).
  - `resetAircraftIconCache(): void` — test seam.

- [ ] **Step 1: Write the failing tests**

Create `aircraftIcons.test.ts` (pure-logic module — no render, so no `cleanup` needed; mirror `aircraftModels.test.ts`'s fetch stubbing style):

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAircraftIconSvg, resetAircraftIconCache } from "./aircraftIcons";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0Z"/></svg>';

const okResponse = () =>
	({ ok: true, text: async () => SVG }) as unknown as Response;

describe("loadAircraftIconSvg", () => {
	afterEach(() => {
		resetAircraftIconCache();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("fetches the family's icon SVG from the icons path", async () => {
		const fetchMock = vi.fn(async () => okResponse());
		vi.stubGlobal("fetch", fetchMock);
		const svg = await loadAircraftIconSvg("b767");
		expect(svg).toBe(SVG);
		expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/icons\/b767\.svg$/));
	});

	it("caches per family — second call does not refetch", async () => {
		const fetchMock = vi.fn(async () => okResponse());
		vi.stubGlobal("fetch", fetchMock);
		await loadAircraftIconSvg("b757");
		await loadAircraftIconSvg("b757");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("resolves null on HTTP failure without throwing, and caches the failure", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response);
		vi.stubGlobal("fetch", fetchMock);
		expect(await loadAircraftIconSvg("crj")).toBeNull();
		expect(await loadAircraftIconSvg("crj")).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("resolves null on network error", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
		expect(await loadAircraftIconSvg("atr")).toBeNull();
	});

	it("reset seam forgets settled loads", async () => {
		const fetchMock = vi.fn(async () => okResponse());
		vi.stubGlobal("fetch", fetchMock);
		await loadAircraftIconSvg("dc10");
		resetAircraftIconCache();
		await loadAircraftIconSvg("dc10");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @rt911/frontend exec vitest run src/Applications/FlightTracker/aircraftIcons.test.ts
```

Expected: FAIL — module `./aircraftIcons` does not exist.

- [ ] **Step 3: Implement `aircraftIcons.ts`**

```ts
import type { AircraftFamily } from "./aircraftModels";

// Top-down silhouette SVGs for the 2D map mode, hosted alongside the 3D
// models (scripts/aircraft-models/make_icons.py bakes them from the same
// normalized STLs). Same lazy-cache shape as aircraftModels.loadAircraftMesh.

const ICON_BASE_URL =
	(import.meta.env.VITE_AIRCRAFT_MODELS_URL as string | undefined) ??
	"https://files.911realtime.org/maps/aircraft";

// One in-flight/settled promise per family; failures resolve null so a bad
// asset degrades to the generic icon rather than retry-storming.
const svgPromises = new Map<AircraftFamily, Promise<string | null>>();

/** Fetch a family's silhouette SVG text, cached forever (assets are immutable). */
export function loadAircraftIconSvg(family: AircraftFamily): Promise<string | null> {
	let p = svgPromises.get(family);
	if (!p) {
		p = fetch(`${ICON_BASE_URL}/icons/${family}.svg`)
			.then(async (res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return res.text();
			})
			.catch((err: unknown) => {
				console.warn(`aircraft icon ${family} unavailable:`, err);
				return null;
			});
		svgPromises.set(family, p);
	}
	return p;
}

/** Test seam: forget cached loads (jsdom tests stub fetch per case). */
export function resetAircraftIconCache(): void {
	svgPromises.clear();
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @rt911/frontend exec vitest run src/Applications/FlightTracker/aircraftIcons.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/FlightTracker/aircraftIcons.ts packages/frontend/src/Applications/FlightTracker/aircraftIcons.test.ts
git commit -m "feat(flight-tracker): lazy per-family silhouette SVG cache

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Wire family icons into `FlightMap`

**Files:**
- Modify: `packages/frontend/src/Applications/FlightTracker/FlightMap.tsx`
- Test: `packages/frontend/src/Applications/FlightTracker/FlightMap.test.tsx` (extend)

**Interfaces:**
- Consumes: everything Tasks 2–4 produced — `familyIconId`, `familyNotableIconId`, `familyIconPx`, `familyNotableIconPx` (`./flightIcons`); `loadAircraftIconSvg` (`./aircraftIcons`); `motionPointsToGeoJSON(..., familyOf)` + `FlightMotion` type (`./flightMotion`); existing `aircraftFamilyOf` prop (`FlightMap.tsx:168`).
- Produces: the user-visible feature. No new exports.

Anchor points in `FlightMap.tsx` (line numbers as of this plan): imports `flightIcons` at 20-26 / `flightMotion` at 27-38; `installPlaneIcons` at 85-102; load handler source+layers at 494-583; icon install at 538; RAF-loop `motionPointsToGeoJSON` call at 1012; color-change effect at 876-881.

- [ ] **Step 1: Write the failing tests**

In `FlightMap.test.tsx`, add a module mock next to the existing `vi.mock("./flightIcons", ...)` (line ~149):

```ts
// Family silhouettes resolve instantly with a recognizable per-family svg;
// individual tests override the implementation to simulate failures.
vi.mock("./aircraftIcons", () => ({
	loadAircraftIconSvg: vi.fn(async (family: string) => `<svg data-family="${family}"/>`),
}));
```

Import at the top with the other imports:

```ts
import { loadAircraftIconSvg } from "./aircraftIcons";
import { buildPlaneImage } from "./flightIcons";
```

Add a `describe("per-family 2D icons")` block (inside the outer `describe`, sharing its `beforeEach`/`afterEach`):

```ts
describe("per-family 2D icons", () => {
	const renderWithFamily = (familyOf?: (flight: string, startDate: string) => string) =>
		render(
			<FlightMap positions={[pos({ id: 5, flight: "AA11" })]} basemapUrls={TEST_URLS}
				trackGeoJSON={null} nowMs={Date.parse("2001-09-11T13:00:00Z")} playing={false}
				onSelectFlight={() => {}} onClearSelection={() => {}}
				darkMap={false} mapStyle="classic" pinColor="#3a3a3a" notablePinColor="#c0202a"
				radarSweep={false} trailMultiplier={1} aircraftFamilyOf={familyOf} />,
		);

	it("uses a family-driven icon-image expression with a generic fallback on all three plane layers", () => {
		renderWithFamily();
		FakeMap.last!.fire("load");
		const layer = (id: string) =>
			FakeMap.last!.layers.find((l) => l.id === id) as { layout: Record<string, unknown> };
		for (const id of ["flights-dots", "cluster-planes"]) {
			expect(layer(id).layout["icon-image"]).toEqual([
				"coalesce",
				["image", ["concat", "plane-", ["get", "family"]]],
				["image", "plane-icon"],
			]);
		}
		expect(layer("flights-notable").layout["icon-image"]).toEqual([
			"coalesce",
			["image", ["concat", "plane-notable-", ["get", "family"]]],
			["image", "plane-notable-icon"],
		]);
	});

	it("stamps features with the resolved family and registers that family's images", async () => {
		renderWithFamily(() => "b767");
		const map = FakeMap.last!;
		await act(async () => { map.fire("load"); });
		const fc = map.sources["flights"].data as { features: { properties: { family: string } }[] };
		expect(fc.features[0].properties.family).toBe("b767");
		expect(loadAircraftIconSvg).toHaveBeenCalledWith("b767");
		expect(map.images["plane-b767"]).toBeTruthy();
		expect(map.images["plane-notable-b767"]).toBeTruthy();
		// Sizes: regular at FAMILY_ICON_PX.b767=15, notable at round(32*15/12)=40.
		expect(buildPlaneImage).toHaveBeenCalledWith('<svg data-family="b767"/>', "#3a3a3a", 15);
		expect(buildPlaneImage).toHaveBeenCalledWith('<svg data-family="b767"/>', "#c0202a", 40);
	});

	it("never fetches an icon for the generic family", async () => {
		renderWithFamily(); // no resolver -> family "generic"
		await act(async () => { FakeMap.last!.fire("load"); });
		expect(loadAircraftIconSvg).not.toHaveBeenCalled();
	});

	it("re-tints loaded family icons when the pin colors change", async () => {
		const view = renderWithFamily(() => "b757");
		const map = FakeMap.last!;
		await act(async () => { map.fire("load"); });
		expect(map.images["plane-b757"]).toBeTruthy();
		await act(async () => {
			view.rerender(
				<FlightMap positions={[pos({ id: 5, flight: "AA11" })]} basemapUrls={TEST_URLS}
					trackGeoJSON={null} nowMs={Date.parse("2001-09-11T13:00:00Z")} playing={false}
					onSelectFlight={() => {}} onClearSelection={() => {}}
					darkMap={false} mapStyle="classic" pinColor="#00ff00" notablePinColor="#c0202a"
					radarSweep={false} trailMultiplier={1} aircraftFamilyOf={() => "b757"} />,
			);
		});
		expect((map.updatedImages["plane-b757"] as { fill: string }).fill).toBe("#00ff00");
	});

	it("leaves the family unregistered when the icon fetch fails (fallback keeps rendering)", async () => {
		vi.mocked(loadAircraftIconSvg).mockResolvedValueOnce(null);
		renderWithFamily(() => "crj");
		const map = FakeMap.last!;
		await act(async () => { map.fire("load"); });
		expect(map.images["plane-crj"]).toBeUndefined();
	});
});
```

Note: the existing `afterEach` already runs `vi.clearAllMocks()`, which resets the `loadAircraftIconSvg` mock's call log between tests but ALSO clears mock implementations set via `vi.mock` factories' `vi.fn(impl)` — verify after writing: if the second test's mock stops returning the svg after `clearAllMocks`, switch the factory to a plain function delegating to a `vi.hoisted` spy, or re-set the implementation in `beforeEach`:

```ts
beforeEach(() => {
	vi.mocked(loadAircraftIconSvg).mockImplementation(
		async (family: string) => `<svg data-family="${family}"/>`,
	);
});
```

(Adding this `beforeEach` inside the new describe block unconditionally is the simplest safe choice — do that.)

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @rt911/frontend exec vitest run src/Applications/FlightTracker/FlightMap.test.tsx
```

Expected: FAIL — icon-image is still the plain string ids; no `plane-b767` image; features lack `family`.

- [ ] **Step 3: Implement in `FlightMap.tsx`**

a) Extend the `./flightIcons` import (lines 20-26):

```ts
import {
	PLANE_ICON_ID,
	PLANE_ICON_PX,
	PLANE_NOTABLE_ICON_ID,
	PLANE_NOTABLE_ICON_PX,
	buildPlaneImage,
	familyIconId,
	familyIconPx,
	familyNotableIconId,
	familyNotableIconPx,
} from "./flightIcons";
```

Add `type FlightMotion` to the `./flightMotion` import block (lines 27-38), and next to the `aircraftModels` import (line 56):

```ts
import { loadAircraftIconSvg } from "./aircraftIcons";
```

b) After `installPlaneIcons` (line 102), add the per-family installer and the shared icon-image expressions:

```ts
// Per-family silhouette variant of installPlaneIcons: same colorize +
// rasterize pipeline, at the family's relative display size.
async function installFamilyIcon(
	map: maplibregl.Map,
	family: string,
	svg: string,
	pinColor: string,
	notablePinColor: string,
) {
	try {
		const [regular, notable] = await Promise.all([
			buildPlaneImage(svg, pinColor, familyIconPx(family)),
			buildPlaneImage(svg, notablePinColor, familyNotableIconPx(family)),
		]);
		const id = familyIconId(family);
		const notableId = familyNotableIconId(family);
		if (map.hasImage(id)) map.updateImage(id, regular);
		else map.addImage(id, regular, { pixelRatio: 2 });
		if (map.hasImage(notableId)) map.updateImage(notableId, notable);
		else map.addImage(notableId, notable, { pixelRatio: 2 });
	} catch (err) {
		console.warn(`family icon ${family} unavailable:`, err);
	}
}

// Data-driven icon choice: the family's silhouette once its image has
// registered, the generic icon until then (["image", id] only resolves for
// registered images, so coalesce falls through cleanly). Prefixes must
// match flightIcons.familyIconId / familyNotableIconId.
const FAMILY_ICON_IMAGE = [
	"coalesce",
	["image", ["concat", "plane-", ["get", "family"]]],
	["image", PLANE_ICON_ID],
] as unknown as maplibregl.ExpressionSpecification;
const FAMILY_NOTABLE_ICON_IMAGE = [
	"coalesce",
	["image", ["concat", "plane-notable-", ["get", "family"]]],
	["image", PLANE_NOTABLE_ICON_ID],
] as unknown as maplibregl.ExpressionSpecification;
```

c) A module-level request helper (below `installFamilyIcon`) — module scope, not component scope, so the `[]`-dep mount/RAF effects can call it without tripping `react-hooks/exhaustive-deps` (the same reason the existing code funnels callbacks through `cbRef`):

```ts
// Kick off (once per family) the silhouette fetch for every family in view;
// on arrival, rasterize + register both color variants. "generic" never
// fetches — the fallback icon IS the generic art. Callers pass live refs so
// late-resolving fetches see the current map/colors (or bail if unmounted).
function requestFamilyIcons(
	fc: FlightFeatureCollection,
	requested: Set<string>,
	loaded: Map<string, string>,
	mapRef: { current: maplibregl.Map | null },
	colorsRef: { current: { pinColor: string; notablePinColor: string } },
) {
	for (const f of fc.features) {
		const family = f.properties.family;
		if (!family || family === "generic" || requested.has(family)) continue;
		requested.add(family);
		void loadAircraftIconSvg(family as AircraftFamily).then((svg) => {
			const map = mapRef.current;
			if (!svg || !map) return;
			loaded.set(family, svg);
			void installFamilyIcon(
				map, family, svg,
				colorsRef.current.pinColor, colorsRef.current.notablePinColor,
			);
		});
	}
}
```

(`colorsRef.current` in `FlightMap` carries extra fields — that's fine, the parameter type above is a subset. If TS complains about the ref parameter types, widen them to match the actual ref types.)

Inside the component, next to the other refs (search for `requestedMeshesRef` and add alongside):

```ts
	// 2D silhouettes: families whose SVG fetch has been kicked off, and the
	// resolved SVG text per family (kept so color changes can re-rasterize).
	const requestedIconFamiliesRef = useRef<Set<string>>(new Set());
	const loadedIconSvgsRef = useRef<Map<string, string>>(new Map());
```

The family resolver is an inline closure at each `motionPointsToGeoJSON` call site, mirroring the 3D batches' resolver at line 1033 exactly:

```ts
	(m: FlightMotion) =>
		cbRef.current.aircraftFamilyOf?.(m.item.flight, m.item.start_date) ?? "generic"
```

d) Load handler (line 494-497): build the FC once, request icons:

```ts
			const initialPointsFc = motionPointsToGeoJSON(
				motionBufferRef.current, nowMsRef.current, landingRef.current,
				(m) => cbRef.current.aircraftFamilyOf?.(m.item.flight, m.item.start_date) ?? "generic",
			);
			map.addSource("flights", { type: "geojson", data: initialPointsFc });
			requestFamilyIcons(
				initialPointsFc, requestedIconFamiliesRef.current, loadedIconSvgsRef.current,
				mapRef, colorsRef,
			);
```

e) Layer definitions — swap the three `icon-image` values:

- `flights-dots` (line 514): `"icon-image": FAMILY_ICON_IMAGE,`
- `flights-notable` (line 531): `"icon-image": FAMILY_NOTABLE_ICON_IMAGE,`
- `cluster-planes` (line 576): `"icon-image": FAMILY_ICON_IMAGE,`

f) RAF loop (line 1012): thread the resolver and request icons:

```ts
			const pointsFc = motionPointsToGeoJSON(
				buf, now, landing,
				(m) => cbRef.current.aircraftFamilyOf?.(m.item.flight, m.item.start_date) ?? "generic",
			);
			requestFamilyIcons(
				pointsFc, requestedIconFamiliesRef.current, loadedIconSvgsRef.current,
				mapRef, colorsRef,
			);
```

g) Color-change effect (lines 876-881) — after the `installPlaneIcons` call add:

```ts
		for (const [family, svg] of loadedIconSvgsRef.current) {
			void installFamilyIcon(map, family, svg, pinColor, notablePinColor);
		}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @rt911/frontend exec vitest run src/Applications/FlightTracker/FlightMap.test.tsx
```

Expected: PASS — new describe block AND all pre-existing FlightMap tests (the expression swap must not break the icon-install or hit-test tests; if a pre-existing test asserted the old string `icon-image`, update it to the new expression).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/FlightTracker/FlightMap.tsx packages/frontend/src/Applications/FlightTracker/FlightMap.test.tsx
git commit -m "feat(flight-tracker): per-family top-down silhouettes on the 2D map

Features carry an airframe family; symbol layers pick plane-<family>
images via a coalesce/image expression with the generic icon as
fallback while (or if) a family's Wasabi-hosted SVG is loading.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Full-suite gate + browser verification

**Files:** none new — verification only.

- [ ] **Step 1: Full frontend suite, typecheck, lint**

```bash
pnpm test && pnpm build && pnpm lint
```

Expected: all green (CI runs exactly these). Fix anything that fails before proceeding.

- [ ] **Step 2: Browser-verify**

Invoke the `packages/frontend:verify` skill (Playwright against `localhost:5173` — beware a stale dev server on 5173 from another worktree; restart it from THIS worktree). Confirm, in the Flight Tracker with the map on 2D:

1. Planes show differing silhouettes (zoom to a busy area; a 777/DC-10 visibly larger than a CRJ/ERJ).
2. The four notables show 757/767 shapes at their large size in the notable color.
3. Settings → pin color change re-tints silhouettes live.
4. Cluster mode ON: unclustered individual planes still use family silhouettes.
5. DevTools network: one fetch per `icons/<family>.svg`, no 404 retry storms; block `*/icons/*` and reload to confirm generic fallback still renders every plane.

- [ ] **Step 3: Report**

Summarize verification results (screenshots if captured) and stop for user review before any PR/merge decision — integration is the user's call (superpowers:finishing-a-development-branch).

---

## Self-review notes

- Spec coverage: offline bake+upload (Task 1 / spec §1), fetch cache (Task 4 / §2), sizing+registration (Tasks 2+5 / §3), data-driven selection (Tasks 3+5 / §4), error handling (Task 4 failure tests + Task 5 fallback test / §5), testing incl. browser verify (each task + Task 6 / §6).
- Type consistency: `familyOf` is `(m: FlightMotion) => string` in Tasks 3 and 5; icon ids `plane-<family>` / `plane-notable-<family>` in Tasks 2 and 5; `loadAircraftIconSvg(family: AircraftFamily): Promise<string | null>` in Tasks 4 and 5.
- Known judgment calls: `generic` never fetched at runtime (fallback art IS generic; the baked `generic.svg` is uploaded anyway for future use). `flightsToGeoJSON` (static builder) hard-stamps `"generic"` — it has no route-index context and no live call site on the map path.
