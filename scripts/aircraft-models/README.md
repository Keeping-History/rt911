# Flight Tracker 3D aircraft models (maps/aircraft/*.stl)

The per-airframe 3D models the Flight Tracker renders in 3D mode
(`packages/frontend/src/Applications/FlightTracker/aircraftModels.ts`).
Fifteen marker-ready binary STLs — one per airframe family present in
`flight_tracks.aircraft_type` — hosted on the file proxy at
`https://files.911realtime.org/maps/aircraft/<family>.stl`, with
`models.json` alongside carrying license + attribution per model.

Every source model is freely licensed (CC-BY / CC-BY-SA / GPL-2.0);
`manifests/*.jsonl` is the provenance record (exact license, author, source
page, auth-free download URL — mostly the Internet Archive's Thingiverse
mirror, since Thingiverse itself is Cloudflare-walled). `PICKS.md` is the
approved family → model mapping, including the decisions (Fairchild 328JET
standing in for the ATR-42 family; FlightGear/GPL conversions covering the
757 and 727, for which no freely-licensed STL exists anywhere).

## Rebuilding from scratch

1. Re-download the source STLs using the `download_url` of each row in
   `manifests/*.jsonl` into a working directory next to these scripts.
2. Two models are local conversions:
   - 727: `python3 obj2stl.py boeing727.obj b727-yuppy-gpl.stl`
     (GPL-2.0 OBJ from the Thingiverse mirror, see manifest-converted.jsonl)
   - 757: `python3 ac2stl.py 757-200.ac b757-fgfs-gpl.stl`
     (FlightGear FGAddon AC3D, GPL-2.0+; the converter filters landing-light
     cone/beacon/strobe helper objects and outliers, or they dwarf the plane)
3. `python3 process_models.py` — auto-orients each pick (fuselage → +Y nose
   forward, fin → +Z; per-model `yaw` overrides where span ≈ length defeats
   the heuristic), scales to the layer's unit grid (length 1.8), decimates
   by vertex clustering to ≤6k triangles, writes `processed/<family>.stl`
   plus a `processed.html` contact sheet — eyeball it (noses must point UP
   in the left column).
4. Review helpers: `preview.py` renders any directory of STLs to an
   isometric contact sheet. `python3 make_icons.py processed` emits the 2D
   map icons — simplified single-path top-down silhouettes (nose RIGHT,
   no fill; requires shapely) — into `processed/icons/`, plus an
   `icons.html` contact sheet. These are uploaded to Wasabi under
   `maps/aircraft/icons/<family>.svg` and are derivatives of the same
   models, so `models.json`'s attribution covers them.
5. Upload `processed/*.stl` + a regenerated `models.json` to Wasabi under
   `maps/aircraft/` (video-grabber creds, boto3
   `request_checksum_calculation="when_required"` — same Wasabi gotcha as
   scripts/build-basemap.md).

## License obligations

All models require attribution — kept in three places: `models.json`
(served next to the assets), the repo README's "3D Aircraft Models"
section, and these manifests. The GPL conversions (727, 757) are
derivatives and remain GPL; serving them as site assets with attribution
and a source link satisfies the license, and the conversion scripts here
are the "preferred form" bridge back to the sources.
