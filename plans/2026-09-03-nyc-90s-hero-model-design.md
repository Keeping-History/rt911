# NYC-in-the-90s hero model — design

## Summary

Replace the Flight Tracker's current WTC hero landmark (`wtc-complex`, a NanoRay
CC-BY STL) and, within its footprint, the extruded 2001-buildings GeoJSON layer,
with a new richer model: `new_york_in_the_90s.glb`, a CC-BY Sketchfab scene by
rorovera201305. This is a **content swap through the existing hero-landmark
extension point**, not new rendering code — no changes to `buildingMesh.ts`,
`buildings3DLayer.ts`, `heroBuildings.ts`, `useHeroBuildings.ts`, or
`buildingModels.ts`.

## Source asset facts (verified by inspection)

- glTF 2.0 binary, 164MB, 187 meshes / 342 nodes / 91 materials, **no textures**
  (materials are flat `pbrMetallicRoughness.baseColorFactor` only — no images).
- No georeferencing of any kind (no CESIUM_RTC or similar extension); it's an
  artist's scene centered on its own local origin.
- Real-world extent: composing the *full* node-transform hierarchy (root
  axis-swap × `.fbx` import scale × the `"New York"` node's own additional
  scale/rotation) down to each mesh's POSITION accessor bounds gives an
  overall bounding box of **~999 × 58 × 553 local units** (X, Y-up, Z). The
  model's own units are **not** 1:1 meters, though: the two tallest structures
  in the scene cluster ~13.8 local units apart at local heights ~54.5 and
  ~44.5 — almost certainly the Twin Towers (nothing else in the scene comes
  close to that height, and no other pair of structures is nearly as tall and
  nearly as close together). Cross-checking against the curated real values
  in `packages/tools/building-recon/data/wtc_complex_2001.geojson` (417m
  North Tower height; ~123m real center-to-center tower separation, derived
  from its footprint rectangles) gives two independent scale estimates —
  417⁄54.5≈7.7 and 123⁄13.8≈8.9 m/unit — that agree closely enough to treat
  **~8 m/unit** as the calibration starting hypothesis. At that scale the
  model's real extent is roughly **8km × 4.7km**: a real swath of Manhattan
  (matching the "New York in the 90s" cityscape title), not a single WTC-block
  diorama. This is a hypothesis to confirm visually (Task 4 below), not a
  certainty — but it's what the plan calibrates from rather than guessing.
