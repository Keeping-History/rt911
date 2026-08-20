# Weather App — Design Spec

**Date:** 2026-07-10
**Issue:** [Keeping-History/rt911#184](https://github.com/Keeping-History/rt911/issues/184) — "Add weather radar app and forecasts/almanac data"
**Status:** Approved (design review 2026-07-10)

## Summary

A new Classicy desktop app, **Weather**, that replays real North American weather for
September 9–12, 2001 in sync with the shared virtual clock: hourly surface conditions
for ~150–250 US/Canada/Mexico stations, the actual NEXRAD CONUS radar mosaic as a map
overlay, archived NWS forecast text, and per-station almanac data (normals and records
as they stood in September 2001).

V1 scope is **everything including radar** (decided in design review). The main window
is a **map + city panel**: a North America map with the radar mosaic and station pins,
plus a side panel showing the selected station's conditions, forecast, and almanac.
Conditions are delivered over a new **`weather` streamer channel** (flights-style
opt-in subscription); radar and almanac need no backend at all.

## Data sources

All sources are real archived data, free, and cover 2001-09-09 → 2001-09-12:

| Data | Source | Coverage | Notes |
|---|---|---|---|
| Hourly conditions | NOAA ISD global-hourly / IEM ASOS archive (METAR) | US + CA + MX, curated ~150–250 stations | temp, dewpoint, wind, pressure, sky, visibility, present weather |
| Radar | IEM archived NEXRAD composites — `mesonet.agron.iastate.edu/archive/data/YYYY/MM/DD/GIS/uscomp/` | CONUS only | Pre-rendered 5-min mosaic PNGs + world files (~288/day, ~1,150 total). Canada/Mexico had no public composite in 2001 — CONUS-only radar is accepted scope. |
| Forecasts | IEM AFOS NWS text-product archive — Zone Forecast Products (ZFP), Area Forecast Discussions | US only | Stations map to NWS zones. CA/MX stations show conditions + almanac only. |
| Almanac | GHCN-Daily | US + CA + MX | Normal and record high/low **computed from data ≤ 2001-09 only** — no anachronistic records. |

Hurricane Erin sits off the US East Coast on 9/11 and will be visible in the mosaic.

## Anachronism rule

Nothing displayed may reflect knowledge after the virtual clock. Almanac records are
computed as of September 2001; forecast text is shown only once its archived issuance
time has passed; observations reveal-gate on their observation time like every other
channel.

## Architecture

### Pipeline — new `packages/tools/weather-recon`

Follows the `flight-recon` pattern (Prefect flows on the k8s work pool → Directus/
Postgres + Wasabi):

- `load-stations` — curated station list → `weather_stations` (station_id, name,
  lat, lon, country, tz, nws_zone, ghcn_id).
- `load-observations` — METAR/ISD fetch, unit normalization → `weather_observations`
  (station_id, observed_at UTC, temp_c, dewpoint_c, wind_dir_deg, wind_speed_kt,
  pressure_hpa, sky_condition, present_weather, visibility_km).
- `load-radar` — IEM composite PNGs, timestamp-normalized filenames → Wasabi
  `weather/radar/<YYYYMMDDHHMM>.png` (5-min buckets), plus one metadata JSON with
  the mosaic's corner coordinates (from the world file) for the MapLibre image source.
- `load-forecasts` — ZFP/AFD text per zone → `weather_forecasts` (zone, product_type,
  issued_at UTC, raw_text).
- `load-almanac` — GHCN-Daily aggregation → static JSON per station on Wasabi
  `weather/almanac/<station_id>.json` (per-day normal/record hi-lo with record years).

Directus gotcha to respect: JSON-typed fields need the `cast-json` special; schema-op
bursts can wedge introspection (restart rt911-api if so).

### Backend — `weather` streamer channel

Flights-style opt-in side channel (`subscribe`/`unsubscribe`), per
`packages/backend/CLAUDE.md` "Add a new subscription channel":

- `WeatherObservation` model; msgpack Redis **hour buckets** (single HASH
  `weather:hours` keyed by hour — obs are hourly, minute buckets are overkill).
- **No NOTIFY listener** — data is immutable bulk pipeline output (same rationale as
  flights). Rewarm = `redis-cli DEL weather:hours` + streamer restart.
- On subscribe and on seek: **snapshot of the most recent observation per station**
  with a 2-hour lookback, so "current conditions" populate instantly at any clock
  position; then forward windowed delivery on the tick.
- Forecast texts ride the same channel as a distinct frame type, delivered when
  `issued_at` enters the window (plus a latest-per-zone snapshot on subscribe);
  the client keeps latest-per-zone.
- Non-fatal wiring in `cmd/server/main.go` (a side channel must never take down media
  streaming). Update `docs/websocket-protocol.md` in the same PR as the frontend
  consumer.

Radar and almanac deliberately bypass the streamer: radar frame URLs are computed
client-side from the virtual clock (TV-thumbnails pattern — floor to the 5-min bucket
→ Wasabi URL, prefetch the next frame); almanac is a one-time static JSON fetch per
selected station.

### Frontend — `src/Applications/Weather/`

Standard `ClassicyApp` + `ClassicyWindow` registration in `app.tsx`, namespaced
reducer actions (`ClassicyAppWeather*`), `quitMenuItemHelper`, co-located tests.

- **Map:** reuse FlightTracker's PMTiles basemap style + `pmtiles://` protocol
  registration. Radar as a MapLibre `image` source positioned by the mosaic corner
  metadata; the source URL swaps as the clock crosses 5-min buckets.
- **Station pins:** GeoJSON source from `weather_stations`, styled by current
  temperature; click selects a station.
- **Side panel:** selected station's current conditions (latest obs ≤ clock),
  forecast text (latest ZFP ≤ clock for its zone; hidden for CA/MX), almanac
  (normal/record for the current virtual date).
- **Radar loop control:** replays the trailing hour of frames on an app-local loop
  clock (Flight Tracker loop-mode pattern, PR #173) — never mutates the shared clock.
- **Subscription:** new ref-counted `subscribeWeather`/`unsubscribeWeather` pair in
  `MediaStreamProvider.tsx`; all wire-time comparisons go through `virtualUtcMs`.

## Error handling

- Radar frame 404 (gaps exist in the 2001 archive): keep the last good frame, retry
  the next bucket; never blank the overlay on a single miss.
- Streamer channel failure is non-fatal server-side; client-side the app renders the
  map with pins greyed and a "no data" panel state.
- Stations with missing obs at a given hour show the most recent obs with its
  observation time labeled ("as of 8:51 AM").

## Testing

- Pipeline: pytest per flow (unit normalization, anachronism cutoff on almanac,
  radar filename/timestamp mapping).
- Backend: Go table tests mirroring flights (bucket read/write, snapshot lookback,
  subscribe/unsubscribe, seek).
- Frontend: vitest co-located tests (radar bucket URL math, reveal gating via
  `virtualUtcMs`, latest-per-zone forecast reduction, panel rendering); Playwright
  e2e for open-app → pins render → select station → panel populates.

## Phases

1. **Stations + schema** — curate station list; create Directus collections
   (`weather_stations`, `weather_observations`, `weather_forecasts`).
2. **Pipeline** — `weather-recon` flows; all four datasets loaded and verified in
   Directus/Wasabi.
3. **Backend channel** — `weather` subscription channel, Redis warm, protocol doc.
4. **Frontend app** — map + radar overlay + station panel + loop control + tests.
5. **Polish** — almanac panel, radar prefetch tuning, CA/MX coverage validation,
   app icon, desktop registration.

Each phase lands on `main` independently; deployment is GitOps (ArgoCD) as usual.
