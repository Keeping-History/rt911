#!/usr/bin/env python3
"""Convert an AC3D (.ac) model — FlightGear's native format — to binary STL.

Handles the OBJECT tree with per-object `loc` translation and `rot` 3x3
matrix, fan-triangulates polygon SURFs (flag & 0xF == 0), skips line SURFs.

Usage: python3 ac2stl.py in.ac out.stl
"""
import math
import re
import struct
import sys

# FlightGear exteriors carry non-airframe helpers (landing-light cones, strobe
# billboards, shadows) that dwarf the aircraft when meshed. Skip them by name.
SKIP_NAME = re.compile(
	r"light|beam|beacon|strobe|glow|shadow|halo|flame|cone|lamp|flash", re.IGNORECASE
)


def tokenize(path: str):
    with open(path, encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            yield line.strip()


def mat_vec(m, v):
    return (
        m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
        m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
        m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    )


IDENT = (1, 0, 0, 0, 1, 0, 0, 0, 1)


def parse_object(lines, tris, parent_rot, parent_loc):
    rot = IDENT
    loc = (0.0, 0.0, 0.0)
    verts = []
    skip = False
    while True:
        try:
            line = next(lines)
        except StopIteration:
            return
        parts = line.split()
        if not parts:
            continue
        key = parts[0]
        if key == "name":
            skip = bool(SKIP_NAME.search(line))
        elif key == "loc":
            loc = (float(parts[1]), float(parts[2]), float(parts[3]))
        elif key == "rot":
            rot = tuple(float(x) for x in parts[1:10])
        elif key == "numvert":
            n = int(parts[1])
            for _ in range(n):
                x, y, z = (float(t) for t in next(lines).split()[:3])
                # compose with parent: world = pRot*(rot*v + loc) + pLoc
                v = mat_vec(rot, (x, y, z))
                v = (v[0] + loc[0], v[1] + loc[1], v[2] + loc[2])
                v = mat_vec(parent_rot, v)
                verts.append((v[0] + parent_loc[0], v[1] + parent_loc[1], v[2] + parent_loc[2]))
        elif key == "SURF":
            flags = int(parts[1], 16)
            refs = []
            while True:
                sub = next(lines).split()
                if sub[0] == "mat":
                    continue
                if sub[0] == "refs":
                    k = int(sub[1])
                    for _ in range(k):
                        refs.append(int(next(lines).split()[0]))
                    break
            if not skip and (flags & 0xF) == 0 and len(refs) >= 3:
                for i in range(1, len(refs) - 1):
                    try:
                        tris.append((verts[refs[0]], verts[refs[i]], verts[refs[i + 1]]))
                    except IndexError:
                        pass
        elif key == "kids":
            n = int(parts[1])
            # children inherit this object's composed transform
            crot = tuple(
                parent_rot[r * 3 + 0] * rot[0 + c]
                + parent_rot[r * 3 + 1] * rot[3 + c]
                + parent_rot[r * 3 + 2] * rot[6 + c]
                for r in range(3)
                for c in range(3)
            )
            cloc = mat_vec(parent_rot, loc)
            cloc = (
                cloc[0] + parent_loc[0],
                cloc[1] + parent_loc[1],
                cloc[2] + parent_loc[2],
            )
            for _ in range(n):
                # each kid starts with its own "OBJECT ..." line
                while True:
                    lead = next(lines)
                    if lead.split() and lead.split()[0] == "OBJECT":
                        break
                parse_object(lines, tris, crot, cloc)
            return  # object ends after its kids block


def main(src: str, dst: str) -> None:
    lines = tokenize(src)
    header = next(lines)
    assert header.startswith("AC3D"), f"not an AC3D file: {header!r}"
    tris = []
    for line in lines:
        if line.split() and line.split()[0] == "OBJECT":
            parse_object(lines, tris, IDENT, (0.0, 0.0, 0.0))
    # Geometric backstop for helpers the name filter missed: drop triangles
    # whose vertices sit far outside the 98th-percentile radius of the model.
    if tris:
        cx = sorted(v[0] for t in tris for v in t)[len(tris) * 3 // 2]
        cy = sorted(v[1] for t in tris for v in t)[len(tris) * 3 // 2]
        cz = sorted(v[2] for t in tris for v in t)[len(tris) * 3 // 2]
        radii = sorted(
            math.dist((cx, cy, cz), v) for t in tris for v in t
        )
        limit = radii[int(len(radii) * 0.98)] * 1.5
        before = len(tris)
        tris = [
            t for t in tris if all(math.dist((cx, cy, cz), v) <= limit for v in t)
        ]
        if len(tris) != before:
            print(f"outlier guard dropped {before - len(tris)} triangles")
    out = bytearray()
    out += b"ac2stl (rt911)".ljust(80, b"\0")
    out += struct.pack("<I", len(tris))
    for a, b, c in tris:
        ux, uy, uz = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
        wx, wy, wz = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
        nx, ny, nz = uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx
        nlen = (nx * nx + ny * ny + nz * nz) ** 0.5 or 1.0
        out += struct.pack("<12fH", nx / nlen, ny / nlen, nz / nlen, *a, *b, *c, 0)
    with open(dst, "wb") as fh:
        fh.write(out)
    print(f"{dst}: {len(tris)} triangles, {len(out)} bytes")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