- License: CC-BY 4.0. Required attribution text (exact, as supplied):
  > "New York In The 90's" (https://skfb.ly/oSMBU) by rorovera201305 is
  > licensed under Creative Commons Attribution
  > (http://creativecommons.org/licenses/by/4.0/).

## Approach

### 1. Offline conversion script

New one-off script, `scripts/aircraft-models/process_nyc_model.py` (sibling to
the existing STL pipeline, not folded into `process_models.py` — that script's
`auto_orient`/`normalize` are aircraft-specific fuselage/wing heuristics that
don't apply here):

- Parse the GLB with the standard library only (`struct` + `json`), matching
  this toolkit's existing house style (`process_models.py` has no external
  dependencies either) — a GLB container and a glTF scene graph with
  FLOAT/UNSIGNED_INT accessors don't need a library. Walk the scene graph and
  bake each node's cumulative transform into world-space vertex positions —
  the same math already prototyped and verified against this file (see
  Calibration) — reused rather than re-derived.
- Drop `Camera`/`Light` nodes, drop UV/material data (STL carries neither);
  keep geometry only, merged into one triangle soup.
- Recompute face normals during merge (existing STL writer pattern in
  `process_models.py`'s `write_stl` already does this per-triangle — reuse
  that approach rather than trusting the source normals, which may not
  survive the transform bake consistently).
- Decimate from the source's 2.68M triangles to a triangle budget appropriate
  for a multi-kilometer cityscape (existing hero precedent: the WTC-only
  model, covering a tiny fraction of this area, was decimated to ~90k tris;
  150k is the starting budget for this much larger scene, sized against the
  visual result and file size in Task 2 rather than fixed in advance).
- **Bake the full placement transform into the STL's vertices** (uniform
  scale, rotation, recentering to a chosen real-world anchor), rather than
  relying on `HeroPlacement.scale`, which is a single uniform scalar and
  can't correct the model's own inconsistent axis proportions. After this
  step the STL is already in "local meters, +Y north, +Z up, origin at the
  chosen anchor point" — the convention `placeHeroMesh` expects — and the
  manifest entry needs only `scale: 1.0`.

### 2. Calibration

Two real-world impact points anchor this precisely rather than by eye alone —
both towers, both faces, both known to the floor:

- **North Tower, north face, floors 93–99** — where AA11 hit.
- **South Tower, south face, floors 77–85** — where UA175 hit.

**Identifying the two towers in the model:** scanning every mesh's highest
vertex finds two clusters far taller than anything else in the scene and nowhere
else close to their height: one centered near local `(x≈-9.96, z≈-34.71)`
reaching local height ≈54.5, and one centered near local `(x≈1.64, z≈-42.47)`
reaching local height ≈44.5, ~13.96 local units apart. Nothing else in the
2.68M-triangle scene comes close on either dimension — this is the strongest
signal available short of opening the mesh in a viewer, and Task 4 confirms it
visually before committing.

**Two independent scale checks agree:** the curated real values in
`packages/tools/building-recon/data/wtc_complex_2001.geojson` put the North
Tower at 417m and the two towers' footprint centers 123.3m apart (haversine
over their rectangle centers, `(-74.013355, 40.712925)` and
`(-74.012305, 40.712155)`). That gives 417⁄54.5 ≈ 7.7 m/unit from height and
123.3⁄13.96 ≈ 8.83 m/unit from separation — independent measurements landing
within 15% of each other, which is corroboration, not proof: **use 8.5 m/unit
as the initial uniform scale**, applied to both the horizontal plane and
height (not the anisotropic split the first draft of this doc assumed — one
scale factor already explains both measurements reasonably well; only refine
toward anisotropic if the visual check in Task 4 shows a systematic mismatch).

**Horizontal placement is a 2-point similarity transform**, not eyeballing:
with two point-correspondences (model cluster centroid ↔ real tower center,
for both towers) the scale, rotation, and translation are fully determined —
solve for them arithmetically, then use the satellite basemap only to sanity
check the result and catch a wrong-handedness mirror flip, not to hunt for
the fit by hand. Concretely: convert both real tower centers to local
east/north meters around a chosen origin (reuse `lngLatToMercator` /
`mercatorPerMeter` math from `buildingMesh.ts` — same formulas, just called
from Python rather than TypeScript), take the vector between them in both
spaces, and the ratio and angle between those two vectors give scale and
bearing directly; translation then falls out from making one control point
match exactly.

**Vertical placement:** target the *midpoint* of each impact floor band as the
calibration check, using each tower's own true height ÷ 110 floors for a
per-floor figure (417⁄110 ≈ 3.79m for the North Tower, 415⁄110 ≈ 3.77m for the
South Tower — these are derived approximations for placement purposes, not
claimed historical figures): North Tower floors 93–99 ≈ 352–376m AGL, South
Tower floors 77–85 ≈ 290–320m AGL. After the horizontal similarity transform
and the 8.5 m/unit vertical scale are applied, each tower's modeled height at
its respective face should land inside its band; Task 4's visual check
confirms this and nudges the vertical scale if it doesn't.

Ground elevation (`baseElevM`) carries over the existing WTC entry's value
(4m) unless the new model's own base geometry suggests otherwise.

**Note on track data vs. footprint data:** `flight_tracks`' own AA11/UA175
terminal points (`-74.01303, 40.71236` and `-74.01314, 40.71078`) sit tens to
~120m off the curated tower footprints — expected, since the app's own method
notes disclose flight paths as reconstructed/interpolated, not survey-precise.
The curated `wtc_complex_2001.geojson` rectangles are the authoritative
geometry for the similarity-transform math above; the tracks are a visual
plausibility check in Task 4 (does the line entering the frame end up at
roughly the right tower and face), not a numeric input.

### 3. Manifest swap

- Replace the `wtc-complex` entry in `maps/hero-buildings.json` (served from
  Wasabi; `public/maps/hero-buildings.sample.json` is the dev fixture and
  needs the same edit) with the new model's entry — new `id`, new `stl_url`,
  `scale: 1.0`, calibrated `lng`/`lat`/`bearing_deg`/`base_elev_m`.
