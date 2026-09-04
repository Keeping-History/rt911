# Manhattan buildings from NYC DoITT's 3D Building Model

Real photogrammetric building geometry for the Flight Tracker's Manhattan
skyline, filtered to `CNSTRCT_YR <= 2001`, hosted as a hero landmark
(`maps/heroes/doitt-lower-manhattan.stl`) — see
`packages/frontend/src/Applications/FlightTracker/HERO_MODELS_CREDITS.md`
for the full attribution and design rationale.

Source: NYC DoITT's 3D Building Model (NYC Open Data), accessed via the
public SceneServer/FeatureServer backing Esri's [Manhattan Skyscraper
Explorer](https://github.com/Esri/Manhattan-skyscraper-explorer) showcase
app — `services2.arcgis.com/cFEFS0EWrhfDeVw9/arcgis/rest/services/showcases_manhattan_buildings`.
No credentials needed; it's a public demo service.

## Format notes (I3S, verified against this service's live data)

- The SceneServer's own `/query` endpoint returns `{"error":["Invalid URL"]}`
  for this service despite advertising the `Query` capability. The sibling
  **FeatureServer** at the same base path (swap `SceneServer` → `FeatureServer`
  in the URL) works normally and shares the same `OBJECTID` space — confirmed
  via the SceneServer's own `"featureidMappedFromFS": 0` declaration, and by
  spot-checking a geometry buffer's embedded feature ID against a
  FeatureServer query for that exact `OBJECTID`.
- Geometry resource URLs are `.../nodes/<resource>/geometries/0`, where
  `<resource>` is `node.mesh.geometry.resource` from the node page JSON —
  **not** the node's own tree `index`. Using the node's `index` in that
  position returns the same `{"error":["Invalid URL"]}` body (25 bytes,
  easy to mistake for a real tiny geometry file if you don't check).
- Binary geometry layout (byte-exact confirmed against a live 2.5MB node):
  header `[vertexCount: u32, featureCount: u32]`, then flat
  (`PerAttributeArray`, not interleaved) blocks: `position` (vertexCount×3
  f32), `normal` (×3 f32), `uv0` (×2 f32), `color` (×4 u8), `featureId`
  (featureCount×1 u64 — equals `OBJECTID`), `faceRange` (featureCount×2
  u32 — `[firstFace, lastFace]` **inclusive**, contiguous across features).
  Faces are a flat non-indexed triangle list (face *i* = vertices
  `[3i, 3i+1, 3i+2]`).
- Vertex positions are plain **degree offsets** (x, y) and a **meter
  offset** (z) from the node's `obb.center` — no rotation by the OBB's
  quaternion needed. Confirmed by the offsets being tiny (~0.01–0.03,
  degree-scale not meter-scale) and `obb.center` itself landing on a real,
  sane Manhattan point. So: `real_lon = center.lon + x`,
  `real_lat = center.lat + y`, `real_height_m = center.z + z`. This is
  already real, correctly-oriented geographic data — no calibration or
  fitting step is needed (unlike the WTC hero model).
- Two `geometryBuffers` variants exist per `geometryDefinition`: the raw
  one above, and a Draco-compressed one. `/geometries/0` on this service
  serves the raw variant; these scripts don't handle Draco.

## Rebuilding

```bash
python3 fetch_attributes.py    # -> attributes.json (OBJECTID -> CNSTRCT_YR, ~45k rows)
python3 extract_geometry.py    # walks the node tree, writes extracted_tris.pkl (gitignored, regenerate as needed)
python3 build_stl.py           # -> doitt-lower-manhattan.stl
```

`extract_geometry.py`'s `AOI` and `YEAR_CUTOFF` constants control scope;
`AOI` currently matches `building-recon`'s existing Lower Manhattan area.
Widening it re-walks more of the node tree (the full service covers all of
Manhattan up to ~40.87°N) and produces a larger STL — no code changes needed,
just a bigger box and more fetch time.

Upload the result to Wasabi at `maps/heroes/doitt-lower-manhattan.stl` and
add/update its entry in `maps/hero-buildings.json` (see the frontend's
`public/maps/hero-buildings.sample.json` for the dev fixture shape) — same
deployment mechanics as the WTC hero model.
