#!/usr/bin/env python3
"""Convert extracted (real lng/lat/height) DoITT building triangles into
the STL local-meters/+X east/+Y north/+Z up convention placeHeroMesh
expects, anchored at the same WTC North Tower point the WTC-only hero
uses (for consistency, not because this data needs any fitting -- it's
already real geographic coordinates, no calibration required)."""
import math
import pickle
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "aircraft-models"))
from process_models import write_stl  # noqa: E402

HERE = Path(__file__).parent
NORTH_TOWER_LNGLAT = (-74.013355, 40.712925)
BASE_ELEV_M = 4.0
METERS_PER_DEG_LAT = 111_320.0


def enu_meters(lng: float, lat: float) -> tuple[float, float]:
	ref_lng, ref_lat = NORTH_TOWER_LNGLAT
	m_per_deg_lng = METERS_PER_DEG_LAT * math.cos(math.radians(ref_lat))
	return ((lng - ref_lng) * m_per_deg_lng, (lat - ref_lat) * METERS_PER_DEG_LAT)


def main() -> None:
	with open(HERE / "extracted_tris.pkl", "rb") as f:
		tris = pickle.load(f)
	print(f"{len(tris):,} triangles")

	out_tris = []
	for tri in tris:
		verts = []
		for lng, lat, height_m in tri:
			east, north = enu_meters(lng, lat)
			verts.append((east, north, height_m + BASE_ELEV_M))
		out_tris.append(tuple(verts))

	dst = HERE / "doitt-lower-manhattan.stl"
	write_stl(out_tris, dst)
	print(f"wrote {dst} ({dst.stat().st_size / 1024 / 1024:.1f} MB)")

	xs = [v[0] for t in out_tris for v in t]
	ys = [v[1] for t in out_tris for v in t]
	ref_lng, ref_lat = NORTH_TOWER_LNGLAT
	m_per_deg_lng = METERS_PER_DEG_LAT * math.cos(math.radians(ref_lat))
	min_lng = ref_lng + min(xs) / m_per_deg_lng
	max_lng = ref_lng + max(xs) / m_per_deg_lng
	min_lat = ref_lat + min(ys) / METERS_PER_DEG_LAT
	max_lat = ref_lat + max(ys) / METERS_PER_DEG_LAT
	print(f'"exclude": [{min_lng:.5f}, {min_lat:.5f}, {max_lng:.5f}, {max_lat:.5f}]')


if __name__ == "__main__":
	main()
