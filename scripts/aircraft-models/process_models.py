#!/usr/bin/env python3
"""Bake the user-approved aircraft models (PICKS.md) into marker-ready STLs.

Per model: parse → auto-orient (fuselage → +Y with nose forward, fin → +Z,
wings → ±X) → center → scale to the layer's unit grid (length 1.8 like
PLANE_SHAPE) → decimate by vertex clustering to a triangle budget → write
binary STL into processed/.

Auto-orientation heuristics (override per model in PICKS below):
- up axis   = smallest bounding extent; sign chosen so the taller extreme
              (the vertical fin) points +Z
- fuselage  = longest remaining extent → Y; nose sign chosen so the HALF
              with the taller max-Z (the tail fin) is at -Y
- x         = remaining axis, sign fixed for a right-handed frame

Run: python3 process_models.py   (writes processed/*.stl + processed.html)
"""
import struct
import sys
from pathlib import Path

from preview import parse_stl, render_svg

HERE = Path(__file__).parent
OUT = HERE / "processed"

TRI_BUDGET = 6_000

# family → (source file, overrides). Overrides: axis letters may force
# orientation when the heuristic misfires: {"up": "+z", "nose": "+y"} etc.
PICKS: dict[str, tuple[str, dict]] = {
	"generic": ("generic-a320.stl", {}),
	"b737": ("b737-737800-jonahash.stl", {}),
	"b757": ("b757-fgfs-gpl.stl", {}),
	"b767": ("b767-rticknor-767300er.stl", {}),
	"b777": ("b777-jyu-777300er.stl", {}),
	"b727": ("b727-yuppy-gpl.stl", {}),
	"md80": ("md80-boeing717.stl", {}),
	"dc10": ("dc10-reean24.stl", {"yaw": 45}),
	"a319": ("a320-p6619-a319.stl", {"yaw": -90}),
	"a320": ("a320-p6619-a321.stl", {}),
	"crj": ("crj-crj200.stl", {}),
	"erj": ("erj-erj145xr.stl", {}),
	"atr": ("atr-328jet.stl", {"yaw": -90}),
	"bizjet": ("bizjet-g550.stl", {}),
	"dc3": ("dc3-pumpkinhead.stl", {"yaw": -90}),
}

AXIS = {"x": 0, "y": 1, "z": 2}


def bounds(tris):
	mins = [min(v[i] for t in tris for v in t) for i in range(3)]
	maxs = [max(v[i] for t in tris for v in t) for i in range(3)]
	return mins, maxs


def remap(tris, order, signs):
	"""Reorder/flip axes: order[i] = source axis for output axis i."""
	out = []
	for t in tris:
		out.append(tuple(
			(v[order[0]] * signs[0], v[order[1]] * signs[1], v[order[2]] * signs[2])
			for v in t
		))
	return out


def auto_orient(tris, overrides):
	mins, maxs = bounds(tris)
	ext = [maxs[i] - mins[i] for i in range(3)]
	if "up" in overrides:
		up = AXIS[overrides["up"][1]]
	else:
		up = ext.index(min(ext))
	rest = [i for i in range(3) if i != up]
	fus = rest[0] if ext[rest[0]] >= ext[rest[1]] else rest[1]
	lat = rest[1] if fus == rest[0] else rest[0]

	# Up sign: the fin makes the up-side extreme larger than the belly side.
	mid_up = (mins[up] + maxs[up]) / 2
	if "up" in overrides:
		up_sign = 1 if overrides["up"][0] == "+" else -1
	else:
		up_sign = 1 if (maxs[up] - mid_up) >= (mid_up - mins[up]) else -1

	# Reorder into (lat, fus, up) = (x, y, z), then decide the nose sign.
	tris = remap(tris, [lat, fus, up], [1, 1, up_sign])
	mins2, maxs2 = bounds(tris)
	midy = (mins2[1] + maxs2[1]) / 2
	front_z = max((max(v[2] for v in t) for t in tris
		if sum(v[1] for v in t) / 3 > midy), default=0)
	back_z = max((max(v[2] for v in t) for t in tris
		if sum(v[1] for v in t) / 3 <= midy), default=0)
	if "nose" in overrides:
		nose_sign = 1 if overrides["nose"][0] == "+" else -1
	else:
		# Tail fin is the tallest structure → the taller half is the BACK.
		nose_sign = 1 if back_z >= front_z else -1
	if nose_sign == -1:
		tris = remap(tris, [0, 1, 2], [-1, -1, 1])  # yaw 180°, keeps chirality
	# Final hand override for models whose geometry is rotated in-file or
	# whose span ≈ length defeats the fuselage heuristic. Degrees CCW in xy.
	if "yaw" in overrides:
		import math
		th = math.radians(overrides["yaw"])
		cs, sn = math.cos(th), math.sin(th)
		tris = [tuple((v[0] * cs - v[1] * sn, v[0] * sn + v[1] * cs, v[2]) for v in t)
			for t in tris]
	return tris


