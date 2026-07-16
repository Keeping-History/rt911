# 2D Per-Family Aircraft Silhouettes — Design

**Date:** 2026-07-16
**Status:** Approved
**Scope:** `packages/frontend` Flight Tracker 2D map mode + `scripts/aircraft-models` offline pipeline

## Problem

In 2D map mode every flight renders the same generic `plane.svg` icon. 3D mode
already resolves each flight to one of 15 airframe families
(`familyForAircraftType` via the route index) and renders per-family STL
models. 2D should match: each plane shows its family's true top-down
silhouette, scaled relative to real aircraft size.

## Decisions (user-confirmed)

- **Style:** flat pin-color silhouettes (crayon theming preserved), per-family
  shapes, **relative sizing** — a 777 reads visibly bigger than a CRJ.
- **Notables:** AA11/UA175/AA77/UA93 also switch to their real 767/757
  silhouettes at their existing 32 px-class size in the notable pin color.
- **Hosting:** Wasabi (`maps/aircraft/icons/<family>.svg`), fetched at
  runtime — consistent with the repo rule that media assets live outside the
  repo. Planes render generic until each family's icon lands.

## 1. Offline asset generation (`scripts/aircraft-models/`)

Extend `make_icons.py`:

- Input: the 15 **normalized** family STLs from Wasabi
  `maps/aircraft/<family>.stl` (nose→+Y, fin→+Z, ≤6k tris) — not the raw
  `review/` picks. Normalization removes the script's "nose-up fixed by hand"
  caveat.
- Project top-down (drop Z), then **union + simplify** the triangle soup into
  a single clean `<path>` per family (~1–3 KB vs ~300 KB raw polygon soup).
  `shapely` is an acceptable one-off script dependency.
- Emit **nose-pointing-right** (rotate the projection −90°) to match
  `plane.svg`'s convention, so the existing `icon-rotate: heading − 90`
  expression stays uniform across every registered image.
- Output SVG: single path, **no fill of its own** — inherits the root fill
  injected by `colorizeSvg` at runtime.
- Upload to Wasabi `maps/aircraft/icons/<family>.svg`.

## 2. Runtime loading — `aircraftIcons.ts` (new)

Mirrors `aircraftModels.ts`:

- `loadAircraftIconSvg(family: AircraftFamily): Promise<string | null>` —
  fetches `${ICON_BASE}/icons/${family}.svg` (base derived from
  `VITE_AIRCRAFT_MODELS_URL` / `files.911realtime.org/maps/aircraft`).
- One cached (in-flight or settled) promise per family; failures resolve
  `null` so a bad asset degrades to the generic icon without retry storms.
- Test seam: `resetAircraftIconCache()`.
- Loads kick off **lazily per family actually seen** in the current airborne
  set, same as the 3D mesh path.

## 3. Registration & sizing (`flightIcons.ts` + `FlightMap.tsx`)

- Per loaded family, rasterize and register two map images via the existing
  `colorizeSvg`/`buildPlaneImage` pipeline:
  - `plane-<family>` (pin color, family-relative px)
  - `plane-notable-<family>` (notable pin color, scaled around 32 px)
- Relative size baked at registration from a `family → px` table
  (span-based): floor ~9 px (bizjet/CRJ/ATR stay clickable), generic stays
  12 px, ceiling ~16 px (777/DC-10) so wide-bodies don't overflow their slot
  at national zoom. Notables scale proportionally around the existing 32 px.
- The zoom-interpolate `icon-size` expression stays a pure multiplier —
  unchanged.
- Crayon color changes re-install **every registered image** (existing
  `installPlaneIcons` flow extended to the loaded-family set).

## 4. Data-driven icon selection

- Add `family: string` to `FlightFeature.properties`, threaded through
  `motionPointsToGeoJSON` via the `aircraftFamilyOf(flight, startDate)`
  callback `FlightMap` already receives for 3D.
- All three symbol layers (`flights-dots`, `flights-notable`,
  `cluster-planes`) switch `icon-image` to:

  ```
  ["coalesce",
    ["image", ["concat", "plane-", ["get", "family"]]],
    ["image", PLANE_ICON_ID]]
  ```

  (notable layer uses the `plane-notable-` prefix / fallback). MapLibre's
  `image` expression resolves only for registered images, so planes render
  generic and pop to their real silhouette as each family's SVG registers.
- Hit-testing, clustering, rotation (`heading − 90`), and the 3D path are
  untouched.

## 5. Error handling

- Icon fetch failure → `null` → family never registers → `coalesce` falls
  back to the generic icon permanently for that session. `console.warn` once.
- `aircraftFamilyOf` absent/unknown type → `"generic"` family → no fetch for
  it; generic fallback image renders (no `plane-generic` needed unless the
  bake produces one — if it does, it registers like any other family).

## 6. Testing

Co-located unit tests per repo convention:

- `flightGeoJSON`/`flightMotion` builders emit the `family` property.
- Size-table: floor/ceiling invariants, every `AircraftFamily` has an entry.
- Icon-id helper (family → image id, regular vs notable).
- `aircraftIcons` fetch cache: cached promise reuse, failure → null,
  reset seam (stubbed fetch, mirroring `aircraftModels.test.ts`).
- New test files include `afterEach(cleanup)` (no RTL auto-cleanup here).

End-to-end: browser-verify via the `packages/frontend:verify` skill —
confirm silhouettes differ per family, notables show 757/767 shapes, crayon
color change re-tints, cluster mode individual planes use family icons.

## Out of scope

- 3D mode (already per-family).
- Replay-trail markers (deliberately simple circles).
- Any new icon art beyond the 15 existing families.