- Size `exclude` to the new model's actual calibrated footprint, computed
  (not guessed) by converting the transformed mesh's world-space bounding box
  back to lng/lat with the same `lngLatToMercator`/`mercatorPerMeter` math
  used for calibration. At the ~8.5 m/unit scale hypothesis this is roughly
  8km × 4.7km — likely large enough to cover the *entire* current
  `buildings-2001.geojson` Manhattan AOI (`-74.020, 40.701` to
  `-74.002, 40.720`, ~1.5km × 2.1km per `building-recon`'s README), not just
  a WTC-sized bbox. If Task 4's visual check confirms that, the Manhattan
  extrusion layer is fully superseded by the new model in practice — nothing
  needs deleting, since `excludeFootprints` already hides whatever falls
  inside the bbox and Pentagon-area extrusions (a separate AOI, unaffected)
  keep rendering regardless.
- Upload the new STL to `files.911realtime.org/maps/heroes/` (naming
  convention: follow `wtc-complex-v2.stl`'s pattern, e.g.
  `nyc-90s-v1.stl`). The old `wtc-complex-v2.stl` stays put — nothing
  currently references it once the manifest is updated, and this repo's
  media-asset convention doesn't delete upstream Wasabi objects as part of a
  content swap.

### 4. Credits

- Update `src/data/aircraftCredits.ts`: either repoint `WTC_HERO_CREDIT` at
  the new model (model no longer being just the WTC, but the whole modeled
  block) or replace it with a new `NYC_90S_HERO_CREDIT` entry — decide the
  exact wording during implementation, but the note field must carry the
  supplied attribution text and disclose the decimation/recentering as a
  derivative-work modification (CC-BY 4.0 §3(a)(1)(B)), matching the
  existing WTC entry's pattern.
- Update `scripts/aircraft-models/HERO_MODELS_CREDITS.md` with the same
  facts (source URL, license, what was done to it).
- `src/data/provenance.ts`'s `FlightTracker.app` entry references
  `WTC_HERO_CREDIT` already (`credits: [WTC_HERO_CREDIT, ...AIRCRAFT_CREDITS]`)
  — if the credit is renamed, update that reference and the existing
  `aircraftCredits.test.ts` assertions (`WTC_HERO_CREDIT.author` /
  `.license` checks) in the same change.
- The `method` bullet "The Pentagon renders as an extruded footprint..."
  stays accurate and unchanged — Pentagon coverage isn't affected.

## Error handling / degradation

No new failure modes: `loadHeroStl` already null-and-warns on a bad/missing
STL fetch, at which point `excludeFootprints` naturally has no active bbox to
exclude, so the GeoJSON extrusion layer shows through as the fallback — this
is the existing behavior for any hero model and needs no new code.

## Testing

- `buildingModels.test.ts`, `heroBuildings.test.ts`, `buildings.test.ts`,
  `buildings3DLayer.test.ts` are all pure-geometry/manifest-parsing tests
  against the existing format — they don't need new test *code*, but the
  manifest fixture change (`hero-buildings.sample.json`) should be checked
  against them.
- `aircraftCredits.test.ts` needs its WTC-specific assertions updated to
  match whatever credit entry replaces/extends `WTC_HERO_CREDIT`.
- Manual verification per `packages/frontend:verify`: load Flight Tracker at
  a Lower Manhattan zoom (≥12) with 3D buildings on, confirm the new model
  renders in place of both the old WTC STL and the extruded footprints under
  it, and that both AA11's track (terminating at the North Tower's north
  face, floors 93–99) and UA175's track (terminating at the South Tower's
  south face, floors 77–85) visually line up with the correct tower and face.

## Out of scope

- No runtime glTF/GLB parsing or texture rendering is added — a deliberate
  rejection of the alternative approach (ship the compressed GLB directly,
  extend `buildings3DLayer` for indexed/textured draws). Revisit only if a
  future request specifically needs the model's original per-material colors
  or textures.
- No change to how the Pentagon or any non-Manhattan hero landmark is
  handled.
- Deleting the now-unreferenced `wtc-complex-v2.stl` from Wasabi.