def normalize(tris):
	mins, maxs = bounds(tris)
	c = [(mins[i] + maxs[i]) / 2 for i in range(3)]
	length = maxs[1] - mins[1] or 1e-9
	s = 1.8 / length  # match PLANE_SHAPE: fuselage spans y ∈ ±0.9
	return [tuple(((v[0] - c[0]) * s, (v[1] - c[1]) * s, (v[2] - c[2]) * s) for v in t)
		for t in tris]


def decimate(tris, budget):
	"""Vertex clustering: snap to a grid, drop collapsed triangles. The grid
	step doubles until the triangle count fits the budget."""
	if len(tris) <= budget:
		return tris
	step = 0.008
	while True:
		snapped = []
		for t in tris:
			q = tuple(
				(round(v[0] / step), round(v[1] / step), round(v[2] / step))
				for v in t
			)
			if q[0] != q[1] and q[1] != q[2] and q[0] != q[2]:
				snapped.append(tuple(
					(qq[0] * step, qq[1] * step, qq[2] * step) for qq in q
				))
		# Dedupe identical triangles (ignoring winding-preserving rotation).
		seen = set()
		out = []
		for t in snapped:
			key = tuple(sorted(t))
			if key in seen:
				continue
			seen.add(key)
			out.append(t)
		if len(out) <= budget or step > 0.2:
			return out
		step *= 1.4


def write_stl(tris, path: Path):
	out = bytearray()
	out += b"rt911 aircraft marker".ljust(80, b"\0")
	out += struct.pack("<I", len(tris))
	for a, b, c in tris:
		ux, uy, uz = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
		wx, wy, wz = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
		nx, ny, nz = uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx
		ln = (nx * nx + ny * ny + nz * nz) ** 0.5 or 1.0
		out += struct.pack("<12fH", nx / ln, ny / ln, nz / ln, *a, *b, *c, 0)
	path.write_bytes(out)


def top_svg(tris, size=240):
	"""Nose-up top-down check view (x lateral, y forward)."""
	parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}">']
	s = size / 2.1
	for t in tris:
		pts = " ".join(
			f"{size / 2 + v[0] * s:.1f},{size / 2 - v[1] * s:.1f}" for v in t
		)
		parts.append(f'<polygon points="{pts}"/>')
	parts.append("</svg>")
	return "".join(parts)


def main():
	OUT.mkdir(exist_ok=True)
	cards = []
	for family, (src, overrides) in PICKS.items():
		tris = parse_stl(HERE / src)
		tris = auto_orient(tris, overrides)
		tris = normalize(tris)
		before = len(tris)
		tris = decimate(tris, TRI_BUDGET)
		dst = OUT / f"{family}.stl"
		write_stl(tris, dst)
		print(f"{family}: {src} {before} → {len(tris)} tris, {dst.stat().st_size // 1024} KB")
		cards.append(
			f'<div class="card">{top_svg(tris)}{render_svg(tris, 240)}'
			f"<p><b>{family}</b> · {len(tris):,} tris · {dst.stat().st_size // 1024} KB</p></div>"
		)
	(HERE / "processed.html").write_text(
		"<!doctype html><meta charset='utf-8'><title>Processed markers</title>"
		"<style>body{font:13px sans-serif;display:flex;flex-wrap:wrap;gap:12px;padding:12px}"
		".card{border:1px solid #ccc;padding:8px}svg{background:#f5f2ea}"
		"p{margin:4px 0 0}</style>"
		"<p style='width:100%'>Left = top-down (nose must point UP); right = isometric.</p>"
		+ "".join(cards)
	)
	print("wrote processed.html")


if __name__ == "__main__":
	main()
