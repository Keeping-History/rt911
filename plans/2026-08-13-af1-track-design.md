# Air Force One (AF1) flight track — design

**Date:** 2026-08-13
**Status:** Approved design, pre-implementation
**Related:** `plans/2026-07-29-radar-tracks-load-design.md` (RADES load), issue #229 (phase coloring), notable-flights loader (`flight_recon/notable.py`)

## What

Add Air Force One's complete September 11, 2001 movements to the Flight Tracker as
a sixth curated "notable" aircraft, identified as **AF1** (tail SAM 28000, Boeing
VC-25A), covering:

1. **2001-09-10 evening positioning leg** — Andrews AFB (ADW) → Sarasota-Bradenton
   (SRQ), airborne only. Inside the replay window (09-09 → 09-18), so scrubbing to
   Sept 10 evening shows AF1 flying to Florida.
2. **2001-09-11 continuous coverage** — from ET midnight (04:00Z) parked at SRQ,
   through three airborne legs with ground stops between:
   - SRQ → Barksdale AFB (BAD), ~13:54–15:45Z
   - BAD → Offutt AFB (OFF), ~17:37–18:50Z
   - OFF → ADW, ~20:36–22:54Z
   ending at the Andrews landing. Ground time at SRQ/BAD/OFF is included as
   explicit per-minute rows.

Leg timings above are approximate; exact times are researched during
implementation from published sources (9/11 Commission Report and staff
monographs, FAA/NORAD timelines, standard published accounts) and each anchor is
cited in `provenance_notes`.

## Why

The four hijacked flights and the GOFER06 observer are already curated
(`data/notable_flights/*.json` → `python -m flight_recon.notable`). Air Force
One is the single most historically significant aircraft aloft that day that the
tracker does not show. Like the others it is absent from BTS (military Special
Air Mission, not a scheduled flight).

## Data model

Two new curated JSON files in `packages/tools/flight-recon/data/notable_flights/`,
same schema as the existing five, with these additions:

- **Per-file `flight_date`** — `af1_0910.json` carries `2001-09-10`;
  `af1.json` carries `2001-09-11`. (The loader currently hardcodes
  `FLIGHT_DATE = "2001-09-11"`.) The result is **two `flight_tracks` rows for
  flight `AF1`** on consecutive dates, matching how multi-day BTS flights work;
  the frontend's time-aware `pickLeg` lookup already disambiguates.
- **`phase: "ground"`** rows while parked: apron coordinates, field-elevation
  `alt_ft` (SRQ ~28 ft, BAD ~166 ft, OFF ~1,048 ft), one row per minute so the
  existing per-minute contiguity validator holds unchanged over the whole day.
