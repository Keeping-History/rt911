# Flight Tracker — per-phase track coloring for the 4 hijacked flights

**Issue:** [#229](https://github.com/Keeping-History/rt911/issues/229) (parent: #264 Flight Tracker)
**Date:** 2026-07-22
**Status:** Design — approved boundary/ordering/palette/scope decisions, pending spec review

## Goal

The Flight Tracker's rendered track for the four hijacked flights — **AA11, UA175, AA77, UA93** — should change **color** along its length to mark the flight phases and onboard/ATC events, so a viewer can read the story of each flight from the map alone. Both the flat 2D track line and the 3D flyover tube are colored.

Non-hijacked flights are unaffected: their selected track keeps today's single flat color.

## Phase taxonomy

The issue lists nine phases. **Taxi folds into Takeoff** — the curated radar/FDR waypoints begin at wheels-off, so there is no ground track to color. That leaves **eight** rendered phases:

| Phase | Meaning | Color | Hex |
|---|---|---|---|
| Takeoff | Tower — wheels-off through initial climb | green | `#2e7d32` |
| TRACON | Departure control (terminal radar) | teal | `#0097a7` |
| ARTCC | En-route Center(s) cruise | blue | `#1565c0` |
| Hijack | Onboard takeover | amber | `#f9a825` |
| Course Change | Unauthorized deviation from filed route | orange | `#ef6c00` |
| ATC Alert | Controllers recognized/declared the hijack | red-orange | `#d84315` |
| Descent | Final descent toward the target | red | `#c62828` |
| Down | Impact | maroon | `#7f0000` |

The palette is an **escalation ramp**: calm green→teal→blue for normal operations, warming through amber/orange to red/maroon as the crisis escalates. It is centralized in one `PHASE_COLORS` map so hexes are trivial to retune.

### Two design rules that govern the coloring

1. **Snap to nearest real track point — no synthetic vertices.** Each per-minute track sample is assigned the phase whose curated time-interval contains its timestamp. Where two events fall within a minute of each other (e.g. AA11 Hijack 8:14 / Course Change 8:21 / ATC Alert 8:24), the shorter phase simply claims fewer samples and renders as a short segment. Colors always sit on real data.
2. **Order phases by actual event time per flight, not the issue's list order.** Each phase is a time interval; the color sequence follows the real chronology. This only diverges from the issue's list for **UA93**, where controllers recognized the hijack (ATC Alert ~9:32) *before* the plane turned back toward Washington (Course Change ~9:36).

## Confirmed timeline (all times EDT)

Curated from the sources below. These become the per-flight phase-boundary data.

### AA11 — Boston Logan → North Tower
| Phase | Boundary time | Facility / event |
|---|---|---|
| Takeoff | 7:59–8:00 | Boston Logan |
| TRACON | ~8:00 | Boston TRACON (A90) departure |
| ARTCC | 8:09 | Boston Center (ZBW) |
| Hijack | ~8:14 | no response after last ack (8:13) |
| Course Change | 8:21 | turns NW, transponder off |
| ATC Alert | 8:24:38 | hijacker transmission — controller recognizes hijack |
| Descent | ~8:44 | final descent into Manhattan |
| Down | 8:46:40 | North Tower |

### UA175 — Boston Logan → South Tower
| Phase | Boundary time | Facility / event |
|---|---|---|
| Takeoff | 8:14 | Boston Logan, rwy 9 |
| TRACON | ~8:14 | Boston departure |
| ARTCC | 8:19 | Boston Center; **8:40** re-handed to New York Center (ZNY) |
| Hijack | ~8:42–8:46 | last normal contact 8:42 |
| Course Change | 8:47 | transponder code changes (1470→3020→3321) |
| ATC Alert | 8:53–8:55 | controller alarmed; ~8:55 notifies manager |
| Descent | ~9:02 | rapid descent over lower Manhattan |
| Down | 9:03:02–9:03:11 | South Tower |

### AA77 — Washington Dulles → Pentagon
| Phase | Boundary time | Facility / event |
|---|---|---|
| Takeoff | 8:20 | Dulles (IAD) |
| TRACON | ~8:20 | Washington/Dulles departure |
| ARTCC | 8:40 | Indianapolis Center (ZID) |
| Hijack | ~8:51–8:54 | last transmission 8:51 |
| Course Change | 8:54 | unauthorized left turn south |
| ATC Alert | 8:56 | transponder off, drops off ZID radar; reappears as primary at 9:05 |
| Descent | ~9:34 | after 9:32 Dulles TRACON reacquires eastbound primary |
| Down | 9:37:46 | Pentagon |

### UA93 — Newark → Shanksville, PA
| Phase | Boundary time | Facility / event |
|---|---|---|
| Takeoff | 8:42 | Newark (EWR) |
| TRACON | ~8:42 | Newark departure → New York Center en route |
| ARTCC | 9:23 | Cleveland Center (ZOB) |
| Hijack | 9:28 | screaming/struggle; last routine call 9:25 |
| ATC Alert | 9:32 | "we have a bomb on board" heard by Cleveland Center |
| Course Change | ~9:36 | turns back east toward Washington |
| Descent | ~9:58–10:00 | final dive during passenger revolt |
| Down | 10:03:11 | Shanksville |

### Sources
- [9/11 Commission Report (full PDF)](https://9-11commission.gov/report/911Report.pdf) — Ch. 1, "We Have Some Planes"
- Rutgers Law Review, *A New Type of War* (FAA/NORAD staff monograph): [American 11](https://rutgerslawreview.com/4-american-11/) · [United 175](https://rutgerslawreview.com/5-united-175/) · [American 77](https://rutgerslawreview.com/6-american-77/) · [United 93](https://rutgerslawreview.com/8-united-93/)
- [NTSB Flight Path Studies (National Security Archive, EBB #196)](https://nsarchive2.gwu.edu/NSAEBB/NSAEBB196/)
- NPR event timelines: [AA11](https://www.npr.org/2004/06/17/1962281/timeline-for-american-airlines-flight-11) · [UA175](https://www.npr.org/2004/06/17/1962517/timeline-for-united-airlines-flight-175)

## Architecture

The existing pipeline already carries a per-position `phase` string end-to-end (`flight_positions.phase` → streamer wire → frontend), but today it is a coarse `climb`/`cruise`/`descent` label derived from altitude trend. This feature enriches that value for the four notable flights with the 8-phase taxonomy and teaches the renderer to color by it. **No wire/schema change** — same field, richer values.

The central structural fact (from codebase recon): the rendered 2D track line comes from `flight_tracks.geometry` (a single decimated `LineString` with **no per-vertex phase or timestamp**), and the 3D tube from an altitude profile — both single-color. Phase lives only on `flight_positions`. So the renderer must join phase onto the drawn geometry. Because the rendered track is fetched from **Directus REST** (`useFlightTrack` / `useAltitudeProfile`), **not** the streamer, this feature needs **no backend/streamer change and no cache rewarm**.

### 1. Curated data — source of truth

Add an ordered `phases` block to each `packages/tools/flight-recon/data/notable_flights/{aa11,aa77,ua175,ua93}.json`, alongside the existing `details` / `impact` / `sources` facts:

```json
"phases": [
  { "phase": "takeoff",       "utc": "2001-09-11T11:59:00Z" },
  { "phase": "tracon",        "utc": "2001-09-11T12:00:00Z" },
  { "phase": "artcc",         "utc": "2001-09-11T12:09:00Z" },
  { "phase": "hijack",        "utc": "2001-09-11T12:14:00Z" },
  { "phase": "course_change", "utc": "2001-09-11T12:21:00Z" },
  { "phase": "atc_alert",     "utc": "2001-09-11T12:24:38Z" },
  { "phase": "descent",       "utc": "2001-09-11T12:44:00Z" },
  { "phase": "down",          "utc": "2001-09-11T12:46:40Z" }
]
```

`utc` values are the confirmed EDT times above converted to UTC (EDT = UTC−4). Each entry marks the **start** of that phase; a sample belongs to the last phase whose `utc` is ≤ the sample's `utc`. The list is authored in real chronological order (so UA93's `atc_alert` precedes `course_change`).

### 2. Pipeline — assign phase to positions

In `packages/tools/flight-recon/flight_recon/notable.py` (`build_flight`), when a `phases` block is present, assign each resampled per-minute `flight_positions` row its phase by interval lookup against that block, **overriding** the coarse altitude-trend phase from `resample.py:_assign_phases`. Non-notable flights and any notable flight lacking a `phases` block keep the existing `climb`/`cruise`/`descent` behavior untouched.

Re-running the loader is **scoped** — `notable.py` already does an idempotent delete/rewrite of only the five notable flight IDs, so this is not a full-pipeline rerun. After the run, the enriched `phase` is immediately live via Directus REST (no streamer rewarm).

### 3. Rendering — 2D line + 3D tube

Frontend, `packages/frontend/src/Applications/FlightTracker/`:

- **Phase → color map + expression.** Add a `PHASE_COLORS` map and a data-driven `line-color` expression to `flightMapStyle.ts`, following the existing `highlightTrailColor` `case`-expression pattern. Colors read acceptably on classic/radar/satellite basemaps and in dark mode; verify contrast during implementation (the escalation ramp is mid-to-high saturation, which the existing trail colors also rely on).
- **Fetch phase.** Add `phase` to the fields `useAltitudeProfile.ts` requests (positions already store it).
- **2D track line.** Build the selected notable flight's track from the phase-tagged positions (which carry `utc` + `phase`), split into per-phase sub-segments, and drive the `track-line` layer's `line-color` by the phase expression instead of the flat `TRACK_LINE_COLOR`. Applies only when the selected flight is in `NOTABLE_FLIGHTS`; otherwise keep today's flat line. (`FlightMap.tsx` `track-line` layer; `FlightTracker.tsx` `trackGeoJSON`.)
- **3D tube.** Extend `trackTube.ts` (`buildTrackTube`) and `trackTubeLayer.ts` to carry **per-vertex color** in the WebGL vertex format (today a single `u_color` uniform), fed from each profile sample's phase. This is the largest single piece of work.

### Scope guard

The colored track is gated to the four hijacked flights via the existing `NOTABLE_FLIGHTS` set. GOFER06 (the C-130 observer) and all reconstructed BTS flights are unaffected.

## Out of scope

- **Streamer live-channel phase enrichment** — the live `flights` channel keeps coarse phase; not needed for the selected-track render.
- **Loop/replay breadcrumb trails and live plane pins** — unchanged.
- **A Taxi segment** — no ground-track data.
- **A textual phase legend / timeline panel** — potential follow-up; this feature is the colored track itself.

## Testing

- **Pipeline unit test** (`flight-recon`): timestamp → phase interval assignment, including the boundary-inclusive rule (`utc` ≤ sample) and the UA93 out-of-list-order case.
- **Frontend unit test**: the segment-builder splits a phase-tagged position list into the correct per-phase sub-segments (contiguous, no gaps, boundary sample assigned to the later phase).
- **Manual/visual**: load each of the four flights in 2D and 3D, confirm the eight-color ramp appears in chronological order and the color breaks land at the sourced event times.

## Files to touch

**Data / pipeline**
- `packages/tools/flight-recon/data/notable_flights/{aa11,aa77,ua175,ua93}.json` — add `phases` block
- `packages/tools/flight-recon/flight_recon/notable.py` — interval-assign phase in `build_flight`

**Frontend**
- `packages/frontend/src/Applications/FlightTracker/flightMapStyle.ts` — `PHASE_COLORS` + phase `line-color` expression
- `packages/frontend/src/Applications/FlightTracker/useAltitudeProfile.ts` — fetch `phase`
- `packages/frontend/src/Applications/FlightTracker/FlightMap.tsx` — phase-driven `track-line` paint; segmented `track` source
- `packages/frontend/src/Applications/FlightTracker/FlightTracker.tsx` — build segmented `trackGeoJSON`
- `packages/frontend/src/Applications/FlightTracker/trackTube.ts` + `trackTubeLayer.ts` — per-vertex tube color

**No change:** backend (Go) — `phase` already rides the wire; the selected track is served over Directus REST.
