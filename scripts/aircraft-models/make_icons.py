#!/usr/bin/env python3
"""Top-down silhouette SVG icons from NORMALIZED family STLs (the processed
maps/aircraft/<family>.stl assets: nose -> +Y, fin -> +Z), for the 2D map
mode. Each icon is one simplified <path> (~1-3 KB) with no fill of its own
(the frontend's colorizeSvg injects the pin color on the root <svg>), nose
pointing RIGHT to match plane.svg's east-facing convention (the symbol
layers all rotate by heading - 90).

Requires shapely (union + simplify). Writes <dir>/icons/<name>.svg plus an
icons.html contact sheet next to them.

Run: python3 make_icons.py processed
"""
import sys
from pathlib import Path

from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import unary_union

from preview import parse_stl  # reuse the STL parser

SIZE = 256


def silhouette_svg(tris, size=SIZE):
    # Normalized models: drop Z for the top-down view. svg x = model y puts
    # the nose (+Y) at +x (right); svg y = model x is lateral (symmetric, so
    # the mirror direction is irrelevant).
    polys = []
    for t in tris:
        p = Polygon([(v[1], v[0]) for v in t])
        if p.area > 1e-12:
            polys.append(p if p.is_valid else p.buffer(0))
    merged = unary_union(polys)
    minx, miny, maxx, maxy = merged.bounds
    span = max(maxx - minx, maxy - miny)
    # Morphological close seals hairline gaps between decimated triangles,
    # then simplify collapses the triangle-soup boundary to a clean outline.
    merged = merged.buffer(span * 0.01).buffer(-span * 0.01)
    merged = merged.simplify(span * 0.004)
    minx, miny, maxx, maxy = merged.bounds
    span = max(maxx - minx, maxy - miny)
    cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
    scale = (size * 0.92) / span

    def ring(coords):
        pts = [
            f"{size / 2 + (x - cx) * scale:.1f} {size / 2 - (y - cy) * scale:.1f}"
            for x, y in coords
        ]
        return "M" + "L".join(pts) + "Z"

    geoms = merged.geoms if isinstance(merged, MultiPolygon) else [merged]
    d = "".join(
        ring(g.exterior.coords) + "".join(ring(i.coords) for i in g.interiors)
        for g in geoms
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
        f'viewBox="0 0 {size} {size}"><path fill-rule="evenodd" d="{d}"/></svg>'
    )


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent
    out = src / "icons"
    out.mkdir(exist_ok=True)
    cards = []
    for stl in sorted(src.glob("*.stl")):
        try:
            tris = parse_stl(stl)
        except Exception as exc:  # noqa: BLE001
            print(f"SKIP {stl.name}: {exc}", file=sys.stderr)
            continue
        if not tris:
            continue
        svg = silhouette_svg(tris)
        dest = out / (stl.stem + ".svg")
        dest.write_text(svg)
        cards.append(
            f'<div class="card"><img src="icons/{dest.name}" width="180" height="180">'
            f"<p>{dest.name}</p></div>"
        )
        print(f"{dest.name}: {dest.stat().st_size} bytes")
    (src / "icons.html").write_text(
        "<!doctype html><meta charset='utf-8'><title>Top-down icons</title>"
        "<style>body{font:13px sans-serif;display:flex;flex-wrap:wrap;gap:12px;"
        "padding:12px}.card{border:1px solid #ccc;padding:6px;text-align:center}"
        "img{background:#f5f2ea}</style>" + "".join(cards)
    )
    print(f"wrote icons.html with {len(cards)} icons")


if __name__ == "__main__":
    main()