- **Airborne phases** use the standard `climb`/`cruise`/`descent` slugs — no
  escalation-ramp phases (nothing escalates on AF1's track).
- **Landing support**: `landed_at: "ADW"` + a wheels-on time (every current
  notable ends in a crash or aloft; AF1 actually lands).
- **Per-waypoint `source`**: `'radar'` where taken from RADES returns,
  `'estimated'` for reconstructed stretches and ground time — reusing the splice
  provenance field shipped for the RADES named upgrades (dashes/dims on the map).

Identifier: **AF1** (short, readable at map-label size). Pre-load check confirms
no `AF`-prefixed BTS row exists on either date (Air France IATA collision guard;
BTS is domestic-only so none is expected).

## Radar hunt (leg 1)

Leg 1 (SRQ→BAD, ~13:54–15:45Z) falls inside the SEADS recording window
(11:00–16:00Z) and inside SEADS geographic coverage; legs 2–3 end after all
recordings stop. Before curating leg 1 from anchors:

- Search the decoded corpus (`Radar_Evaluation_Squadron_(RADES)/decoded/`,
  SEADS + relevant southern sites) for a track departing SRQ ~13:54Z climbing
  northwest toward Shreveport, using `segment_rades_exports.py`'s existing
  chain-building. The national ground stop (complete by ~13:25Z) makes such a
  departure near-unique; identity is argued from origin airport + time +
  heading continuity, not beacon code (squawks are reused).
- **If found:** leg 1 waypoints are real per-sweep returns with Mode C altitude
  (`source: 'radar'`), like AA11/AA77.
- **If not found after a bounded search:** documented anchors + great-circle
  interpolation (`source: 'estimated'`), with the failure to locate the track
  stated plainly in `provenance_notes`.

The hunt is best-effort, not a ship gate.

## Loader changes (`flight_recon/notable.py` + `resample.py`)

- Add `"AF1"` to `NOTABLE_FLIGHTS`.
- Accept an optional per-file `flight_date` (default remains `2001-09-11`);
  positions/track rows carry the file's date.
- **Scoped delete becomes per-(flight, flight_date) pair** over the files being
  loaded — still never a bare date-window delete; the BTS sentinel + row-count
  invariants from the original notable design still apply, now on both dates.
- Permit `phase: "ground"` and validate it (alt equals the documented field
  elevation, zero displacement allowed).
- Populate `landed_at` / `wheels_on_utc` from the JSON when present.
- **`resample.py` zero-distance guard:** great-circle interpolation between two
  identical waypoints divides by `sin(0)` — parked stretches need an explicit
  same-point short-circuit (hold position/altitude).
- `clock_seconds` continues to anchor at 2001-09-09 ET midnight (window start),
  which is what makes the 09-10 leg land on the right replay clock.

## Frontend (`packages/frontend/src/Applications/FlightTracker/`)

- **New category, observer styling.** `PRESIDENTIAL_FLIGHTS = ["AF1"]` +
  `isPresidential()` in `notableFlights.ts`; `flightGeoJSON.ts` emits a
  `presidential` property. Rendered with the **existing observer teal**
  (no new settings color pair for now); highlighted, never clustered, none of
  the crash semantics (`isNotable` stays the crashed four). Detail panel gets a
  presidential badge and "Boeing VC-25A (SAM 28000)".
- **Parked rendering.** While the current position row has `phase === "ground"`:
  dimmed/static marker with frozen heading (last known); excluded from the
  "N aircraft aloft" counter; detail panel reads "On the ground at ‹base›".
  This fixes the zero-bearing edge case in `flightMotion.ts` (bearing between
  identical samples is undefined — hold the previous heading).
- **`ground` phase color:** neutral gray added to `PHASE_COLORS` in
  `flightPhases.ts` so parked stretches don't paint the default track red.
  Airborne AF1 segments use the standard default styling for its category.

## Streamer / deploy

No Go changes: AF1 `flight_positions` rows flow through the existing `flights`
channel windowing once loaded. Standard notable prod ritual:

1. `--dry-run` against prod DSN → review report (PROD-LOAD REVIEW GATE — human
   approval required before commit).
2. Committed load (scoped delete + COPY + tracks + `reconstruction_runs` ledger
   row).
3. Rewarm: `redis-cli DEL flight:minutes` (rt911-cache) + restart rt911-streamer;
   confirm the warm log's minute count **grew** (09-10 evening adds new buckets —
   an "already warm" line or an unchanged count means a stale/partial cache).

## Testing

- **Loader:** per-file `flight_date` honored end-to-end; `ground` phase accepted
  and validated; landing fields populated; two-date scoped delete leaves a BTS
  sentinel untouched on both dates; zero-distance resample guard (identical
  consecutive waypoints → held position, no NaN); AF1 full-day contiguity.
- **Frontend:** `isPresidential` predicate; presidential badge + styling path;
  parked marker state + frozen heading; aloft-counter excludes grounded AF1;
  detail-panel ground copy; `pickLeg` chooses the correct date's track.
- **Post-load verification:** minute-bucket spot checks (09-10 ~23:30Z shows
  AF1 en route; 09-11 16:30Z shows it grounded at BAD; 21:30Z en route to ADW).

## Out of scope

- A dedicated presidential map color / settings pair (data model is category-
  correct; color can be added later).
- Fighter escorts (the 09-11 legs had F-16/F-15 escorts — separate curation
  effort if ever wanted).
- Parked-at-Andrews rows after the ~22:54Z landing.
