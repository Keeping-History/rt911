#!/usr/bin/env python3
"""Bake new_york_in_the_90s.glb into a calibrated, decimated WTC hero STL.

Scope: the WTC complex only, not the whole city. A full-model rotation
search against building-recon's real 1,510-building Lower Manhattan
dataset (both a plain-rotation and a mirrored-rotation search, every
degree) found no rigid transform that aligns the source model with real
Manhattan beyond a few hundred meters of the towers -- this is a
stylized Sketchfab diorama, not a surveyed dataset, and only its "hero"
subject (the towers) was built to consistent scale/position. Clipping to
just the WTC complex, where the model IS accurate (confirmed against
building-recon's curated wtc_complex_2001.geojson footprints), and
leaving the real extruded-building data for everywhere else, is the
approach that's actually correct rather than a wholesale city replacement.

Run: python3 process_nyc_model.py [path/to/new_york_in_the_90s.glb]
Writes processed/nyc-90s-wtc-only.stl plus the manifest snippet to stdout.
"""
import math
import sys
from pathlib import Path

import numpy as np
import open3d as o3d

from nyc_glb import extract_world_triangles
from process_models import write_stl

HERE = Path(__file__).parent
OUT = HERE / "processed"
TRI_BUDGET = 150_000
# Radius (real meters) around the midpoint between the two towers to keep.
# Sized to comfortably cover the WTC superblock (towers, plaza, 3-7 WTC)
# without reaching into the surrounding city, where the source model's
# geometry is no longer positioned to real-world accuracy.
CLIP_RADIUS_M = 280.0


def quadric_decimate(tris: list, target_triangles: int) -> list:
	"""Weld the triangle soup into a shared vertex/index mesh and run open3d's
	quadric-error-metric simplification.

	This -- not vertex-clustering grid-snapping -- is what the original
	WTC hero model's pipeline used (see HERO_MODELS_CREDITS.md's prior
	entry: "decimated (open3d quadric, ~90k tris)"). Grid-snapping treats
	the input as a flat, topology-free triangle soup and independently
	rounds each vertex to the nearest grid point; on a regular repeating
	facade pattern (window bays, wall panels) that reliably shatters the
	pattern into jagged, degenerate-looking triangles because nearby-but-
	distinct vertices from different panels snap unevenly. Quadric
	decimation collapses edges by actual visual-error cost against a
	real vertex/index mesh, which preserves large-scale silhouette and
	regular patterns far better at the same triangle budget.
	"""
	vert_map: dict[tuple[float, float, float], int] = {}
	verts: list[tuple[float, float, float]] = []
	idx: list[tuple[int, int, int]] = []

	def key(v: tuple[float, float, float]) -> tuple[float, float, float]:
		return (round(v[0], 3), round(v[1], 3), round(v[2], 3))

	for tri in tris:
		face = []
		for v in tri:
			k = key(v)
			i = vert_map.get(k)
			if i is None:
				i = len(verts)
				vert_map[k] = i
				verts.append(v)
			face.append(i)
		idx.append(tuple(face))

	mesh = o3d.geometry.TriangleMesh()
	mesh.vertices = o3d.utility.Vector3dVector(np.array(verts, dtype=np.float64))
	mesh.triangles = o3d.utility.Vector3iVector(np.array(idx, dtype=np.int32))

	simplified = mesh.simplify_quadric_decimation(target_number_of_triangles=target_triangles)

	out_verts = np.asarray(simplified.vertices)
	out_tris = np.asarray(simplified.triangles)
	return [
		(
			tuple(out_verts[a]),
			tuple(out_verts[b]),
			tuple(out_verts[c]),
		)
		for a, b, c in out_tris
	]

# --- Calibration constants (see plans/2026-09-03-nyc-90s-hero-model-design.md) ---
NORTH_TOWER_MODEL_XZ = (-9.861272500021942, -34.7795508877096)
SOUTH_TOWER_MODEL_XZ = (0.5595594159559328, -41.01730324635449)
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

	Returns (a, b) such that for model point Zm = complex(x, z), the real
	ENU position is a * Zm + b. |a| is the scale (m/model-unit), arg(a) is
	the rotation needed to align the model's own horizontal plane to true
	east/north.
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


def clip_to_wtc_complex(tris: list, radius_m: float) -> list:
	"""Keep only calibrated triangles within `radius_m` of the midpoint
	between the two towers. Must run on already-calibrated (real-meter)
	triangles, not raw model-space ones."""
	a, b = fit_horizontal_similarity()
	nz = a * complex(*NORTH_TOWER_MODEL_XZ) + b
	sz = a * complex(*SOUTH_TOWER_MODEL_XZ) + b
	mid_east = (nz.real + sz.real) / 2
	mid_north = (nz.imag + sz.imag) / 2
	out = []
	for tri in tris:
		cx = sum(v[0] for v in tri) / 3
		cy = sum(v[1] for v in tri) / 3
		if math.hypot(cx - mid_east, cy - mid_north) <= radius_m:
			out.append(tri)
	return out


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


def main() -> None:
	src = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parent.parent / "new_york_in_the_90s.glb"
	OUT.mkdir(exist_ok=True)

	print(f"extracting triangles from {src} ...")
	tris = extract_world_triangles(src)
	print(f"{len(tris):,} triangles extracted")

	calibrated = calibrate(tris)
	clipped = clip_to_wtc_complex(calibrated, CLIP_RADIUS_M)
	print(f"clipped to {len(clipped):,} triangles within {CLIP_RADIUS_M}m of the WTC complex")

	decimated = quadric_decimate(clipped, TRI_BUDGET)
	print(f"decimated to {len(decimated):,} triangles")

	dst = OUT / "nyc-90s-wtc-only.stl"
	write_stl(decimated, dst)
	print(f"wrote {dst} ({dst.stat().st_size / 1024 / 1024:.1f} MB)")

	min_lng, min_lat, max_lng, max_lat = exclude_bbox(decimated)
	print(f'"exclude": [{min_lng:.5f}, {min_lat:.5f}, {max_lng:.5f}, {max_lat:.5f}]')

	a, _b = fit_horizontal_similarity()
	print(f"scale factor: {abs(a):.3f} m/unit, rotation: {math.degrees(math.atan2(a.imag, a.real)):.2f} deg")


if __name__ == "__main__":
	main()
