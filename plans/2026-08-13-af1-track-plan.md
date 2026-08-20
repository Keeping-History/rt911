# Air Force One (AF1) Track Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Air Force One's complete 9/10–9/11/2001 movements (identifier `AF1`, tail SAM 28000, Boeing VC-25A) to the Flight Tracker as a sixth curated notable flight, with ground time rendered distinctly and leg 1 sourced from RADES radar if findable.

**Architecture:** Two curated JSONs (`af1_0910.json`, `af1.json`) loaded by the existing `python -m flight_recon.notable` CLI, extended for per-file `flight_date`, `ground_spans`, landing fields, and per-position `source`. Frontend adds a `presidential` category that reuses the observer (teal) styling, excludes grounded rows from the aloft counter, and dims the parked marker.

**Tech Stack:** Python 3.12 (flight-recon, pytest), TypeScript/React/Vite (frontend, vitest), Postgres/Directus, Redis (streamer cache — no Go changes).

**Spec:** `plans/2026-08-13-af1-track-design.md` — read it first.

## Global Constraints

- Flight identifier is exactly `AF1`; tail/registration string is `SAM 28000`; aircraft type `Boeing VC-25A`.
- `flight_date` semantics follow BTS: local departure date (`2001-09-10` for the positioning leg, `2001-09-11` for the three-leg day).
- `clock_seconds` anchors at 2001-09-09 ET midnight (`notable.py::_WINDOW_START_UTC`) — never at flight_date.
- Scoped deletes only: never a bare date-window delete against `flight_positions`/`flight_tracks` (the 1,945+ BTS flights share these dates).
- Loading to prod is gated on human review of a dry-run report (PROD-LOAD REVIEW GATE) — Task 9 stops and waits.
- Every commit carries `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- The husky pre-commit hook may bump `classicy` in `pnpm-lock.yaml` — expected, don't fight it.
- Frontend test files that render components need `afterEach(cleanup)` (no RTL auto-cleanup in this repo's vitest config).
- Python tests: run from `packages/tools/flight-recon/`; frontend: `pnpm --filter @rt911/frontend exec vitest run <file>`.

---

### Task 1: Research the AF1 timeline (web research → committed notes)

**Files:**
- Create: `plans/2026-08-13-af1-research.md`

**Interfaces:**
- Produces: a sourced timeline table that Task 5 (curation) copies anchor times from verbatim. Every airborne-leg wheels-off/wheels-on and every ground interval must carry at least one named source.

This is a research task — no TDD cycle. Deliverable is a committed notes file.

- [ ] **Step 1: Web-research the four legs.** Use WebSearch/WebFetch. Verify (do not trust from memory) each of these commonly-cited values, and record the actual routing of the Sept 10 positioning trip (direct ADW→SRQ or with an intermediate stop — if research shows an intermediate stop, the timeline gains a leg and Task 5 curates what research found):

  | Event | Commonly cited (VERIFY) |
  |---|---|
  | 9/10 Andrews → Sarasota departure/arrival | evening ET, arrival before ~23:00 ET |
  | 9/11 SRQ wheels-off | 9:54–9:57 a.m. ET (13:54–13:57Z) |
  | 9/11 Barksdale AFB arrival | ~11:45 a.m. ET (15:45Z) |
  | 9/11 Barksdale departure | ~1:37 p.m. ET (17:37Z) |
  | 9/11 Offutt AFB arrival | ~2:50 p.m. ET (18:50Z) |
  | 9/11 Offutt departure | ~4:33 p.m. ET (20:33Z) |
  | 9/11 Andrews arrival | ~6:34–6:54 p.m. ET (22:34–22:54Z) |

  Primary sources to search for: 9/11 Commission Report text + staff statements, the FAA/NORAD "A New Type of War" monograph, contemporaneous news timelines (CNN/AP), Draper's *Dead Certain* / Garrett accounts, the 9/11 Memorial timeline. Also research: cruise altitudes/route quirks (leg 1 initially flew northwest at low altitude before climbing; leg 3 had fighter escort — note it, escorts are out of scope), and apron/parking coordinates for SRQ, BAD, OFF, ADW (satellite-derivable; ramp area is sufficient precision).

- [ ] **Step 2: Write `plans/2026-08-13-af1-research.md`** with: a UTC timeline table (one row per event, source column), a per-leg section (route, altitudes, notes), apron coordinates per base, field elevations (SRQ 28 ft, BAD 166 ft, OFF 1048 ft, ADW 280 ft — verify), and a "conflicts" section recording any source disagreements and which value was chosen and why.

- [ ] **Step 3: Commit**

```bash
git add plans/2026-08-13-af1-research.md
git commit -m "docs(flight-recon): AF1 9/10-9/11 timeline research notes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: RADES radar hunt for leg 1 (SRQ → Barksdale)

**Files:**
- Create: `packages/tools/flight-recon/analysis/find_af1_leg1.py`
- Read: `Radar_Evaluation_Squadron_(RADES)/decoded/*.csv.gz` (repo root, untracked, 5 GB)
- Reference: `packages/tools/flight-recon/analysis/segment_rades_exports.py` (chaining), `analysis/extract_rades_notables.py` (waypoint export shape)

**Interfaces:**
- Produces: either `packages/tools/flight-recon/data/rades/af1_leg1_waypoints.json` — a JSON list of `{"utc": "...Z", "lat": float, "lon": float, "alt_ft": int, "site": str, "alt_src": "modec", "source": "radar"}` — or a documented negative result in the research notes. Task 5 consumes the file if it exists.

This is bounded exploration: timebox to the scripted search below; if no candidate survives, record the negative and move on (the spec says the hunt is best-effort, not a ship gate).

