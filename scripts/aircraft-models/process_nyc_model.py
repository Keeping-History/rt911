#!/usr/bin/env python3
"""Bake new_york_in_the_90s.glb into a calibrated, decimated hero STL.

Run: python3 process_nyc_model.py [path/to/new_york_in_the_90s.glb]
Writes processed/nyc-90s-v1.stl plus the manifest snippet to stdout.
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
