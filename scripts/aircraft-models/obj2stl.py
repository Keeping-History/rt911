#!/usr/bin/env python3
"""Convert a Wavefront OBJ (v/f lines; f may be v, v/vt, v/vt/vn, v//vn,
with negative indices) to binary STL. Faces with >3 vertices fan-triangulate.

Usage: python3 obj2stl.py in.obj out.stl
"""
import struct
import sys


def main(src: str, dst: str) -> None:
    verts: list[tuple[float, float, float]] = []
    tris: list[tuple[int, int, int]] = []
    with open(src, encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            parts = line.split()
            if not parts:
                continue
            if parts[0] == "v" and len(parts) >= 4:
                verts.append((float(parts[1]), float(parts[2]), float(parts[3])))
            elif parts[0] == "f" and len(parts) >= 4:
                idx = []
                for token in parts[1:]:
                    raw = token.split("/")[0]
                    if not raw:
                        continue
                    i = int(raw)
                    idx.append(i - 1 if i > 0 else len(verts) + i)
                for k in range(1, len(idx) - 1):
                    tris.append((idx[0], idx[k], idx[k + 1]))

    out = bytearray()
    out += b"obj2stl (rt911)".ljust(80, b"\0")
    out += struct.pack("<I", len(tris))
    for a, b, c in tris:
        va, vb, vc = verts[a], verts[b], verts[c]
        ux, uy, uz = (vb[0] - va[0], vb[1] - va[1], vb[2] - va[2])
        wx, wy, wz = (vc[0] - va[0], vc[1] - va[1], vc[2] - va[2])
        nx, ny, nz = uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx
        nlen = (nx * nx + ny * ny + nz * nz) ** 0.5 or 1.0
        out += struct.pack(
            "<12fH",
            nx / nlen, ny / nlen, nz / nlen,
            *va, *vb, *vc,
            0,
        )
    with open(dst, "wb") as fh:
        fh.write(out)
    print(f"{dst}: {len(verts)} verts, {len(tris)} triangles, {len(out)} bytes")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