- [ ] **Step 1: Write the search script.** `analysis/find_af1_leg1.py`:
  - Load decoded CSVs whose recordings cover 13:30–16:00Z with southern coverage: all `*_SEADS_1254*.csv.gz` plus any file whose returns fall in a Florida→Louisiana corridor bbox (lat 26–34, lon −94.5…−81). Reuse the loading helpers from `segment_rades_exports.py` (import them; don't re-implement CSV parsing).
  - Filter to returns 13:30–16:10Z inside the corridor bbox.
  - Seed: returns within 0.4° of SRQ (27.395, −82.554) between 13:40 and 14:30Z. Chain each seed forward by continuity (reuse the segmenter's chaining; identity is continuity, NOT beacon code — squawks are reused).
  - Report every chain ≥ 20 returns: first/last utc+position, mean course over the first 15 min, Mode C profile summary, beacon code(s) observed. A candidate is a chain departing the SRQ area in the window heading generally NW (course 280–350°).
- [ ] **Step 2: Run it** (`python analysis/find_af1_leg1.py` from `packages/tools/flight-recon/`, with the RADES dir path as `--decoded-dir ../../..'/Radar_Evaluation_Squadron_(RADES)/decoded'`). The national ground stop (complete ~13:25Z) should leave very few departures; judge candidates against the research timeline (wheels-off time, Barksdale-bound course).
- [ ] **Step 3a (found):** Export the winning chain as `data/rades/af1_leg1_waypoints.json` in the interface shape above (decimate to ~1 waypoint per 60 s using the chain's real returns; keep the first/last verbatim). Record the identification argument (time + origin + course + continuity; note the beacon code seen) in the research notes' leg-1 section.
- [ ] **Step 3b (not found):** Append a "radar hunt negative" subsection to `plans/2026-08-13-af1-research.md`: what was searched, the bbox/time bounds, why no candidate qualified. Leg 1 falls back to anchors + great-circle.
- [ ] **Step 4: Commit** the script (+ waypoints file if produced, + research-notes update):

```bash
git add packages/tools/flight-recon/analysis/find_af1_leg1.py plans/2026-08-13-af1-research.md
git add packages/tools/flight-recon/data/rades/af1_leg1_waypoints.json  # only if produced
git commit -m "feat(flight-recon): bounded RADES search for AF1 leg 1 (SRQ->BAD)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `resample.py` — per-sample source assignment + parked-stretch regression test

**Files:**
- Modify: `packages/tools/flight-recon/flight_recon/resample.py`
- Test: `packages/tools/flight-recon/tests/test_resample.py`

**Interfaces:**
- Produces: `assign_sources(samples, waypoints) -> None` — mutates each sample dict, setting `sample["source"]` to `"radar"` when the sample time is bracketed by two waypoints both marked `"source": "radar"`, `"estimated"` when any waypoint carries a `source` mark but the bracket isn't radar-radar, and leaves `source` absent when NO waypoint carries a mark (existing five notables unchanged). `samples` are `resample_track` output (`utc` is a datetime); `waypoints` are the raw JSON dicts.
- Consumes: nothing new. Note `reconstruct.gc_interp` already returns the endpoint verbatim when distance is 0 (`if d == 0`), so identical waypoints cannot NaN — the test below pins that.

- [ ] **Step 1: Write the failing tests** (append to `tests/test_resample.py`):

```python
def test_identical_waypoints_hold_position_no_nan():
    # A parked stretch is two identical waypoints minutes apart; every
    # interpolated sample must hold the exact position and altitude.
    wps = [
        {"utc": "2001-09-11T05:00:00Z", "lat": 27.3954, "lon": -82.5544, "alt_ft": 28},
        {"utc": "2001-09-11T05:10:00Z", "lat": 27.3954, "lon": -82.5544, "alt_ft": 28},
    ]
    samples = resample_track(wps)
    assert len(samples) == 11
    for s in samples:
        assert s["lat"] == 27.3954 and s["lon"] == -82.5544 and s["alt_ft"] == 28


def test_assign_sources_radar_bracket_and_default():
    wps = [
        {"utc": "2001-09-11T13:54:00Z", "lat": 27.4, "lon": -82.55, "alt_ft": 28, "source": "estimated"},
        {"utc": "2001-09-11T13:56:00Z", "lat": 27.5, "lon": -82.60, "alt_ft": 3000, "source": "radar"},
        {"utc": "2001-09-11T13:58:00Z", "lat": 27.6, "lon": -82.65, "alt_ft": 6000, "source": "radar"},
        {"utc": "2001-09-11T14:00:00Z", "lat": 27.7, "lon": -82.70, "alt_ft": 9000, "source": "estimated"},
    ]
    samples = resample_track(wps)
    assign_sources(samples, wps)
    by_min = {s["utc"].strftime("%H:%M"): s["source"] for s in samples}
    assert by_min["13:57"] == "radar"       # bracketed radar-radar
    assert by_min["13:55"] == "estimated"   # estimated-radar bracket
    assert by_min["13:59"] == "estimated"   # radar-estimated bracket


def test_assign_sources_absent_when_unmarked():
    # Files without source marks (the existing five notables) stay untouched.
    wps = [
        {"utc": "2001-09-11T13:54:00Z", "lat": 27.4, "lon": -82.55, "alt_ft": 28},
        {"utc": "2001-09-11T13:56:00Z", "lat": 27.5, "lon": -82.60, "alt_ft": 3000},
    ]
    samples = resample_track(wps)
    assign_sources(samples, wps)
    assert all("source" not in s for s in samples)
```

Add `assign_sources` to the file's import line from `flight_recon.resample`.

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_resample.py -v -k "identical or assign_sources"` (from `packages/tools/flight-recon/`)
Expected: ImportError on `assign_sources`; the identical-waypoints test may already pass (gc_interp guard) — that's fine, it's a pin.

- [ ] **Step 3: Implement** (append to `resample.py`):

```python
def assign_sources(samples, waypoints):
    """Per-sample provenance from optional waypoint ``source`` marks.

    A sample is ``"radar"`` only when its time is bracketed by two waypoints
    both marked ``source: "radar"`` (an exact waypoint hit counts its own
    bracket); anything else in a marked file is ``"estimated"``. Files whose
    waypoints carry no marks (the original five notables) are left untouched
    so their positions keep loading with source NULL (wholly-historical)."""
    if not any("source" in w for w in waypoints):
        return
    wps = []
    for w in waypoints:
        utc = w["utc"] if isinstance(w["utc"], datetime) else parse_utc(w["utc"])
        wps.append((utc, w.get("source", "estimated")))
    for s in samples:
        t = s["utc"]
        label = "estimated"
        for (t0, s0), (t1, s1) in zip(wps, wps[1:]):
            if t0 <= t <= t1:
                label = "radar" if (s0 == "radar" and s1 == "radar") else "estimated"
                break
        s["source"] = label
```

- [ ] **Step 4: Run to verify pass**

Run: `pytest tests/test_resample.py -v`
Expected: all PASS (including the pre-existing resample tests).

- [ ] **Step 5: Commit**

```bash
git add flight_recon/resample.py tests/test_resample.py
git commit -m "feat(flight-recon): per-sample radar/estimated source assignment in resample

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `notable.py` loader extensions

**Files:**
- Modify: `packages/tools/flight-recon/flight_recon/notable.py`
- Test: `packages/tools/flight-recon/tests/test_notable.py`

**Interfaces:**
- Consumes: `assign_sources` from Task 3.
- Produces (Task 5's curated files rely on all of these):
  - `NOTABLE_FLIGHTS` includes `"AF1"`.
  - `build_flight(data)` honors optional JSON keys: `flight_date` (str, default `"2001-09-11"`), `ground_spans` (`[{"start": utcZ, "end": utcZ, "base": str}]` → samples in span get `phase="ground"`), `wheels_off_utc`/`wheels_on_utc`/`landed_at` (track fields; `wheels_off_utc` falls back to the first position's utc as today), waypoint-level `source` marks (→ per-position `source` via `assign_sources`).
  - `scoped_delete(cur, pairs)` — new signature: `pairs` is a list of `(flight, flight_date)` tuples; deletes only those exact pairs.
  - `copy_positions` COPYs a `source` column (NULL for unmarked files).

- [ ] **Step 1: Write the failing tests** (append to `tests/test_notable.py`; reuse the module's existing imports/fixtures — it already imports `build_flight`, `scoped_delete`, etc.):

```python
def _af1_fixture():
    """Minimal synthetic AF1-shaped file: parked, one hop, parked."""
    return {
        "flight": "AF1", "carrier": "USAF", "flight_date": "2001-09-10",
        "origin": "ADW", "scheduled_dest": "SRQ",
        "aircraft": "Boeing VC-25A", "registration": "SAM 28000",
        "landed_at": "SRQ",
        "wheels_off_utc": "2001-09-10T21:05:00Z",
        "wheels_on_utc": "2001-09-10T21:15:00Z",
        "ground_spans": [
            {"start": "2001-09-10T21:15:00Z", "end": "2001-09-10T21:20:00Z", "base": "SRQ"},
        ],
        "details": {"fate": {"text": "Landed safely at Andrews AFB"}},
        "sources": ["test"], "provenance_notes": ["test"],
        "waypoints": [
            {"utc": "2001-09-10T21:05:00Z", "lat": 38.81, "lon": -76.87, "alt_ft": 280},
            {"utc": "2001-09-10T21:10:00Z", "lat": 33.00, "lon": -79.70, "alt_ft": 25000},
            {"utc": "2001-09-10T21:15:00Z", "lat": 27.3954, "lon": -82.5544, "alt_ft": 28},
            {"utc": "2001-09-10T21:20:00Z", "lat": 27.3954, "lon": -82.5544, "alt_ft": 28},
        ],
    }


def test_af1_per_file_flight_date_and_clock_anchor():
    positions, track = build_flight(_af1_fixture())
    assert all(p["flight_date"] == "2001-09-10" for p in positions)
    assert track["flight_date"] == "2001-09-10"
    # clock anchors at the 2001-09-09 window start: 9/10 21:05Z is
    # 1 day + 17h05m - 4h(ET offset) past 09-09T04:00Z.
    first = positions[0]
    assert first["clock_seconds"] == first["et_seconds"] + 86400


def test_af1_ground_span_overrides_phase():
    positions, _ = build_flight(_af1_fixture())
    by_utc = {p["utc"]: p["phase"] for p in positions}
    assert by_utc["2001-09-10T21:16:00Z"] == "ground"
    assert by_utc["2001-09-10T21:20:00Z"] == "ground"
    assert by_utc["2001-09-10T21:07:00Z"] != "ground"


def test_af1_landing_fields_on_track():
    _, track = build_flight(_af1_fixture())
    assert track["landed_at"] == "SRQ"
    assert track["wheels_off_utc"] == "2001-09-10T21:05:00Z"
    assert track["wheels_on_utc"] == "2001-09-10T21:15:00Z"


def test_af1_waypoint_sources_reach_positions():
    data = _af1_fixture()
    for w in data["waypoints"]:
        w["source"] = "estimated"
    data["waypoints"][0]["source"] = "radar"
    data["waypoints"][1]["source"] = "radar"
    positions, _ = build_flight(data)
    by_utc = {p["utc"]: p.get("source") for p in positions}
    assert by_utc["2001-09-10T21:07:00Z"] == "radar"
    assert by_utc["2001-09-10T21:12:00Z"] == "estimated"


def test_existing_notables_have_no_source():
    positions, _ = build_flight(load_flight_file(
        os.path.join(DATA_DIR, "aa11.json")))
    assert all(p.get("source") is None for p in positions)


def test_scoped_delete_pairs_only_touch_their_dates(scratch_db):
    # Seed: AF1 on both dates + a BTS sentinel sharing each date.
    # Deleting only the 09-10 pair must leave the 09-11 AF1 rows and both
    # sentinels untouched.
    ...  # follow the structure of test_scoped_delete_targets_only_the_four_ids_never_a_window,
         # inserting rows for ("AF1","2001-09-10"), ("AF1","2001-09-11"),
         # ("AA1002","2001-09-10"), ("AA1002","2001-09-11"), then calling
         # scoped_delete(cur, [("AF1", "2001-09-10")]) and asserting counts.
```

(For the last test: mirror the existing scoped-delete test's setup exactly — same scratch_db fixture, same insert helper — the `...` above is the only place the executor adapts to the fixture's local helpers rather than copying verbatim. Every other test above is complete as written.)

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_notable.py -v -k af1`
Expected: FAIL — `build_flight` ignores `flight_date` (positions say 2001-09-11), no ground phase, `landed_at` is None, no source.

- [ ] **Step 3: Implement in `notable.py`:**

  1. `NOTABLE_FLIGHTS = ("AA11", "UA175", "AA77", "UA93", "GOFER06", "AF1")`.
  2. Import `assign_sources` alongside the other `flight_recon.resample` imports.
  3. COPY columns: replace the module-level use of `POSITION_COLUMNS` in `copy_positions` with:

```python
# COPY column list: the shared BTS columns plus per-position provenance
# (source stays NULL for files without waypoint marks).
NOTABLE_POSITION_COLUMNS = POSITION_COLUMNS[:-1] + ["source", "run_id"]
```

and in `copy_positions`:

```python
def copy_positions(cur, positions, run_id):
    with cur.copy(f"COPY flight_positions ({', '.join(NOTABLE_POSITION_COLUMNS)}) FROM STDIN") as cp:
        for p in positions:
            cp.write_row([p["flight"], p["carrier"], p["flight_date"], p["utc"],
                          p["et_seconds"], p["clock_seconds"], p["lat"], p["lon"],
                          p["alt_ft"], p["phase"], p["diverted"], p.get("source"),
                          run_id])
    return len(positions)
```

  Also add `source varchar,` to `LOCAL_SCHEMA_DDL`'s `flight_positions` (the prod column already exists from the RADES splice load).

  4. `build_flight`: honor the new keys. At the top: `flight_date = data.get("flight_date", FLIGHT_DATE)`. After `assign_curated_phases` / before validation, apply sources and ground spans:

```python
    assign_sources(samples, data["waypoints"])
    for span in data.get("ground_spans", []):
        s0, s1 = parse_utc(span["start"]), parse_utc(span["end"])
        for s in samples:
            if s0 <= s["utc"] <= s1:
                s["phase"] = "ground"
```

  In the position dict: `"flight_date": flight_date,` and `"source": s.get("source"),`. In the track dict:

```python
        "flight_date": flight_date,
        "landed_at": data.get("landed_at"),
        "wheels_off_utc": data.get("wheels_off_utc", positions[0]["utc"]),
        "wheels_on_utc": data.get("wheels_on_utc"),
```

  5. `scoped_delete` new signature (and update its callers + the existing test's call sites are already per the new tests):

```python
def scoped_delete(cur, pairs):
    """Delete ONLY the given (flight, flight_date) pairs — never a date window.

    Returns (positions_deleted, tracks_deleted)."""
    pos = trk = 0
    for flight, fdate in pairs:
        cur.execute("DELETE FROM flight_positions WHERE flight_date = %s AND flight = %s",
                    (fdate, flight))
        pos += cur.rowcount
        cur.execute("DELETE FROM flight_tracks WHERE flight_date = %s AND flight = %s",
                    (fdate, flight))
        trk += cur.rowcount
    log.info("scoped delete: %d positions, %d tracks for %s", pos, trk, pairs)
    return pos, trk
```

  In `run()`: `pairs = sorted({(t["flight"], t["flight_date"]) for t in tracks})` then `scoped_delete(cur, pairs)`.

  6. `insert_run` source text: append `"; AF1 (SAM 28000) curated from published timeline sources"` to the existing string, and `insert_run`'s `start`/`end` args become `min(t["flight_date"] for t in tracks)` / `max(...)` — thread `tracks` in from `run()` (change signature to `insert_run(cur, run_id, positions_count, tracks)` and compute `tracks_count = len(tracks)` inside).

  7. Update the existing scoped-delete tests that call the old signature: `scoped_delete(cur, [(f, "2001-09-11") for f in NOTABLE_FLIGHTS])` reproduces the old behavior.

- [ ] **Step 4: Run the whole package suite**

Run: `pytest tests/ -v` and `ruff check flight_recon/ analysis/ tests/`
Expected: all PASS (the five existing JSON files build unchanged — no `flight_date`/`source` behavior shift for them), ruff clean.

- [ ] **Step 5: Commit**

```bash
git add flight_recon/notable.py tests/test_notable.py
git commit -m "feat(flight-recon): notable loader supports per-file dates, ground spans, landings, source

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Curate `af1_0910.json` and `af1.json`

**Files:**
- Create: `packages/tools/flight-recon/data/notable_flights/af1_0910.json`
- Create: `packages/tools/flight-recon/data/notable_flights/af1.json`
- Test: `packages/tools/flight-recon/tests/test_notable.py` (data-integrity additions)
- Consume: `plans/2026-08-13-af1-research.md` (Task 1), `data/rades/af1_leg1_waypoints.json` if Task 2 produced it.

**Interfaces:**
- Produces: the two reviewable data files, every time/coordinate traceable to the research notes. `build_all()` picks them up automatically (glob).

- [ ] **Step 1: Write the data-integrity tests first** (append to `tests/test_notable.py`; they fail until the files exist):

```python
def _load_af1():
    return (load_flight_file(os.path.join(DATA_DIR, "af1_0910.json")),
            load_flight_file(os.path.join(DATA_DIR, "af1.json")))


def test_af1_files_build_and_are_continuous():
    d0910, d0911 = _load_af1()
    p0, _ = build_flight(d0910)
    p1, t1 = build_flight(d0911)
    assert p0[0]["flight_date"] == "2001-09-10"
    assert p1[0]["flight_date"] == "2001-09-11"
    # 9/11 file starts at ET midnight parked at SRQ and ends at the Andrews landing
    assert p1[0]["utc"] == "2001-09-11T04:00:00Z"
    assert p1[0]["phase"] == "ground"
    assert t1["landed_at"] == "ADW"
    assert t1["wheels_on_utc"] is not None
    # seamless handoff: the 9/10 file's ground tail ends the minute before 04:00Z
    assert p0[-1]["utc"] == "2001-09-11T03:59:00Z"


def test_af1_ground_stops_cover_barksdale_and_offutt():
    _, d0911 = _load_af1()
    p1, t1 = build_flight(d0911)
    phases = [(p["utc"], p["phase"]) for p in p1]
    grounded = [u for u, ph in phases if ph == "ground"]
    airborne = [u for u, ph in phases if ph != "ground"]
    assert grounded and airborne
    # three airborne legs => the phase sequence alternates ground/air 3 times
    blocks = []
    for _, ph in phases:
        b = ph == "ground"
        if not blocks or blocks[-1] != b:
            blocks.append(b)
    assert blocks == [True, False, True, False, True, False]
    # detail-panel ground copy: curated stop list present with UTC bounds
    stops = t1["details"]["ground_stops"]
    assert [s["code"] for s in stops] == ["SRQ", "BAD", "OFF"]
    for s in stops:
        assert s["name"] and s["start"] and s["end"]


def test_af1_identity_fields():
    d0910, d0911 = _load_af1()
    for d in (d0910, d0911):
        assert d["flight"] == "AF1"
        assert d["registration"] == "SAM 28000"
        assert d["aircraft"] == "Boeing VC-25A"
        assert d["sources"] and d["provenance_notes"]
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_notable.py -v -k af1_files`
Expected: FAIL — FileNotFoundError.

- [ ] **Step 3: Author the two JSONs** from the research notes. Structure (mirror `gofer06.json`'s shape plus the new keys):

  **`af1_0910.json`** — `flight_date: "2001-09-10"`, `origin: "ADW"`, `scheduled_dest: "SRQ"`, `landed_at: "SRQ"`, wheels times from research. Waypoints: takeoff at the researched ADW departure, en-route great-circle anchors (cruise ~FL350 unless research says otherwise), landing at SRQ, then a ground span from wheels-on to `2001-09-11T03:59:00Z` (two identical apron waypoints; `ground_spans` entry `{"start": <wheels_on>, "end": "2001-09-11T03:59:00Z", "base": "SRQ"}`). All waypoints `"source": "estimated"`. `details.ground_stops`: the SRQ overnight entry. If research found an intermediate 9/10 stop, model it the same way (extra leg + ground span).

  **`af1.json`** — `flight_date: "2001-09-11"`, `origin: "SRQ"`, `scheduled_dest: "ADW"`, `landed_at: "ADW"`, `wheels_off_utc` = SRQ departure, `wheels_on_utc` = Andrews landing. Waypoints: parked at SRQ from `04:00:00Z` (identical apron coords) → leg 1 (use `data/rades/af1_leg1_waypoints.json` verbatim with `"source": "radar"` if Task 2 produced it; else estimated anchors) → Barksdale ground span → leg 2 anchors → Offutt ground span → leg 3 anchors → ADW landing. Three `ground_spans` (SRQ/BAD/OFF) with bases; `details`:

```json
"details": {
  "crew": {"captain": "Col. Mark Tillman"},
  "ground_stops": [
    {"code": "SRQ", "name": "Sarasota-Bradenton International Airport", "start": "2001-09-11T04:00:00Z", "end": "<leg-1 wheels-off>"},
    {"code": "BAD", "name": "Barksdale Air Force Base", "start": "<leg-1 wheels-on>", "end": "<leg-2 wheels-off>"},
    {"code": "OFF", "name": "Offutt Air Force Base", "start": "<leg-2 wheels-on>", "end": "<leg-3 wheels-off>"}
  ],
  "fate": {"text": "Returned to Andrews AFB; the President addressed the nation from the White House that evening", "utc": "<andrews wheels-on>"}
}
```

  (Replace every `<...>` with the researched value — the committed files carry only literal times.) `sources`: the researched citations. `provenance_notes`: state per-leg provenance explicitly, including the radar-hunt outcome (positive with the identification argument, or negative with "reconstructed from published timeline anchors + great-circle interpolation").

- [ ] **Step 4: Run the full loader suite + a local dry-run**

Run: `pytest tests/ -v`
Then a scratch-DB dry-run (proves end-to-end build+COPY of all seven files):

```bash
python -m flight_recon.notable --dsn "$SCRATCH_DSN" --init-schema --dry-run -v
```

(Use a local/scratch Postgres, e.g. a throwaway docker `postgres:16`; NEVER prod here.)
Expected: tests PASS; dry-run prints a summary with `"flights": 7` and rolls back.

- [ ] **Step 5: Commit**

```bash
git add data/notable_flights/af1_0910.json data/notable_flights/af1.json tests/test_notable.py
git commit -m "feat(flight-recon): curated AF1 full-day track data (9/10 positioning + 9/11 three legs)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Frontend — presidential category with observer styling

**Files:**
- Modify: `packages/frontend/src/Applications/FlightTracker/notableFlights.ts`
- Modify: `packages/frontend/src/Applications/FlightTracker/flightGeoJSON.ts` (properties)
- Modify: `packages/frontend/src/Applications/FlightTracker/flightMotion.ts` (motionPointsToGeoJSON + motionTrailsToGeoJSON properties)
- Modify: any other styling call site of `isObserver(` found by grep (e.g. `plane3dMesh.ts` / `planes3DLayer.ts`) — styling sites only, NOT the detail-panel badge
- Modify: `packages/frontend/src/Applications/FlightTracker/flightPhases.ts` (ground color + label)
- Test: `packages/frontend/src/Applications/FlightTracker/notableFlights.test.ts`, `flightPhases.test.ts`

**Interfaces:**
- Produces: `isPresidential(flight: string): boolean` and `isObserverStyled(flight: string): boolean` (observer ∪ presidential) from `notableFlights.ts`; `PHASE_COLORS.ground = "#8a8a8a"`, `PHASE_LABELS.ground = "On Ground"`. Task 7 consumes `isPresidential` for the badge.

- [ ] **Step 1: Write the failing tests** (append to `notableFlights.test.ts` and `flightPhases.test.ts`):

```typescript
// notableFlights.test.ts
import { isNotable, isObserver, isObserverStyled, isPresidential } from "./notableFlights";

describe("presidential category (AF1)", () => {
	it("AF1 is presidential, not notable, not observer", () => {
		expect(isPresidential("AF1")).toBe(true);
		expect(isNotable("AF1")).toBe(false);
		expect(isObserver("AF1")).toBe(false);
	});
	it("observer styling covers observers and presidential aircraft", () => {
		expect(isObserverStyled("GOFER06")).toBe(true);
		expect(isObserverStyled("AF1")).toBe(true);
		expect(isObserverStyled("AA11")).toBe(false);
		expect(isObserverStyled("DL1989")).toBe(false);
	});
});
```

```typescript
// flightPhases.test.ts
it("ground phase has a neutral color and label distinct from the default", () => {
	expect(PHASE_COLORS.ground).toBeDefined();
	expect(PHASE_COLORS.ground).not.toBe(DEFAULT_PHASE_COLOR);
	expect(phaseLabel("ground")).toBe("On Ground");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/FlightTracker/notableFlights.test.ts src/Applications/FlightTracker/flightPhases.test.ts`
Expected: FAIL — `isPresidential`/`isObserverStyled` not exported; ground color missing.

- [ ] **Step 3: Implement.**

  `notableFlights.ts` — append:

```typescript
// Air Force One (SAM 28000). Its own category — presidential, not a witness —
// but rendered with the observer treatment (teal highlight, never clustered,
// no crash semantics) until a dedicated presidential color exists. Copy and
// badges key off isPresidential; map styling keys off isObserverStyled.
export const PRESIDENTIAL_FLIGHTS = ["AF1"] as const;

const PRESIDENTIAL_SET: ReadonlySet<string> = new Set(PRESIDENTIAL_FLIGHTS);

export function isPresidential(flight: string): boolean {
	return PRESIDENTIAL_SET.has(flight);
}

// The styling union: every flight the observer-colored highlight layers serve.
export function isObserverStyled(flight: string): boolean {
	return OBSERVER_SET.has(flight) || PRESIDENTIAL_SET.has(flight);
}
```

  `flightGeoJSON.ts` and `flightMotion.ts`: change the styling property emitters — `observer: isObserver(...)` becomes `observer: isObserverStyled(...)` in `flightsToGeoJSON`, `motionPointsToGeoJSON`, and `motionTrailsToGeoJSON` (update imports; keep the property NAME `observer` so every layer filter, cluster exclusion, and 3D path works unchanged). Update the `observer` property's doc comment to say it means "observer-styled (witness aircraft + AF1)".

  Then `grep -rn "isObserver(" packages/frontend/src/Applications/FlightTracker/` and switch remaining STYLING call sites (3D mesh/layer color category, icon builders) to `isObserverStyled`. Leave `FlightDetailPanel.tsx`'s OBSERVER badge on `isObserver`.

  `flightPhases.ts`: add to `PHASE_COLORS`: `ground: "#8a8a8a",` with comment `// AF1 parked stretches — neutral, outside the escalation ramp`; add to `PHASE_LABELS`: `ground: "On Ground",`.

- [ ] **Step 4: Run the FlightTracker suite**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/FlightTracker/`
Expected: PASS. (If a 3D/mesh test asserts on `isObserver` semantics, update it to `isObserverStyled` with the same expectations for GOFER06.)

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/FlightTracker/
git commit -m "feat(frontend): presidential flight category (AF1) with observer styling + ground phase

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Frontend — parked behavior (counter, linger, dimming, detail panel)

**Files:**
- Create: `packages/frontend/src/Applications/FlightTracker/groundStops.ts`
- Create: `packages/frontend/src/Applications/FlightTracker/groundStops.test.ts`
- Modify: `packages/frontend/src/Applications/FlightTracker/flightLanding.ts` (ground exemption)
- Modify: `packages/frontend/src/Applications/FlightTracker/FlightTracker.tsx` (aloft counter, ~line 357 + status bar ~line 1376)
- Modify: `packages/frontend/src/Applications/FlightTracker/FlightMap.tsx` (flights-notable layer paint, ~line 852)
- Modify: `packages/frontend/src/Applications/FlightTracker/FlightDetailPanel.tsx` (badge + ground status row)
- Test: `flightLanding.test.ts`, `FlightDetailPanel.test.tsx`

**Interfaces:**
- Consumes: `isPresidential` (Task 6); `track.details.ground_stops` shape from Task 5 (`[{code, name, start, end}]`, UTC ISO `...Z`).
- Produces: `groundStopAt(details: { ground_stops?: GroundStop[] } | null | undefined, nowMs: number): GroundStop | null`.

- [ ] **Step 1: Write the failing tests.**

  `groundStops.test.ts` (new file — pure logic, no rendering, no cleanup needed):

```typescript
import { describe, expect, it } from "vitest";
import { groundStopAt } from "./groundStops";

const details = {
	ground_stops: [
		{ code: "SRQ", name: "Sarasota-Bradenton International Airport", start: "2001-09-11T04:00:00Z", end: "2001-09-11T13:54:00Z" },
		{ code: "BAD", name: "Barksdale Air Force Base", start: "2001-09-11T15:45:00Z", end: "2001-09-11T17:37:00Z" },
	],
};

describe("groundStopAt", () => {
	it("returns the stop covering the instant", () => {
		expect(groundStopAt(details, Date.parse("2001-09-11T16:00:00Z"))?.code).toBe("BAD");
	});
	it("bounds are inclusive", () => {
		expect(groundStopAt(details, Date.parse("2001-09-11T15:45:00Z"))?.code).toBe("BAD");
		expect(groundStopAt(details, Date.parse("2001-09-11T17:37:00Z"))?.code).toBe("BAD");
	});
	it("null while airborne, on missing data, and on malformed stops", () => {
		expect(groundStopAt(details, Date.parse("2001-09-11T14:30:00Z"))).toBeNull();
		expect(groundStopAt(null, 0)).toBeNull();
		expect(groundStopAt({}, 0)).toBeNull();
		expect(groundStopAt({ ground_stops: [{ code: "X", name: "X", start: "bad", end: "bad" }] }, 0)).toBeNull();
	});
});
```

  `flightLanding.test.ts` — append:

```typescript
it("explicit ground rows survive dropLandedPositions past the linger window", () => {
	// AF1 overnight at SRQ: wheels-on long past, but the row says phase=ground —
	// an explicit "still here", not a stale lingering flight.
	const p = mkPosition({ flight: "AF1", phase: "ground" }); // adapt to the file's existing position factory
	const index = mkIndex([{ flight: "AF1", flight_date: "2001-09-10", wheels_on_utc: "2001-09-11T02:48:00Z" }]); // adapt to the file's existing index factory
	const nowMs = Date.parse("2001-09-11T03:30:00Z"); // 42 min after wheels-on
	expect(dropLandedPositions([p], index, nowMs)).toHaveLength(1);
});
```

  (Adapt the two factory helpers to whatever `flightLanding.test.ts` already uses to build positions and a RouteIndex — read the file's existing tests first.)

  `FlightDetailPanel.test.tsx` — append (this file renders components; confirm it already has `afterEach(cleanup)`, add it if not):

```typescript
it("shows the PRESIDENTIAL badge and ground status for a parked AF1", () => {
	const selected = { id: 1, flight: "AF1", start_date: "2001-09-11T16:00:00Z", lat: 32.5, lon: -93.66, alt_ft: 166, phase: "ground" };
	const track = {
		flight: "AF1", flight_date: "2001-09-11", origin: "SRQ", scheduled_dest: "ADW",
		wheels_off_utc: "2001-09-11T13:54:00Z", wheels_on_utc: "2001-09-11T22:54:00Z",
		aircraft_type: "Boeing VC-25A", tail_number: "SAM 28000",
		details: { ground_stops: [{ code: "BAD", name: "Barksdale Air Force Base", start: "2001-09-11T15:45:00Z", end: "2001-09-11T17:37:00Z" }] },
	};
	render(<FlightDetailPanel selected={selected} track={track} loading={false} error={null}
		nowMs={Date.parse("2001-09-11T16:00:00Z")} />);
	expect(screen.getByText("PRESIDENTIAL")).toBeDefined();
	expect(screen.getByText("On the ground at Barksdale Air Force Base")).toBeDefined();
});
```

  (Adapt the `selected`/`track` literals to the panel's prop types — cast with `as` following the file's existing test style.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/FlightTracker/groundStops.test.ts src/Applications/FlightTracker/flightLanding.test.ts src/Applications/FlightTracker/FlightDetailPanel.test.tsx`
Expected: FAIL — module missing, ground rows dropped, badge/status absent.

- [ ] **Step 3: Implement.**

  `groundStops.ts` (new):

```typescript
// Curated ground-stop intervals for flights that park mid-day (AF1's
// Sarasota/Barksdale/Offutt stops), carried in flight_tracks.details.
// The detail panel matches the replay clock against them to say WHERE a
// grounded aircraft is — the position row's phase says only THAT it's parked.
export interface GroundStop {
	code: string;
	name: string;
	start: string; // UTC ISO ...Z
	end: string;
}

export function groundStopAt(
	details: { ground_stops?: GroundStop[] } | null | undefined,
	nowMs: number,
): GroundStop | null {
	for (const stop of details?.ground_stops ?? []) {
		const start = Date.parse(stop.start);
		const end = Date.parse(stop.end);
		if (Number.isNaN(start) || Number.isNaN(end)) continue;
		if (start <= nowMs && nowMs <= end) return stop;
	}
	return null;
}
```

  `flightLanding.ts` — in `dropLandedPositions`'s filter, after the `isNotable` early-return:

```typescript
			// An explicit ground row is a statement the aircraft is parked and
			// should be shown (AF1's ground stops) — landing linger only removes
			// flights that landed and STOPPED emitting positions.
			if (p.phase === "ground") return true;
```

  `FlightTracker.tsx` — beside the `anonAloft` memo (~line 357):

```typescript
	// Parked aircraft (AF1 during its ground stops) are on the map but not
	// "aloft" — the status bar subtracts them like it subtracts anon traffic.
	const groundedCount = useMemo(
		() => flightPositions.filter((p) => p.phase === "ground").length,
		[flightPositions],
	);
```

  and in the status bar (~line 1376), replace both `flightPositions.length - anonAloft` occurrences with `flightPositions.length - anonAloft - groundedCount`.

  `FlightMap.tsx` — the `flights-notable` layer gains a paint block (grounded AF1 dims; airborne highlight unchanged):

```typescript
				// A parked highlight (AF1 at a ground stop) dims so a motionless
				// icon reads as "on the ground", not a stuck render.
				paint: { "icon-opacity": ["case", ["==", ["get", "phase"], "ground"], 0.55, 1] },
```

  `FlightDetailPanel.tsx` — import `isPresidential` from `./notableFlights` and `groundStopAt` from `./groundStops`; in the badge row after the OBSERVER badge:

```tsx
				{isPresidential(selected.flight) && (
					<span className={styles.detailBadge}>PRESIDENTIAL</span>
				)}
```

  and in the `<dl>` after the Phase row:

```tsx
				{(livePos ?? selected).phase === "ground" && (
					<><dt>Status</dt><dd>
						{(() => {
							const stop = groundStopAt(details, nowMs);
							return stop ? `On the ground at ${stop.name}` : "On the ground";
						})()}
					</dd></>
				)}
```

- [ ] **Step 4: Run the full frontend suite + typecheck + lint**

Run: `pnpm --filter @rt911/frontend exec vitest run` then `pnpm build` and `pnpm lint` (repo root)
Expected: all PASS/clean.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/FlightTracker/
git commit -m "feat(frontend): parked-aircraft rendering — ground status, dimmed marker, aloft-count exclusion

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Full verification sweep

**Files:** none new — verification only (superpowers:verification-before-completion applies).

- [ ] **Step 1:** `cd packages/tools/flight-recon && pytest tests/ -v && ruff check flight_recon/ analysis/ tests/` → all pass.
- [ ] **Step 2:** repo root: `pnpm test && pnpm build && pnpm lint` → all pass.
- [ ] **Step 3:** Local browser check with a scratch load if feasible (dev server + local streamer is heavyweight — acceptable to defer visual confirmation to the post-prod-load verification in Task 9, since the frontend ships behind data that doesn't exist in prod yet).
- [ ] **Step 4:** Fix anything red before proceeding; do not report the plan complete with failures.

---

### Task 9: Prod load ritual (STOPS at the review gate)

**Files:** none — operational. Follow exactly; this task touches production.

- [ ] **Step 1: Pre-checks.**
  - `kubectl port-forward svc/rt911-db 15432:5432 -n rt911` (DSN: `postgres://directus:$DB_PASSWORD@localhost:15432/directus`, password from rt911-secrets).
  - No backup/long transactions running: `SELECT pid, state, query_start, left(query,80) FROM pg_stat_activity WHERE state <> 'idle' ORDER BY query_start;` — abort if a pg_dump is active.
  - AF collision guard: `SELECT flight, flight_date, count(*) FROM flight_positions WHERE flight LIKE 'AF%' AND flight_date IN ('2001-09-10','2001-09-11') GROUP BY 1,2;` → expect zero rows.
  - Confirm `flight_positions.source` column exists (it shipped with the RADES splice): `SELECT column_name FROM information_schema.columns WHERE table_name='flight_positions' AND column_name='source';`
- [ ] **Step 2: Dry-run against prod** (rolls back; nothing persists):

```bash
python -m flight_recon.notable --dsn "$PROD_DSN" --dry-run -v
```

  Write a short report: flights built (7), AF1 position counts per date, deleted counts (expect 0 AF1 rows pre-existing; the five existing notables' delete/reinsert counts matching their current prod rows), sample rows (first/last per leg).
- [ ] **Step 3: PROD-LOAD REVIEW GATE — STOP.** Present the dry-run report and the two JSON files to the user. Do not proceed without explicit approval.
- [ ] **Step 4 (after approval): Committed load.** Same command without `--dry-run`. Record the `run_id`.
- [ ] **Step 5: Rewarm.** `redis-cli -h <rt911-cache> DEL flight:minutes`, then restart rt911-streamer (pod delete; ArgoCD respawns). Confirm the warm log's `flight cache warm minutes=N` shows N **> 3783** (AF1's overnight/parked minutes add buckets; an "already warm" line or an unchanged count means a stale/partial cache — drop and re-warm per the notable-flights runbook).
- [ ] **Step 6: Verify.**
  - Bucket spot-checks (redis msgpack is escaped text under `--no-raw`: match `\xa3AF1` — 3-char fixstr — never bare `strings | grep`): 09-10 ~23:30Z bucket (or the researched en-route time), 09-11 08:00Z (parked SRQ), 16:30Z (parked BAD), 21:30Z (en route ADW).
  - REST: `curl -g` the Directus `flight_tracks` filter for AF1 → two rows (09-10, 09-11) with geometry, `landed_at`, wheels times; `flight_positions` for AF1 09-11 carries `phase` (`ground` during stops) and `source` (`radar`/`estimated` per the hunt outcome).
  - Browser (prod or dev-pointed-at-prod): scrub to ~10:00 ET 9/11 → AF1 teal highlight climbing out of SRQ; detail panel shows PRESIDENTIAL badge, route SRQ → ADW, provenance dashes on estimated stretches; scrub to ~12:30 ET → dimmed parked marker at Barksdale, "On the ground at Barksdale Air Force Base", aloft counter excludes it; 9/10 ~19:00 ET → AF1 en route to Florida.
- [ ] **Step 7: Push.** `git push` main (frontend ships via CI → GHCR → ArgoCD). Confirm CI green.

---

## Self-review notes (already applied)

- `gc_interp` needs no zero-distance fix (`if d == 0` exists) — Task 3 pins it with a regression test instead.
- `flightMotion.ts` already holds the last heading for stationary flights (`headingDeg` only updates on movement) — no change needed, so no task touches it.
- The five existing notable JSONs carry a `flight_date` key the loader previously ignored; honoring it is behavior-preserving (they all say `2001-09-11`) — Task 4's full-suite run proves it.
- Keeping the GeoJSON property NAME `observer` (fed by `isObserverStyled`) is what lets every MapLibre filter, the cluster exclusion, hit-test lists, and the 3D shader path work with zero layer edits.
