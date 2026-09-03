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
- Real-world extent, computed by composing the *full* node-transform hierarchy
  (root axis-swap × `.fbx` import scale × the `"New York"` node's own additional
  scale/rotation) down to each mesh's POSITION accessor bounds: **~1000m × 550m
  horizontal, ~550m of local "height" range** (axes aren't consistent with true
  meters — see Calibration). This is a Lower-Manhattan-block scale, comparable
  to the area the current `buildings-2001.geojson` extrusion layer already
  covers, not a whole-borough model.
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

- Parse the GLB (`pygltflib` or `trimesh`), walk the scene graph, and bake each
  node's cumulative transform into world-space vertex positions — the same
  math used to compute the real-world extent above, reused rather than
  re-derived.
- Drop `Camera`/`Light` nodes, drop UV/material data (STL carries neither);
  keep geometry only, merged into one triangle soup.
- Recompute face normals during merge (existing STL writer pattern in
  `process_models.py`'s `write_stl` already does this per-triangle — reuse
  that approach rather than trusting the source normals, which may not
  survive the transform bake consistently).
- Decimate to a triangle budget appropriate for a full-block model (existing
  hero precedent: WTC-only decimated to ~90k tris; this covers a larger area
  with more distinct buildings, so the budget needs its own judgment call
  during implementation — optimize losslessly first, per your answer, and
  only decimate further if the resulting STL is still too large).
- **Bake the full placement transform into the STL's vertices** (anisotropic
  scale, rotation, recentering to a chosen real-world anchor), rather than
  relying on `HeroPlacement.scale`, which is a single uniform scalar and
  can't correct the model's own inconsistent axis proportions. After this
  step the STL is already in "local meters, +Y north, +Z up, origin at the
  chosen anchor point" — the convention `placeHeroMesh` expects — and the
  manifest entry needs only `scale: 1.0`.

### 2. Calibration

- **Vertical/anchor reference:** AA11's real, already-reconstructed flight
  track terminal point (north face of the North Tower, floors 93–99) gives a
  ground-truth lng/lat/altitude. Pull the exact terminal point from the
  `flight_tracks` data (notable-flights track, shipped in PR #170) rather
  than estimating floor heights by hand.
- **Horizontal fit and rotation:** visually align the model's street grid
  against the satellite basemap already in the app (Manhattan's ~29°
  off-true-north grid skew), iterating in the conversion script until it
  reads correctly at the Flight Tracker's normal 3D-buildings zoom level
  (`BUILDINGS_MIN_ZOOM = 12`).
- Ground elevation (`baseElevM`) carries over the existing WTC entry's value
  (4m) unless the new model's own base geometry suggests otherwise.

### 3. Manifest swap

- Replace the `wtc-complex` entry in `maps/hero-buildings.json` (served from
  Wasabi; `public/maps/hero-buildings.sample.json` is the dev fixture and
  needs the same edit) with the new model's entry — new `id`, new `stl_url`,
  `scale: 1.0`, calibrated `lng`/`lat`/`bearing_deg`/`base_elev_m`.
- Size `exclude` to the new model's full ~1000m × 550m footprint (not just
  the old WTC-only bbox), so `excludeFootprints` hides the GeoJSON extrusion
  polygons under the new model's coverage while everywhere else (Pentagon,
  anything outside the model's footprint) keeps rendering as extrusions
  exactly as today — no change to that fallback mechanism.
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
  it, and that the AA11 track's impact point visually lines up with the
  model's North Tower face.

## Out of scope

- No runtime glTF/GLB parsing or texture rendering is added — a deliberate
  rejection of the alternative approach (ship the compressed GLB directly,
  extend `buildings3DLayer` for indexed/textured draws). Revisit only if a
  future request specifically needs the model's original per-material colors
  or textures.
- No change to how the Pentagon or any non-Manhattan hero landmark is
  handled.
- Deleting the now-unreferenced `wtc-complex-v2.stl` from Wasabi.
