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
  surveyed dataset. The rest of Lower Manhattan keeps rendering from the
  real, surveyed extruded-building data, as it did before this model existed.

_(The Pentagon currently renders as an extruded footprint — no license-clean hero
model sourced yet.)_
