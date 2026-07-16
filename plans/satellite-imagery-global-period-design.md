# Global, period-correct satellite imagery — design

**Date:** 2026-07-16
**Status:** Approved (brainstorming session with Robbie)
**Scope:** Offline data pipeline + Wasabi uploads. Frontend change is limited to dropping the NA `bounds` hint. Independent of the terrain spec ([flight-map-3d-terrain-design.md](2026-07-16-flight-map-3d-terrain-design.md)); ships whenever ready.

## Goal

Upgrade the satellite basemap from NA-only, sharp-to-z6 archives to **global, period-correct imagery, sharp to z12 over North America**, keeping the day/night pair. Improves both the satellite style and the look of 3D terrain draped with imagery.

The current archives are already the right *sources* — 2001-vintage NASA Blue Marble (day) and City Lights (night), built per `scripts/build-satellite-basemap.md` — just cropped to the NA bbox at low zoom. This project extends extent and depth; it does not change the aesthetic.

## Requirements (from brainstorming)

1. **Global coverage** — globe mode and world panning never hit an imagery cliff.
2. **Deeper zoom over NA** — sharp to z12 where the flights are (airports, crash sites).
3. **Day + night variants preserved.**
4. **Period-appropriate** — every source dates 1999–2001.

## Sources — all public domain, all period-correct

| Layer | Source | Vintage | Resolution | Zoom range |
|---|---|---|---|---|
| Day, global | **Original NASA Blue Marble** (2002 release) | land surface composited from Terra MODIS, **June–Sept 2001** — contemporaneous with the replayed event | 1 km/px | z0–6/7 |
| Day, NA detail | **Landsat GLS-2000 / GeoCover** mosaics (USGS) | circa 1999–2001 | ~15 m pan-sharpened | z7–12, NA bbox |
| Night, global | **NASA City Lights / DMSP-OLS** nighttime lights | 2001 epoch | coarse (~1–2.7 km) | z0–6/7 |

Notes:
- Blue Marble *Next Generation* (2005 release, 2004 data, 500 m) is explicitly **rejected**: one zoom level of sharpness is not worth losing the 2001 vintage.
- GLS-2000 is a global survey; if the day mosaic's z6→z7 seam (1 km MODIS → 15 m Landsat) proves visually harsh, downsampled GLS-2000 may replace Blue Marble at mid zooms over NA. Decide from rendered output, not up front.
- Night stays coarse — 2001 night-lights data simply is; deep night zooms over NA can reuse the global layer's maxzoom (no fabricated detail).

## Deliverables

1. **`world-satellite-day.pmtiles`** — global z0–6/7 Blue Marble + NA-bbox z7–12 GLS-2000, one archive (PMTiles handles sparse deep zooms over a sub-bbox; deep tiles exist only inside NA).
2. **`world-satellite-night.pmtiles`** — global City Lights, native-resolution maxzoom.
3. **Pipeline docs/scripts** — extend `scripts/build-satellite-basemap.md` (or successor doc) with the full recipe: source acquisition (USGS EarthExplorer / NASA Visible Earth), reprojection to web mercator, color-balancing the Landsat mosaic seams, tiling (`rio-mbtiles`/`gdal2tiles` → `pmtiles convert`), upload. The heavy lift is **color-balancing GLS-2000 scenes**; the doc must record chosen parameters so the archive is reproducible.
4. **Frontend follow-up (tiny):** point `BASEMAP_URLS.satelliteDay/Night` at the new archives (or upload under the existing names), remove the `bounds: NA_BBOX` hints from the two raster sources, and re-verify the "flash-of-background before tiles" palette entries still make sense with global coverage. The frontend already reads native `maxzoom` from TileJSON, so deeper tiles need no code.

## Rollback / hosting

- Upload under **new names**, keep `na-satellite-*.pmtiles` as rollback (the pattern used for `world-basemap.pmtiles` vs `na-basemap.pmtiles`).
- Size guardrail: global z7 raster ≈ tens of thousands of tiles (fine); NA z8–12 imagery is the bulk — estimate before upload; if the day archive exceeds a few tens of GB, drop NA maxzoom to 11.

## Testing / acceptance

- Globe view: imagery covers the full sphere day and night; no NA cliff.
- Zoom over JFK/DCA/Denver: imagery stays sharp to z12 (day).
- Style switching and dark-mode behavior unchanged (superset-style contract untouched).
- Attribution strings updated (NASA Visible Earth + USGS).
