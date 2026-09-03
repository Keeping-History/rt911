# Flight Tracker — hero landmark model credits

Hero landmark 3D models are hosted on Wasabi (`files.911realtime.org/maps/heroes/`)
and referenced by `maps/hero-buildings.json`; they are not committed to this repo.
Attribution required by their licenses is recorded here.

## New York in the 1990s (`nyc-90s-v1`)

- **Model:** "New York In The 90's" by **rorovera201305**.
- **Source:** https://skfb.ly/oSMBU
- **License:** **CC Attribution (CC-BY 4.0)** — https://creativecommons.org/licenses/by/4.0/
- **Use:** downloaded as glTF (187 meshes, 2.68M triangles, no textures). Every
  node's transform was baked into world space and the source's single flat
  ground/street-plane mesh dropped (`scripts/aircraft-models/nyc_glb.py`), the
  remainder decimated via open3d quadric-error simplification to 200k
  triangles (matches the method the prior WTC-only model used; an earlier
  vertex-clustering pass shattered regular facade patterns into visible
  jagged artifacts and was replaced), then calibrated
  onto real lng/lat/meters via a 2-point similarity transform anchored on the
  North and South Towers' documented footprint centers and heights
  (`packages/tools/building-recon`'s curated `wtc_complex_2001.geojson`) —
  see `scripts/aircraft-models/process_nyc_model.py`. Hosted as
  `maps/heroes/nyc-90s-v1.stl`. This is a derivative work; attribution to
  rorovera201305 is retained per CC-BY. Replaces the prior NanoRay WTC-only
  model (`wtc-complex-v2.stl`, no longer referenced) and, within its
  footprint, the extruded 2001-buildings GeoJSON layer.

_(The Pentagon currently renders as an extruded footprint — no license-clean hero
model sourced yet.)_
