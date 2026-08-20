#!/usr/bin/env python3
"""Render every STL in this directory to an inline-SVG contact sheet.

Pure stdlib: parses binary + ASCII STL, projects an isometric three-quarter
view, painter-sorts triangles, flat-shades with a fixed light, and writes
preview.html alongside the models. Run: python3 preview.py
"""
import json
import math
import struct
import sys
from pathlib import Path

HERE = Path(__file__).parent


def parse_stl(path: Path):
    data = path.read_bytes()
    tris = []
    if len(data) >= 84:
        (count,) = struct.unpack_from("<I", data, 80)
        if len(data) == 84 + 50 * count and not data[:5].lower().startswith(b"solid"):
            binary = True
        elif len(data) == 84 + 50 * count:
            binary = True  # some binary files start with "solid" anyway
        else:
            binary = False
        if binary:
            off = 84
            for _ in range(count):
                v = struct.unpack_from("<12f", data, off)
                tris.append(((v[3], v[4], v[5]), (v[6], v[7], v[8]), (v[9], v[10], v[11])))
                off += 50
            return tris
    # ASCII fallback
    verts = []
    for line in data.decode("ascii", "ignore").splitlines():
        line = line.strip()
        if line.startswith("vertex"):
            _, x, y, z = line.split()[:4]
            verts.append((float(x), float(y), float(z)))
            if len(verts) == 3:
                tris.append(tuple(verts))
                verts = []
    return tris


MAX_PREVIEW_TRIS = 8_000


def render_svg(tris, size=340):
    if len(tris) > MAX_PREVIEW_TRIS:  # keep the SVG browser-friendly
        stride = len(tris) // MAX_PREVIEW_TRIS + 1
        tris = tris[::stride]
    # Normalize into a unit box centered at origin.
    xs = [v[i] for t in tris for v in t for i in (0,)]
    ys = [v[1] for t in tris for v in t]
    zs = [v[2] for t in tris for v in t]
    cx, cy, cz = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, (min(zs) + max(zs)) / 2
    scale = 1.8 / max(max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs), 1e-9)

    # Isometric-ish: yaw 35°, tilt 60° from vertical.
    ca, sa = math.cos(math.radians(35)), math.sin(math.radians(35))
    cb, sb = math.cos(math.radians(55)), math.sin(math.radians(55))
    lx, ly, lz = 0.4, -0.5, 0.77  # light

    polys = []
    for a, b, c in tris:
        pts2, depth = [], 0.0
        # face normal for shading
        ux, uy, uz = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
        vx, vy, vz = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
        nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        nlen = math.sqrt(nx * nx + ny * ny + nz * nz) or 1e-9
        shade = max((nx * lx + ny * ly + nz * lz) / nlen, 0)
        lum = int(70 + 150 * shade)
        for x, y, z in (a, b, c):
            x, y, z = (x - cx) * scale, (y - cy) * scale, (z - cz) * scale
            # yaw about z, then tilt about x
            x, y = x * ca - y * sa, x * sa + y * ca
            y, z = y * cb - z * sb, y * sb + z * cb
            pts2.append((size / 2 + x * size / 2.4, size / 2 - z * size / 2.4))
            depth += y
        polys.append((depth / 3, pts2, lum))
    polys.sort(key=lambda p: -p[0])  # far first
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
        f'style="background:#f2efe6">'
    ]
    for _, pts, lum in polys:
        d = " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)
        parts.append(f'<polygon points="{d}" fill="rgb({lum},{lum},{lum + 8})"/>')
    parts.append("</svg>")
    return "".join(parts)


def main():
    manifests = {}
    for mf in HERE.glob("manifest-*.jsonl"):
        for line in mf.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
                manifests[row.get("file", "")] = row
            except json.JSONDecodeError:
                pass

    cards = []
    for stl in sorted(HERE.glob("*.stl")):
        try:
            tris = parse_stl(stl)
        except Exception as exc:  # noqa: BLE001
            print(f"SKIP {stl.name}: {exc}", file=sys.stderr)
            continue
        if not tris:
            print(f"SKIP {stl.name}: no triangles", file=sys.stderr)
            continue
        meta = manifests.get(stl.name, {})
        cards.append(
            '<div class="card">'
            + render_svg(tris)
            + f"<h3>{stl.name}</h3>"
            + f"<p>{len(tris):,} triangles · {stl.stat().st_size // 1024} KB</p>"
            + f"<p><b>{meta.get('model', '?')}</b> — {meta.get('license', 'license unknown')} "
            + f"by {meta.get('author', '?')}</p>"
            + (
                f'<p><a href="{meta.get("source_page", "#")}">source</a></p>'
                if meta.get("source_page")
                else ""
            )
            + "</div>"
        )
    html = (
        "<!doctype html><meta charset='utf-8'><title>STL candidates</title>"
        "<style>body{font:14px sans-serif;display:flex;flex-wrap:wrap;gap:16px;"
        "padding:16px;background:#fff}.card{border:1px solid #ccc;padding:10px;"
        "width:360px}h3{margin:6px 0 2px}p{margin:2px 0;color:#444}</style>"
        + "".join(cards)
    )
    out = HERE / "preview.html"
    out.write_text(html)
    print(f"wrote {out} with {len(cards)} model(s)")


if __name__ == "__main__":
    main()
