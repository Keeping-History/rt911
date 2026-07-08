# Flight Tracker basemap (na-basemap.pmtiles)

A one-time North America vector basemap for the Flight Tracker app. Regenerate
only when the coastline/border data changes.

## Contract with the app
The style (`packages/frontend/src/Applications/FlightTracker/flightMapStyle.ts`)
expects these vector source-layer names: `land`, `countries`, `states`, `lakes`.
Keep tippecanoe's `-l <layer>` names matching, or the basemap renders blank
(planes still show — basemap failure is non-fatal).

## Build (requires tippecanoe + pmtiles CLI)
1. Download Natural Earth 1:50m data: `ne_50m_land`, `ne_50m_admin_0_countries`,
   `ne_50m_admin_1_states_provinces_lines`, `ne_50m_lakes` (GeoJSON).
2. Clip each to the North America bbox `-150,18,-65,65` (ogr2ogr -clipsrc).
3. Build vector tiles, one named layer per file, zoom 0–7:
   `tippecanoe -o na.mbtiles -Z0 -z7 -l land land.geojson -l countries countries.geojson -l states states.geojson -l lakes lakes.geojson --coalesce-densest-as-needed`
4. Convert to PMTiles: `pmtiles convert na.mbtiles na-basemap.pmtiles`
   (expect a few–tens of MB).

## Host (GATED — infra + prod)
1. Upload `na-basemap.pmtiles` to the Wasabi bucket path the file-proxy serves,
   under `maps/na-basemap.pmtiles`.
2. In the `keeping-history/infra` repo, add a Traefik Ingress path rule allowing
   `/maps/` on `files.911realtime.org` (mirror the existing file-proxy allow-list
   entries). The nginx-s3-gateway already supports HTTP Range + CORS for the
   frontend origin. Land on the infra repo's main; ArgoCD syncs.
3. Verify: `curl -I -H 'Range: bytes=0-16' https://files.911realtime.org/maps/na-basemap.pmtiles`
   returns `206 Partial Content`.
