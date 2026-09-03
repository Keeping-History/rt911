# NYC-in-the-90s Hero Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Flight Tracker's WTC hero STL and, within its footprint, the extruded 2001-buildings layer, with a decimated/calibrated STL built from `new_york_in_the_90s.glb`.

**Architecture:** An offline, stdlib-only Python pipeline (mirroring `scripts/aircraft-models/process_models.py`'s existing style) parses the GLB, bakes its node hierarchy into world-space triangles, decimates them, calibrates them onto real lng/lat/meters using a 2-point similarity transform anchored on the two towers, and writes a binary STL that slots into the *existing, unmodified* hero-landmark rendering path (`heroBuildings.ts` / `buildings3DLayer.ts` / `buildingMesh.ts`).

**Tech Stack:** Python 3 (standard library only — `struct`, `json`, `math`; no numpy/pygltflib/trimesh, matching this directory's existing convention), TypeScript/Vitest for the frontend credit/test changes, boto3 for the Wasabi upload step.

**Spec:** `plans/2026-09-03-nyc-90s-hero-model-design.md`

## Global Constraints

- No changes to `buildingMesh.ts`, `buildings3DLayer.ts`, `heroBuildings.ts`, `useHeroBuildings.ts`, or `buildingModels.ts` — this is a content swap through the existing hero-landmark extension point.
- No new Python dependencies — `scripts/aircraft-models/` is stdlib-only today (`process_models.py` has zero imports beyond its own `preview` module); keep it that way.
- The manifest entry's `scale` MUST be `1.0` and `bearing_deg` MUST be `0` — all scale/rotation/recentering is baked into the STL's vertices during conversion, not applied at runtime (`placeHeroMesh` in `buildingMesh.ts` still runs, it just receives a pre-calibrated mesh and an identity placement).
- Attribution text, verbatim, wherever it's recorded: `"New York In The 90's" (https://skfb.ly/oSMBU) by rorovera201305 is licensed under Creative Commons Attribution (http://creativecommons.org/licenses/by/4.0/).`
- The raw 164MB `new_york_in_the_90s.glb` must never be `git add`ed — GitHub hard-rejects pushes with files over 100MB, and nothing in this pipeline needs it committed (Wasabi hosts the final, much smaller STL; `scripts/aircraft-models/processed/` is already gitignored-by-convention — it doesn't exist in git today and shouldn't start).
- Ground-truth constants (from `packages/tools/building-recon/data/wtc_complex_2001.geojson`, verified 2026-09-03): North Tower height 417m, footprint center `(-74.013355, 40.712925)`; South Tower height 415m, footprint center `(-74.012305, 40.712155)`; both base elevation 4m. AA11 struck the North Tower's north face at floors 93–99; UA175 struck the South Tower's south face at floors 77–85 (per user).

---

### Task 1: GLB world-space triangle extractor

**Files:**
- Create: `scripts/aircraft-models/nyc_glb.py`
- Modify: repo root `.gitignore` (add the source GLB so it can never be accidentally staged)

**Interfaces:**
- Produces: `extract_world_triangles(path: Path) -> list[Triangle]`, where `Triangle = tuple[tuple[float,float,float], tuple[float,float,float], tuple[float,float,float]]` — the exact same triangle representation `process_models.py`'s `parse_stl()` returns, so `decimate()` and `write_stl()` from that module are reusable without adaptation in Task 2.
- Coordinate convention of the output: glTF's own world space, **Y-up** (this is NOT yet the STL's Z-up/local-meters convention — that remap happens in Task 3's calibration step).

- [ ] **Step 1: Gitignore the source file**

```bash
echo '/new_york_in_the_90s.glb' >> .gitignore
```

- [ ] **Step 2: Write the extractor module**

```python
#!/usr/bin/env python3
"""Parse new_york_in_the_90s.glb into world-space triangles.

Bakes every node's cumulative transform (an explicit 4x4 matrix, or
translation/rotation/scale) down into each mesh primitive's vertices.
Standard library only, matching this directory's process_models.py.
"""
import json
import struct
import sys
from pathlib import Path

_JSON_CHUNK = 0x4E4F534A  # ASCII "JSON"
_BIN_CHUNK = 0x004E4942   # ASCII "BIN\0"

_COMPONENT_FORMATS = {
    5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2),
    5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4),
}
_TYPE_COUNTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}

IDENTITY = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]]

Triangle = tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]


def read_glb(path: Path) -> tuple[dict, bytes]:
    with open(path, "rb") as f:
        magic, _version, length = struct.unpack("<4sII", f.read(12))
        if magic != b"glTF":
            raise ValueError(f"not a GLB file: {magic!r}")
        chunks: dict[int, bytes] = {}
        while f.tell() < length:
            chunk_len, chunk_type = struct.unpack("<II", f.read(8))
            chunks[chunk_type] = f.read(chunk_len)
    return json.loads(chunks[_JSON_CHUNK]), chunks.get(_BIN_CHUNK, b"")


def read_accessor(gltf: dict, binary: bytes, idx: int) -> list:
    acc = gltf["accessors"][idx]
    fmt_char, comp_size = _COMPONENT_FORMATS[acc["componentType"]]
    n_comp = _TYPE_COUNTS[acc["type"]]
    bv = gltf["bufferViews"][acc["bufferView"]]
    base = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = bv.get("byteStride") or n_comp * comp_size
    fmt = "<" + fmt_char * n_comp
    out = []
    for i in range(acc["count"]):
        off = base + i * stride
        vals = struct.unpack_from(fmt, binary, off)
        out.append(vals if n_comp > 1 else vals[0])
    return out


def _node_local_matrix(node: dict) -> list[list[float]]:
    if "matrix" in node:
        m = node["matrix"]  # column-major, 16 floats
        return [[m[c * 4 + r] for c in range(4)] for r in range(4)]
    t = node.get("translation", [0.0, 0.0, 0.0])
    x, y, z, w = node.get("rotation", [0.0, 0.0, 0.0, 1.0])
    s = node.get("scale", [1.0, 1.0, 1.0])
    rot = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]
    m = [[rot[i][0] * s[0], rot[i][1] * s[1], rot[i][2] * s[2], t[i]] for i in range(3)]
    m.append([0.0, 0.0, 0.0, 1.0])
    return m


def _matmul(a: list[list[float]], b: list[list[float]]) -> list[list[float]]:
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def _apply(m: list[list[float]], p: tuple[float, float, float]) -> tuple[float, float, float]:
    x, y, z = p
    return tuple(m[i][0] * x + m[i][1] * y + m[i][2] * z + m[i][3] for i in range(3))


def extract_world_triangles(path: Path) -> list[Triangle]:
    """Every mesh primitive's triangles, baked into world space.

    Skips Camera/Light nodes (no "mesh" key) and any primitive whose mode
    isn't TRIANGLES (4) -- every primitive in this file is TRIANGLES.
    """
    gltf, binary = read_glb(path)
    nodes = gltf["nodes"]
    meshes = gltf["meshes"]
    scene = gltf["scenes"][gltf["scene"]]
    tris: list[Triangle] = []

    def visit(idx: int, parent_m: list[list[float]]) -> None:
        node = nodes[idx]
        m = _matmul(parent_m, _node_local_matrix(node))
        if "mesh" in node:
            mesh = meshes[node["mesh"]]
            for prim in mesh["primitives"]:
                if prim.get("mode", 4) != 4:
                    continue
                positions = read_accessor(gltf, binary, prim["attributes"]["POSITION"])
                if "indices" in prim:
                    indices = read_accessor(gltf, binary, prim["indices"])
                else:
                    indices = list(range(len(positions)))
                for i in range(0, len(indices) - 2, 3):
                    a = _apply(m, positions[indices[i]])
                    b = _apply(m, positions[indices[i + 1]])
                    c = _apply(m, positions[indices[i + 2]])
                    tris.append((a, b, c))
        for child in node.get("children", []):
            visit(child, m)

    for root in scene["nodes"]:
        visit(root, IDENTITY)
    return tris


if __name__ == "__main__":
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / "new_york_in_the_90s.glb"
    tris = extract_world_triangles(src)
    xs = [v[0] for t in tris for v in t]
    ys = [v[1] for t in tris for v in t]
    zs = [v[2] for t in tris for v in t]
    print(f"triangles: {len(tris)}")
    print(f"bounds x: {min(xs):.3f} .. {max(xs):.3f}")
    print(f"bounds y: {min(ys):.3f} .. {max(ys):.3f}")
    print(f"bounds z: {min(zs):.3f} .. {max(zs):.3f}")
    assert len(tris) == 2_678_405, f"expected 2,678,405 triangles, got {len(tris)}"
    assert -4.0 < min(ys) < -3.0, f"unexpected min Y: {min(ys)}"
    assert 54.0 < max(ys) < 55.0, f"unexpected max Y: {max(ys)}"
    print("OK: matches the bounds recorded in plans/2026-09-03-nyc-90s-hero-model-design.md")
```

- [ ] **Step 3: Run the self-check**

```bash
cd scripts/aircraft-models
python3 nyc_glb.py ../../new_york_in_the_90s.glb
```

Expected output ends with:
```
triangles: 2678405
bounds x: -500.8... .. 498.1...
bounds y: -3.4... .. 54.5...
bounds z: -275.3... .. 278.2...
OK: matches the bounds recorded in plans/2026-09-03-nyc-90s-hero-model-design.md
```

- [ ] **Step 4: Commit**

```bash
git add .gitignore scripts/aircraft-models/nyc_glb.py
git commit -m "$(cat <<'EOF'
Add stdlib-only GLB world-space triangle extractor for the NYC hero model

Bakes the full node-transform hierarchy of new_york_in_the_90s.glb down
into a flat triangle list, matching process_models.py's existing
triangle representation so its decimate()/write_stl() are reusable.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ScLtW62Eep8prFdRqqtNUE
EOF
)"
```

---

### Task 2: Decimated, uncalibrated provisional STL

**Files:**
- Create: `scripts/aircraft-models/process_nyc_model.py`

**Interfaces:**
- Consumes: `extract_world_triangles` from Task 1's `nyc_glb.py`; `decimate(tris, budget, start_step=0.008)` and `write_stl(tris, path)` from `process_models.py` (both take/return the same `Triangle` list shape).
- Produces: `scripts/aircraft-models/processed/nyc-90s-provisional.stl` (not calibrated yet — this task only proves the decimate/export path works end to end).

- [ ] **Step 1: Make `decimate()`'s starting grid step configurable**

`process_models.py`'s `decimate()` hardcodes `step = 0.008`, tuned for aircraft models already normalized to a ~1.8-unit length. This model's own units span ~1000, so that starting step would need ~17 doubling passes (`0.008 * 1.4^n`) before it's coarse enough to cluster anything — correct, but needlessly slow over 2.68M triangles. Add an optional parameter, default unchanged so the 15 existing aircraft calls are untouched:

```python
def decimate(tris, budget, start_step=0.008):
	"""Vertex clustering: snap to a grid, drop collapsed triangles. The grid
	step doubles until the triangle count fits the budget."""
	if len(tris) <= budget:
		return tris
	step = start_step
	while True:
```

(Only the signature and the `step = start_step` line change — the rest of the function body is unchanged.)

- [ ] **Step 2: Write the driver script's provisional-export stage**

```python
#!/usr/bin/env python3
"""Bake new_york_in_the_90s.glb into a calibrated, decimated hero STL.

Run: python3 process_nyc_model.py [path/to/new_york_in_the_90s.glb]
Writes processed/nyc-90s-provisional.stl (Task 2) and, once calibration
is added (Task 3), processed/nyc-90s-v1.stl plus a manifest snippet.
"""
import sys
from pathlib import Path

from nyc_glb import extract_world_triangles
from process_models import decimate, write_stl

HERE = Path(__file__).parent
OUT = HERE / "processed"
TRI_BUDGET = 150_000


def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parent.parent / "new_york_in_the_90s.glb"
    OUT.mkdir(exist_ok=True)

    print(f"extracting triangles from {src} ...")
    tris = extract_world_triangles(src)
    print(f"{len(tris):,} triangles extracted")

    decimated = decimate(tris, TRI_BUDGET, start_step=2.0)
    print(f"decimated to {len(decimated):,} triangles")

    dst = OUT / "nyc-90s-provisional.stl"
    write_stl(decimated, dst)
    print(f"wrote {dst} ({dst.stat().st_size / 1024 / 1024:.1f} MB)")


if __name__ == "__main__":
    main()
```

(`start_step=2.0` is a starting guess matched to this model's own unscaled units, where individual building/wall features are on the order of a few units across — it only affects how many doubling passes `decimate()` needs to converge, not correctness; if the first run still takes unreasonably long, doubling it again is safe.)

- [ ] **Step 3: Run it and verify the output**

```bash
cd scripts/aircraft-models
time python3 process_nyc_model.py ../../new_york_in_the_90s.glb
```

Expected: prints `2,678,405 triangles extracted`, then a decimated count at or below 150,000 (vertex-clustering can land under budget — that's fine), then a file size well under 10MB (150k triangles × 50 bytes/triangle ≈ 7.5MB is the STL-format ceiling for that budget). This step decimates ~2.7M triangles in pure Python — expect several minutes, possibly up to ~15; that's a one-off cost, not something to optimize further.

- [ ] **Step 4: Eyeball it**

Reuse the existing preview tool to render an isometric contact sheet, matching this directory's established review workflow (`README.md`'s step 4):

```bash
python3 -c "
from pathlib import Path
from preview import parse_stl, render_svg
tris = parse_stl(Path('processed/nyc-90s-provisional.stl'))
Path('processed/nyc-90s-provisional.html').write_text(
    f'<!doctype html><meta charset=utf-8>{render_svg(tris, 800)}'
)
"
```

Open `processed/nyc-90s-provisional.html` in a browser. Expected: a recognizable, if unrotated/unscaled/uncentered, low-poly city skyline with two visibly taller towers standing out — confirms Task 1's extraction and this task's decimation preserved the model's structure before calibration is layered on in Task 3. If it looks like scattered noise instead of a skyline, stop and re-check Task 1 before proceeding — decimation only removes detail, it can't explain structural corruption.

- [ ] **Step 5: Commit**

```bash
git add scripts/aircraft-models/process_models.py scripts/aircraft-models/process_nyc_model.py
git commit -m "$(cat <<'EOF'
Add provisional (uncalibrated) decimation stage for the NYC hero model

Also gives decimate() an optional start_step (default unchanged) so a
~1000-unit-scale mesh doesn't need ~17 doubling passes from the
aircraft-tuned 0.008 default.

Proves the extract -> decimate -> write_stl path end to end before
calibration math is layered on top.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ScLtW62Eep8prFdRqqtNUE
EOF
)"
```

(`processed/*.stl` and `.html` stay untracked — this directory has never committed generated output, only source/review inputs; don't add them.)

---

### Task 3: Tower-anchored calibration

**Files:**
- Modify: `scripts/aircraft-models/process_nyc_model.py`

**Interfaces:**
- Produces: `scripts/aircraft-models/processed/nyc-90s-v1.stl` — final STL in the convention `placeHeroMesh` (in `buildingMesh.ts`, unmodified) expects: local meters, +X east, +Y north, +Z up, origin at the North Tower's real footprint center, ready for a manifest entry with `scale: 1.0, bearing_deg: 0`.
- Produces (printed to stdout): the computed `exclude` bbox (`[minLng, minLat, maxLng, maxLat]`) for the manifest entry, and the two towers' calibrated heights for the Task 4 visual check.

**Calibration facts baked into this step** (see spec's "Calibration" section for how these were derived — this task consumes them, doesn't re-derive them):

| Constant | Value | Source |
|---|---|---|
| North Tower model-space centroid `(x, z)` | `(-9.96, -34.71)` | average of its cluster's roof-peak vertices |
| South Tower model-space centroid `(x, z)` | `(1.64, -42.47)` | same |
| North Tower real footprint center | `(-74.013355, 40.712925)` | `wtc_complex_2001.geojson` |
| South Tower real footprint center | `(-74.012305, 40.712155)` | `wtc_complex_2001.geojson` |
| Model-space local ground near the towers | `0.311` (glTF Y) | lowest vertex within 15 units of the North Tower's tallest point |
| Base elevation | `4.0m` | matches the existing WTC hero entry |

- [ ] **Step 1: Add the calibration transform**

```python
import math

# --- Calibration constants (see plans/2026-09-03-nyc-90s-hero-model-design.md) ---
NORTH_TOWER_MODEL_XZ = (-9.96, -34.71)
SOUTH_TOWER_MODEL_XZ = (1.64, -42.47)
NORTH_TOWER_LNGLAT = (-74.013355, 40.712925)
SOUTH_TOWER_LNGLAT = (-74.012305, 40.712155)
GROUND_Y_MODEL = 0.311
BASE_ELEV_M = 4.0
METERS_PER_DEG_LAT = 111_320.0


def enu_meters(lng: float, lat: float, ref_lng: float, ref_lat: float) -> complex:
    """Flat local tangent-plane approx: east + north*1j, meters from the ref point."""
    m_per_deg_lng = METERS_PER_DEG_LAT * math.cos(math.radians(ref_lat))
    east = (lng - ref_lng) * m_per_deg_lng
    north = (lat - ref_lat) * METERS_PER_DEG_LAT
    return complex(east, north)


def fit_horizontal_similarity() -> tuple[complex, complex]:
    """2-point similarity transform: model (x, z) -> real ENU meters.

    Returns (a, b) such that for model point Zm = complex(x, z),
    the real ENU position is a * Zm + b. |a| is the scale (m/model-unit),
    arg(a) is the rotation needed to align the model's own horizontal
    plane to true east/north.
    """
    zm1 = complex(*NORTH_TOWER_MODEL_XZ)
    zm2 = complex(*SOUTH_TOWER_MODEL_XZ)
    zr1 = complex(0, 0)  # North Tower is the ENU origin
    zr2 = enu_meters(*SOUTH_TOWER_LNGLAT, *NORTH_TOWER_LNGLAT)
    a = (zr2 - zr1) / (zm2 - zm1)
    b = zr1 - a * zm1
    return a, b


def calibrate(tris: list) -> list:
    """Map every triangle from GLB world space (Y-up) into the STL's
    local-meters / +X east / +Y north / +Z up convention, anchored at the
    North Tower's real footprint center."""
    a, b = fit_horizontal_similarity()
    scale = abs(a)

    def transform(p: tuple[float, float, float]) -> tuple[float, float, float]:
        x_glb, y_glb, z_glb = p
        r = a * complex(x_glb, z_glb) + b
        east, north = r.real, r.imag
        up = (y_glb - GROUND_Y_MODEL) * scale + BASE_ELEV_M
        return (east, north, up)

    return [tuple(transform(v) for v in tri) for tri in tris]


def exclude_bbox(tris: list) -> tuple[float, float, float, float]:
    """The calibrated mesh's footprint as a [minLng, minLat, maxLng, maxLat]
    box, for the manifest's `exclude` field. Inverts enu_meters around the
    North Tower anchor."""
    ref_lng, ref_lat = NORTH_TOWER_LNGLAT
    m_per_deg_lng = METERS_PER_DEG_LAT * math.cos(math.radians(ref_lat))
    eastings = [v[0] for t in tris for v in t]
    northings = [v[1] for t in tris for v in t]
    min_lng = ref_lng + min(eastings) / m_per_deg_lng
    max_lng = ref_lng + max(eastings) / m_per_deg_lng
    min_lat = ref_lat + min(northings) / METERS_PER_DEG_LAT
    max_lat = ref_lat + max(northings) / METERS_PER_DEG_LAT
    return (min_lng, min_lat, max_lng, max_lat)
```

- [ ] **Step 2: Wire calibration into `main()`, replacing the provisional-only export**

```python
def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parent.parent / "new_york_in_the_90s.glb"
    OUT.mkdir(exist_ok=True)

    print(f"extracting triangles from {src} ...")
    tris = extract_world_triangles(src)
    print(f"{len(tris):,} triangles extracted")

    decimated = decimate(tris, TRI_BUDGET)
    print(f"decimated to {len(decimated):,} triangles")

    calibrated = calibrate(decimated)

    dst = OUT / "nyc-90s-v1.stl"
    write_stl(calibrated, dst)
    print(f"wrote {dst} ({dst.stat().st_size / 1024 / 1024:.1f} MB)")

    min_lng, min_lat, max_lng, max_lat = exclude_bbox(calibrated)
    print(f'"exclude": [{min_lng:.5f}, {min_lat:.5f}, {max_lng:.5f}, {max_lat:.5f}]')

    a, _b = fit_horizontal_similarity()
    print(f"scale factor: {abs(a):.3f} m/unit, rotation: {math.degrees(math.atan2(a.imag, a.real)):.2f} deg")
```

- [ ] **Step 3: Run it and sanity-check the printed numbers**

```bash
cd scripts/aircraft-models
python3 process_nyc_model.py ../../new_york_in_the_90s.glb
```

Expected: `scale factor` prints close to `8.8` m/unit; the `exclude` bbox prints four numbers spanning roughly `74.05`–`73.97` longitude and `40.68`–`40.75` latitude (an ~8km-wide box centered on the WTC site) — if it prints a bbox two or three orders of magnitude off that, a constant above has a units bug (degrees vs. meters is the likely culprit).

- [ ] **Step 4: Commit**

```bash
git add scripts/aircraft-models/process_nyc_model.py
git commit -m "$(cat <<'EOF'
Add tower-anchored calibration to the NYC hero model pipeline

2-point similarity transform (North + South Tower footprint centers)
maps the model's own horizontal plane onto real lng/lat meters; vertical
scale reuses the same factor, anchored on the towers' local ground level.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ScLtW62Eep8prFdRqqtNUE
EOF
)"
```

---

### Task 4: Dev-fixture wiring and visual confirmation

**Files:**
- Modify: `packages/frontend/public/maps/hero-buildings.sample.json`
- Create (untracked, local only): `packages/frontend/public/maps/heroes/nyc-90s-v1.stl` (copy of Task 3's output)

**Interfaces:**
- Consumes: `processed/nyc-90s-v1.stl` from Task 3, and the printed `exclude` bbox.
- Produces: a visually-confirmed (or corrected) set of calibration constants — if this task changes any constant in Task 3's script, re-run Task 3's Step 3 and repeat this task with the regenerated STL.

- [ ] **Step 1: Point the dev fixture at the new model**

```bash
cp scripts/aircraft-models/processed/nyc-90s-v1.stl \
   packages/frontend/public/maps/heroes/nyc-90s-v1.stl
```

Edit `packages/frontend/public/maps/hero-buildings.sample.json` to:

```json
{
  "heroes": [
    {
      "id": "nyc-90s-v1",
      "stl_url": "maps/heroes/nyc-90s-v1.stl",
      "lng": -74.013355,
      "lat": 40.712925,
      "bearing_deg": 0,
      "scale": 1.0,
      "base_elev_m": 4,
      "exclude": [-74.05000, 40.68000, -73.97000, 40.75000]
    }
  ]
}
```

Replace the `exclude` array with Task 3's printed values exactly.

- [ ] **Step 2: Start the dev server and load the Flight Tracker**

```bash
pnpm --filter @rt911/frontend dev
```

Open the app, launch Flight Tracker, enable 3D buildings, and navigate to the WTC site (Lower Manhattan, zoom ≥ 12 — `BUILDINGS_MIN_ZOOM`). Switch on the satellite basemap for a ground-truth street-grid overlay if the app's map-style menu offers it.

- [ ] **Step 3: Visual checks (this is the mandatory human-in-the-loop calibration step)**

Check, in order:
1. **No mirror flip / gross misplacement:** the modeled skyline should sit over Manhattan, not a rotated/flipped reflection of it, and should not appear in the Hudson or East River.
2. **Two towers stand out** near the WTC site, taller than everything around them.
3. **AA11's track** (find it via the app's existing flight-search/notable-flights UI) terminates at the **north** face of the **taller** of the two towers, at a height that looks like roughly floors 93–99 (upper third of the tower).
4. **UA175's track** terminates at the **south** face of the **other** tower, at a height around floors 77–85 (a bit above two-thirds up).
5. Streets/blocks broadly line up with the satellite layer beneath — small offsets are expected (this is a stylized model, not survey-precision), but a match within roughly a block is the bar.

- [ ] **Step 4: If it's off, adjust and re-run**

Any needed correction traces to one of Task 3's named constants:
- Systematic rotation error → double-check `fit_horizontal_similarity`'s `zm1`/`zm2` (re-measure the tower centroids more precisely if the clusters are ambiguous) rather than hand-tuning an angle.
- Towers too short/tall → adjust `GROUND_Y_MODEL` (moves the whole scene's baseline) — do not hand-tune `scale` directly, since it's derived from real distances, not guessed.
- Wrong tower identified as North/South → swap `NORTH_TOWER_MODEL_XZ`/`SOUTH_TOWER_MODEL_XZ`.

After any constant change, re-run Task 3 Step 3, re-copy the STL (Step 1 above), refresh the dev server, and re-check.

- [ ] **Step 5: Commit the confirmed dev fixture**

```bash
git add packages/frontend/public/maps/hero-buildings.sample.json
git commit -m "$(cat <<'EOF'
Point the dev hero-buildings fixture at the calibrated NYC 90s model

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ScLtW62Eep8prFdRqqtNUE
EOF
)"
```

(The copied `.stl` under `public/maps/heroes/` stays untracked, same as today's `placeholder-tower.stl` being the only committed fixture there — the real hero models are Wasabi-only.)

---

### Task 5: Credits and provenance

**Files:**
- Modify: `packages/frontend/src/data/aircraftCredits.ts`
- Modify: `packages/frontend/src/data/aircraftCredits.test.ts`
- Modify: `scripts/aircraft-models/HERO_MODELS_CREDITS.md`
- Verify (no expected changes): `packages/frontend/src/data/provenance.ts` — it already references `WTC_HERO_CREDIT` by name, so renaming the constant is the only edit it needs.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `NYC_90S_HERO_CREDIT: ModelCredit`, replacing `WTC_HERO_CREDIT` everywhere it's referenced.

- [ ] **Step 1: Update the failing test first**

In `aircraftCredits.test.ts`, the existing test:

```typescript
	it("credits NanoRay for the WTC complex under CC-BY", () => {
		expect(WTC_HERO_CREDIT.author).toContain("NanoRay");
		expect(WTC_HERO_CREDIT.license).toContain("CC-BY");
	});
```

becomes:

```typescript
	it("credits rorovera201305 for the NYC 90s model under CC-BY", () => {
		expect(NYC_90S_HERO_CREDIT.author).toContain("rorovera201305");
		expect(NYC_90S_HERO_CREDIT.license).toContain("CC-BY");
	});
```

Update its import line and the `it.each([...AIRCRAFT_CREDITS, WTC_HERO_CREDIT])` line to use `NYC_90S_HERO_CREDIT` instead of `WTC_HERO_CREDIT`.

- [ ] **Step 2: Run the test, confirm it fails**

```bash
pnpm --filter @rt911/frontend exec vitest run src/data/aircraftCredits.test.ts
```

Expected: FAIL — `NYC_90S_HERO_CREDIT` is not exported yet.

- [ ] **Step 3: Replace the credit entry**

In `aircraftCredits.ts`, replace:

```typescript
export const WTC_HERO_CREDIT: ModelCredit = {
	model: "World Trade Center complex (1974–2001)",
	author: "NanoRay",
	license: "CC-BY 4.0",
	url: "https://sketchfab.com/3d-models/world-trade-center-673f0ab7f31e4d878fb2c7920cea0ec5",
	note: "Decimated, reoriented and scaled to the true tower height — a derivative work, attribution retained per CC-BY.",
};
```

with:

```typescript
export const NYC_90S_HERO_CREDIT: ModelCredit = {
	model: "New York In The 90's",
	author: "rorovera201305",
	license: "CC-BY 4.0",
	url: "https://skfb.ly/oSMBU",
	note: "\"New York In The 90's\" by rorovera201305 is licensed under Creative Commons Attribution (http://creativecommons.org/licenses/by/4.0/). Decimated (2.68M → ≤150k triangles), recentered and rescaled to match the real World Trade Center towers' documented height and separation — a derivative work, attribution retained per CC-BY.",
};
```

- [ ] **Step 4: Update `provenance.ts`'s reference**

```typescript
import { AIRCRAFT_CREDITS, NYC_90S_HERO_CREDIT, type ModelCredit } from "./aircraftCredits";
```
and
```typescript
		credits: [NYC_90S_HERO_CREDIT, ...AIRCRAFT_CREDITS],
```

- [ ] **Step 5: Run the test again, confirm it passes**

```bash
pnpm --filter @rt911/frontend exec vitest run src/data/aircraftCredits.test.ts
```

Expected: PASS.

- [ ] **Step 6: Update the standalone credits doc**

In `scripts/aircraft-models/HERO_MODELS_CREDITS.md`, replace the "World Trade Center complex" section with:

```markdown
## New York in the 1990s (`nyc-90s-v1`)

- **Model:** "New York In The 90's" by **rorovera201305**.
- **Source:** https://skfb.ly/oSMBU
- **License:** **CC Attribution (CC-BY 4.0)** — https://creativecommons.org/licenses/by/4.0/
- **Use:** downloaded as glTF (187 meshes, 2.68M triangles, no textures),
  every node's transform baked into world space, decimated by vertex
  clustering to ≤150k triangles, and calibrated onto real lng/lat/meters
  via a 2-point similarity transform anchored on the North and South Towers'
  documented footprint centers and heights (`packages/tools/building-recon`'s
  curated `wtc_complex_2001.geojson`). Hosted as `maps/heroes/nyc-90s-v1.stl`.
  This is a derivative work; attribution to rorovera201305 is retained per
  CC-BY. Replaces the prior NanoRay WTC-only model and the extruded
  GeoJSON footprints within its coverage.
```

- [ ] **Step 7: Run the full frontend test suite**

```bash
pnpm --filter @rt911/frontend exec vitest run
```

Expected: PASS (no other test references `WTC_HERO_CREDIT` by name — confirm with a repo-wide grep before this step: `grep -rn WTC_HERO_CREDIT packages/frontend/src` should print nothing after Steps 3–4).

- [ ] **Step 8: Commit**

```bash
git add packages/frontend/src/data/aircraftCredits.ts \
        packages/frontend/src/data/aircraftCredits.test.ts \
        packages/frontend/src/data/provenance.ts \
        scripts/aircraft-models/HERO_MODELS_CREDITS.md
git commit -m "$(cat <<'EOF'
Credit rorovera201305's NYC 90s model in place of the WTC-only credit

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ScLtW62Eep8prFdRqqtNUE
EOF
)"
```

---

### Task 6: Production upload and final verification

**Files:** none new — this task ships Task 3's artifact and points production config at it.

- [ ] **Step 1: Upload the STL to Wasabi**

Following this repo's existing pattern for hero/basemap assets (`scripts/build-basemap.md`, `scripts/aircraft-models/README.md`): video-grabber Wasabi credentials, `request_checksum_calculation="when_required"` (Wasabi rejects boto3 ≥1.36's default checksum header).

```python
import boto3
from botocore.config import Config

s3 = boto3.client(
    "s3",
    endpoint_url="https://s3.wasabisys.com",  # confirm region endpoint matches existing files.911realtime.org config
    config=Config(request_checksum_calculation="when_required", s3={"addressing_style": "path"}),
)
s3.upload_file(
    "scripts/aircraft-models/processed/nyc-90s-v1.stl",
    "<the files.911realtime.org bucket name>",
    "maps/heroes/nyc-90s-v1.stl",
    ExtraArgs={"ContentType": "model/stl", "CacheControl": "max-age=31536000"},
)
```

- [ ] **Step 2: Update the production manifest**

Fetch the current manifest, replace the `wtc-complex` entry with the same shape used in Task 4's dev fixture (real `exclude` bbox from Task 3's output), and re-upload `maps/hero-buildings.json` the same way as Step 1.

- [ ] **Step 3: Purge CDN cache if fronted by one**

Per `project-flight-basemap-coastline` precedent (in-place Wasabi re-upload needs a CDN purge for existing paths) — `hero-buildings.json` is a new path here (different `id`) so this is precautionary, but the old `wtc-complex-v2.stl` object is untouched and doesn't need purging since nothing will reference it once the manifest updates.

- [ ] **Step 4: Full verification pass**

```bash
pnpm --filter @rt911/frontend exec tsc -b
pnpm --filter @rt911/frontend lint
pnpm --filter @rt911/frontend exec vitest run
```

Expected: all three pass clean.

- [ ] **Step 5: Manual verification against production data**

Use `packages/frontend:verify` to drive the app: load Flight Tracker, confirm the production manifest fetch (not the sample fixture) resolves the new model, and repeat Task 4 Step 3's visual checks once more against the live Wasabi-hosted asset (a fresh upload occasionally exposes a path/CORS/content-type mistake the local fixture didn't).

- [ ] **Step 6: Commit any production-config changes tracked in this repo**

If a production `.env`/config file (rather than only the Wasabi-hosted manifest) needed a path change, commit it here; otherwise this task has no repo-tracked changes beyond what Task 5 already committed, and the remaining work (Wasabi upload) is a deployment action outside git.

## Self-Review Notes

- **Spec coverage:** every numbered section of the design doc (offline conversion, calibration, manifest swap, credits, error handling, testing, out-of-scope) maps to a task above. Error handling needed no task — `loadHeroStl`'s existing null+warn fallback (unmodified) already covers a bad STL fetch.
- **Type/name consistency:** `Triangle`, `extract_world_triangles`, `decimate`, `write_stl`, `calibrate`, `exclude_bbox`, `fit_horizontal_similarity`, `NYC_90S_HERO_CREDIT` are used identically across every task that references them.
- **No placeholders:** every constant used in Task 3's calibration code is the specific value derived in the design doc, not a "TBD" — the only genuinely open numbers (final bearing/scale/ground fine-tuning) are explicitly flagged as Task 4's human-in-the-loop deliverable, which is the correct place for them given the source model has no ground-truth georeferencing.
