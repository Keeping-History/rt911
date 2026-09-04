# Flight Tracker — hero landmark model credits

Hero landmark 3D models are hosted on Wasabi (`files.911realtime.org/maps/heroes/`)
and referenced by `maps/hero-buildings.json`; they are not committed to this repo.
Attribution required by their licenses is recorded here.

## World Trade Center complex, from "New York in the 1990s" (`nyc-90s-wtc-only`)

- **Model:** "New York In The 90's" by **rorovera201305** (the WTC complex
  portion only — see "Scope" below).
- **Source:** https://skfb.ly/oSMBU
- **License:** **CC Attribution (CC-BY 4.0)** — https://creativecommons.org/licenses/by/4.0/
- **Use:** downloaded as glTF (187 meshes, 2.68M triangles, no textures). Every
  node's transform was baked into world space and the source's single flat
  ground/street-plane mesh dropped (`scripts/aircraft-models/nyc_glb.py`),
  the remainder calibrated onto real lng/lat/meters via a 2-point similarity
  transform anchored on the North and South Towers' documented footprint
  centers and heights (`packages/tools/building-recon`'s curated
  `wtc_complex_2001.geojson`), clipped to a 280m radius around the WTC
  complex, then decimated via open3d quadric-error simplification to 150k
  triangles (an earlier vertex-clustering pass shattered regular facade
  patterns into visible jagged artifacts and was replaced) — see
  `scripts/aircraft-models/process_nyc_model.py`. Hosted as
  `maps/heroes/nyc-90s-wtc-only.stl`. This is a derivative work; attribution
  to rorovera201305 is retained per CC-BY. Replaces the prior NanoRay
  WTC-only model (`wtc-complex-v2.stl`, no longer referenced) and, within its
  (small) footprint, the extruded 2001-buildings GeoJSON layer.
- **Scope:** only the WTC complex is used, not the source's full city scene.
  A full-model rotation search (every degree, both plain and mirrored)
  against building-recon's real 1,510-building Lower Manhattan dataset found
  no rigid transform aligning the source model with real Manhattan beyond a
  few hundred meters of the towers — it's a stylized diorama whose "hero"
  subject (the towers) was built to consistent scale/position, not a
  surveyed dataset. This hero exists specifically to fill the gap the DoITT
  hero below can't: the real towers no longer stand, so no modern building
  dataset has them.

## Manhattan buildings (pre-9/11), from NYC DoITT's 3D Building Model (`doitt-manhattan`)

- **Data:** NYC DoITT's 3D Building Model (real photogrammetric massing and
  rooflines, not extrusions) for all of Manhattan, filtered to
  `CNSTRCT_YR <= 2001` (44,054 of 45,304 buildings; the other 1,250 postdate
  2001 and are excluded, including anything rebuilt at the WTC site).
- **Source:** https://www1.nyc.gov/site/doitt/initiatives/3d-building.page
  (NYC Open Data, DoITT terms of use), accessed via the public
  SceneServer/FeatureServer backing Esri's Manhattan Skyscraper Explorer
  showcase app (`services2.arcgis.com/cFEFS0EWrhfDeVw9/.../showcases_manhattan_buildings`).
- **Use:** the SceneServer's I3S node tree was walked and its binary mesh
  buffers parsed directly (`scripts/doitt-buildings/extract_geometry.py`) --
  vertex positions are plain per-node degree/meter offsets from each node's
  `obb.center`, so no calibration or fitting is needed, unlike the WTC hero
  above. Per-building `OBJECTID` (fetched from the companion FeatureServer,
  `scripts/doitt-buildings/fetch_attributes.py`) gated which triangles were
  kept by construction year, which is what leaves the gap the WTC hero
  fills. The full extraction (3.46M triangles) was decimated via open3d
  quadric-error simplification to 800k triangles (`scripts/doitt-buildings/build_stl.py`)
  — real, structured mesh geometry holds up far better under decimation
  than the WTC hero's stylized source did at a comparable ratio. Hosted as
  `maps/heroes/doitt-manhattan.stl` (38MB). Replaces the flat
  extruded-building GeoJSON layer within its coverage; that layer remains
  the fallback for everywhere this hero doesn't reach (e.g. the Pentagon).

_(The Pentagon currently renders as an extruded footprint — no license-clean hero
model sourced yet.)_
