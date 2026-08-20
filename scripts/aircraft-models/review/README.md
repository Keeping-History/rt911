# Model review assets

The raw inputs and review renders behind the shipped aircraft models
(`maps/aircraft/*.stl` on Wasabi — see `../README.md` and `../PICKS.md`):

- `*.stl`, `b727-yuppy.obj`, `b757-fgfs.ac` — candidate source models as
  downloaded/converted, named `<family>-<source>.<ext>`; `-NC`/`-gpl`
  suffixes flag the license (full terms in `../manifests/`).
- `processed/` — the 16 baked per-family STLs actually uploaded to Wasabi
  (normalized nose→+Y/fin→+Z, decimated; `../process_models.py`).
- `icons/` — top-down silhouette renders per candidate (`../make_icons.py`).
- `*.html` — the 3D contact sheets used during review (`../preview.py`).

The pipeline scripts and manifests live one level up; this folder held
byte-identical copies which were dropped in the move.
