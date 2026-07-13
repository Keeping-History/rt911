# Satellite basemaps (na-satellite-day / na-satellite-night .pmtiles)

One-time raster basemaps for the Flight Tracker and Weather apps' Satellite
display mode. Period-correct NASA imagery: the day layer is the original Blue
Marble (MODIS data collected 2001, released 2002); the night layer is
"Earth's City Lights" (DMSP-OLS composite, released 2000). Both are public
domain (NASA Visible Earth).

## Contract with the app

`packages/frontend/src/lib/basemap/basemapStyles.ts` consumes each archive as
a `raster` source: 256px tiles, **maxzoom 7**, bounds `-150,18,-65,65` (the
same NA bbox as the vector basemap). MapLibre overzooms past z7 and never
requests outside the bbox, so the archives stay small and 404s are never hit.

## Sources

Download from NASA Visible Earth (verify the record pages for current links):
- Day: "The Blue Marble: Land Surface, Shallow Water, and Shaded Topography"
  — `land_shallow_topo_21600.tif` (21600×10800, ~1.8 km/px), visibleearth
  record 57752.
- Night: "Earth's City Lights" — largest published GeoTIFF/PNG
  (`land_lights_16384.tif`, 16384×8192), visibleearth record 55167.

Both are plain global plate-carrée images with no embedded georeferencing.

## Build (GDAL ≥ 3.4 + pmtiles CLI; run once per source)

For SRC=land_shallow_topo_21600.tif / OUT=na-satellite-day, then
SRC=land_lights_16384.tif / OUT=na-satellite-night:

1. Georeference (global plate-carrée → EPSG:4326):
   gdal_translate -a_srs EPSG:4326 -a_ullr -180 90 180 -90 $SRC $OUT-4326.tif
2. Reproject to WebMercator, clipped to the NA bbox:
   gdalwarp -t_srs EPSG:3857 -te -150 18 -65 65 -te_srs EPSG:4326 \
     -r bilinear -multi $OUT-4326.tif $OUT-3857.tif
3. Tile to MBTiles (JPEG) and build the lower zooms:
   gdal_translate -of MBTILES -co TILE_FORMAT=JPEG -co QUALITY=85 \
     $OUT-3857.tif $OUT.mbtiles
   gdaladdo -r average $OUT.mbtiles 2 4 8 16 32 64
4. Convert:
   pmtiles convert $OUT.mbtiles $OUT.pmtiles
5. Sanity checks before uploading:
   - `pmtiles show $OUT.pmtiles` reports maxzoom ≤ 7 (if the native zoom came
     out at 8, re-run gdal_translate with `-outsize 50% 50%` on the 3857 tif —
     the app never requests past z7 either way) and bounds ≈ the NA bbox.
   - Open in https://pmtiles.io — North America renders, oceans/edges look sane.

Expected sizes: ~15–40 MB each.

## Host (GATED — prod Wasabi) 

1. Upload both to the file-proxy's Wasabi bucket under `maps/`, alongside
   `na-basemap.pmtiles`. Use the video-grabber Wasabi creds with boto3
   `request_checksum_calculation="when_required"` (Wasabi rejects boto3
   ≥ 1.36's default checksum header — see video-grabber's `storage/wasabi.py`).
2. No infra change expected: the `/maps` Ingress path on
   files.911realtime.org is prefix-based (verified 2026-07-13). If a fresh
   URL somehow 404s at Traefik rather than the S3 gateway, add the path to
   the allow-list in `apps/file-proxy/ingress.yaml` in
   github.com/keeping-history/infra and let ArgoCD sync.
3. Verify both:
   curl -I -H 'Range: bytes=0-16' https://files.911realtime.org/maps/na-satellite-day.pmtiles
   curl -I -H 'Range: bytes=0-16' https://files.911realtime.org/maps/na-satellite-night.pmtiles
   → `206 Partial Content`.
