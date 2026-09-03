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
