#!/usr/bin/env python3
"""Top-down silhouette SVG icons from every STL in this directory (for the
2D map mode, like plane.svg). Pure stdlib; writes icons/<name>.svg plus an
icons.html contact sheet.

The top-down plane is chosen automatically: the axis with the smallest extent
is treated as "up" (aircraft are flat-ish), and the projection is rotated so
the LONGEST horizontal extent (the fuselage) runs vertically. Nose-up vs
nose-down is NOT auto-detected — models disagree — so orientation gets fixed
by hand at integration time.

Run: python3 make_icons.py
"""
import sys
from pathlib import Path

from preview import MAX_PREVIEW_TRIS, parse_stl  # reuse the STL parser

HERE = Path(__file__).parent
OUT = HERE / "icons"

ICON_TRI_CAP = 120_000  # beyond this, subsample (tiny holes beat 20MB svgs)


def icon_svg(tris, size=256):
    if len(tris) > ICON_TRI_CAP:
        tris = tris[:: len(tris) // ICON_TRI_CAP + 1]
    # Pick the flattest axis as "up" and drop it.
    mins = [min(v[i] for t in tris for v in t) for i in range(3)]
    maxs = [max(v[i] for t in tris for v in t) for i in range(3)]
    extents = [maxs[i] - mins[i] for i in range(3)]
    up = extents.index(min(extents))
    ax, ay = [i for i in range(3) if i != up]
    # Fuselage (longest remaining extent) runs vertically in the icon.
    if extents[ax] > extents[ay]:
        ax, ay = ay, ax
    cx = (mins[ax] + maxs[ax]) / 2
    cy = (mins[ay] + maxs[ay]) / 2
    scale = (size * 0.92) / max(extents[ax], extents[ay], 1e-9)
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
        f'viewBox="0 0 {size} {size}">'
    ]
    for t in tris:
        pts = " ".join(
            f"{size / 2 + (v[ax] - cx) * scale:.1f},{size / 2 - (v[ay] - cy) * scale:.1f}"
            for v in t
        )
        parts.append(f'<polygon points="{pts}"/>')
    parts.append("</svg>")
    return "".join(parts)


def main():
    OUT.mkdir(exist_ok=True)
    cards = []
    for stl in sorted(HERE.glob("*.stl")):
        try:
            tris = parse_stl(stl)
        except Exception as exc:  # noqa: BLE001
            print(f"SKIP {stl.name}: {exc}", file=sys.stderr)
            continue
        if not tris:
            continue
        svg = icon_svg(tris)
        out = OUT / (stl.stem + ".svg")
        out.write_text(svg)
        cards.append(
            f'<div class="card"><img src="icons/{out.name}" width="180" height="180">'
            f"<p>{out.name}</p></div>"
        )
        print(f"{out.name}: {out.stat().st_size // 1024} KB")
    (HERE / "icons.html").write_text(
        "<!doctype html><meta charset='utf-8'><title>Top-down icons</title>"
        "<style>body{font:13px sans-serif;display:flex;flex-wrap:wrap;gap:12px;"
        "padding:12px}.card{border:1px solid #ccc;padding:6px;text-align:center}"
        "img{background:#f5f2ea}</style>" + "".join(cards)
    )
    print(f"wrote icons.html with {len(cards)} icons")


if __name__ == "__main__":
    main()
