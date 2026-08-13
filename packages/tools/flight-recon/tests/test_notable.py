"""
Tests for the notable-flights loader.

Pure tests (no DB) cover the accuracy-critical core: per-minute resample cadence
with pinned endpoints, interpolation sanity, track geometry ending at impact
(for the four crashed flights; GOFER06 has no impact), airborne-at-T, and —
crucially — that the delete is SCOPED to the five flight IDs and never a date
window.

The end-to-end idempotency test (scoped delete leaves a sentinel BTS flight
AA1002 and the BTS row count untouched across a re-run) needs a real Postgres.
It runs only when ``NOTABLE_TEST_DSN`` points at a throwaway/scratch database
(the dry-run validation step), and is skipped otherwise so ``pytest tests/`` is
green without a DB.
"""

import os
from datetime import date
from pathlib import Path

import pytest

from flight_recon import notable
from flight_recon.notable import build_all, build_flight, load_flight_file
from flight_recon.resample import decimate_polyline, parse_utc, resample_track

DATA_DIR = Path(__file__).parent.parent / "data" / "notable_flights"

# CURATED FILES ARE KEYED BY FILE STEM, NOT BY FLIGHT ID. AF1 has two curated
# files — af1_0910.json (the 9/10 positioning flight) and af1.json (the 9/11 full
# day) — that share the flight ID "AF1". Keying anything by flight ID collapses
# them and keeps whichever Path.glob happened to yield last, which is filesystem
# order: the surviving file then differs between machines and half the AF1 data
# goes untested. Every real-file-backed collection below is therefore stem-keyed.
DATA_FILES = sorted(DATA_DIR.glob("*.json"))
CURATED_STEMS = tuple(p.stem for p in DATA_FILES)

# The four crashed flights (documented impact); gofer06 is the observer, and the
# two af1 files are neither.
HIJACKED = ("aa11", "ua175", "aa77", "ua93")

# One loaded track per curated file. Deliberately a literal, not len(...) of a
# glob: a self-referential count would silently lower the bar for the DSN-gated
# end-to-end assertions if a curated file ever vanished.
CURATED_FILE_COUNT = 7

CURATED_PHASES = {"takeoff", "tracon", "artcc", "hijack",
                  "course_change", "atc_alert", "descent", "down"}


def test_notable_positions_use_curated_phases():
    positions, _ = build_all()
    by_flight = {}
    for p in positions:
        by_flight.setdefault(p["flight"], []).append(p["phase"])
    for flight in ("AA11", "UA175", "AA77", "UA93"):
        phases = by_flight[flight]
        # every position of a hijacked flight carries an 8-phase value...
        assert set(phases) <= CURATED_PHASES, f"{flight}: {set(phases) - CURATED_PHASES}"
        # ...and the story spans at least takeoff -> down.
        assert phases[0] == "takeoff"
        assert phases[-1] == "down"


def test_gofer06_keeps_altitude_phase():
    positions, _ = build_all()
    gofer = {p["phase"] for p in positions if p["flight"] == "GOFER06"}
    assert gofer <= {"climb", "cruise", "descent"}


# ------------------------------------------------------------------ resample core
def _minutes(dt0, dt1):
    return int((dt1.replace(second=0, microsecond=0)
                - dt0.replace(second=0, microsecond=0)).total_seconds() // 60) + 1


def test_resample_one_row_per_minute_pinned_endpoints():
    wps = [
        {"utc": "2001-09-11T11:59:00Z", "lat": 42.3656, "lon": -71.0096, "alt_ft": 0},
        {"utc": "2001-09-11T12:26:30Z", "lat": 42.47, "lon": -73.95, "alt_ft": 29000},
        {"utc": "2001-09-11T12:46:40Z", "lat": 40.71236, "lon": -74.01303, "alt_ft": 1360},
    ]
    samples = resample_track(wps)
    takeoff, impact = parse_utc(wps[0]["utc"]), parse_utc(wps[-1]["utc"])

    # endpoints pinned to first/last waypoint (exact times + coords)
    assert samples[0]["utc"] == takeoff
    assert (samples[0]["lat"], samples[0]["lon"], samples[0]["alt_ft"]) == (42.3656, -71.0096, 0)
    assert samples[-1]["utc"] == impact
    assert (samples[-1]["lat"], samples[-1]["lon"]) == (40.71236, -74.01303)

    # exactly one row per minute-bucket across [takeoff, impact]
    buckets = [s["utc"].replace(second=0, microsecond=0) for s in samples]
    assert len(buckets) == len(set(buckets)) == _minutes(takeoff, impact)
    # interior samples land on whole minutes; only the impact sample is off-minute
    for s in samples[1:-1]:
        assert s["utc"].second == 0
    assert samples[-1]["utc"].second == 40


def test_resample_interpolation_midpoint_between_waypoints():
    wps = [
        {"utc": "2001-09-11T12:00:00Z", "lat": 40.0, "lon": -80.0, "alt_ft": 10000},
        {"utc": "2001-09-11T12:02:00Z", "lat": 42.0, "lon": -80.0, "alt_ft": 20000},
    ]
    samples = resample_track(wps)
    mid = [s for s in samples if s["utc"] == parse_utc("2001-09-11T12:01:00Z")][0]
    # linear altitude midpoint; latitude between the two endpoints
    assert mid["alt_ft"] == 15000
    assert 40.0 < mid["lat"] < 42.0
    assert abs(mid["lon"] - (-80.0)) < 0.01  # same meridian -> lon unchanged


def test_resample_rejects_non_increasing_times():
    with pytest.raises(ValueError, match="strictly increase"):
        resample_track([
            {"utc": "2001-09-11T12:05:00Z", "lat": 40, "lon": -80, "alt_ft": 0},
            {"utc": "2001-09-11T12:05:00Z", "lat": 41, "lon": -80, "alt_ft": 0},
        ])


# ------------------------------------------------------------------ build_flight
@pytest.fixture(scope="module")
def built():
    """Every curated data file, built and keyed by its file stem (see CURATED_STEMS
    — flight IDs are not unique across files)."""
    out = {}
    for path in DATA_FILES:
        data = notable.load_flight_file(path)
        out[path.stem] = (data, *notable.build_flight(data))
    return out


def test_every_curated_file_is_built(built):
    assert set(built) == set(CURATED_STEMS)
    # both AF1 files survive the fixture independently — the bug this keying fixes
    assert {"af1", "af1_0910"} <= set(built)
    assert built["af1"][0]["flight_date"] == "2001-09-11"
    assert built["af1_0910"][0]["flight_date"] == "2001-09-10"


@pytest.mark.parametrize("flight", CURATED_STEMS)
def test_track_is_a_sane_linestring(built, flight):
    data, positions, track = built[flight]
    geom = track["geometry"]
    assert geom["type"] == "LineString"
    assert len(geom["coordinates"]) >= 2
    for lon, lat in geom["coordinates"]:
        assert -150 < lon < -65 and 18 < lat < 65      # NA bounds, [lon, lat] order
    # geometry spans exactly the flown track: first/last vertices match the
    # first/last per-minute positions
    assert geom["coordinates"][0] == pytest.approx(
        [positions[0]["lon"], positions[0]["lat"]], abs=1e-4)
    assert geom["coordinates"][-1] == pytest.approx(
        [positions[-1]["lon"], positions[-1]["lat"]], abs=1e-4)


@pytest.mark.parametrize("flight", HIJACKED)
def test_track_ends_at_documented_impact(built, flight):
    data, _, track = built[flight]
    end_lon, end_lat = track["geometry"]["coordinates"][-1]
    assert abs(end_lon - data["impact"]["lon"]) <= 1e-3
    assert abs(end_lat - data["impact"]["lat"]) <= 1e-3


# AF1 is the one curated flight that is radar-surveyed for only part of its
# track: its 9/11 file spans a whole day (1,100+ per-minute rows) of which ~98
# minutes are RADES returns, and its 9/10 file has no radar at all. The
# whole-track "more vertices than minutes" invariant therefore cannot hold for
# it; test_af1_geometry_keeps_leg1_radar_returns asserts its radar density
# instead.
RADAR_DENSE = tuple(f for f in CURATED_STEMS if not f.startswith("af1"))


@pytest.mark.parametrize("flight", RADAR_DENSE)
def test_track_geometry_is_radar_dense(built, flight):
    """The RADES upgrade's point: geometry follows the surveyed returns, not
    the per-minute resample — even after decimation it must retain more shape
    than one vertex per minute (AA77's spiral alone is ~40 returns)."""
    _, positions, track = built[flight]
    assert len(track["geometry"]["coordinates"]) > len(positions)


def test_gofer06_is_an_observer_not_a_crash(built):
    data, positions, track = built["gofer06"]
    assert "impact" not in data
    assert track["landed_at"] is None and track["wheels_on_utc"] is None
    # fate text is curated but no impact instant is injected
    assert track["details"]["fate"]["text"]
    assert "utc" not in track["details"]["fate"]
    # airborne the whole track; ends aloft as it leaves analyzed coverage
    assert positions[-1]["alt_ft"] > 10000


def test_decimate_polyline_collapses_straight_keeps_turns():
    straight = [[float(x), 40.0] for x in range(-80, -70)]
    assert decimate_polyline(straight) == [straight[0], straight[-1]]
    # a square-wave detour must survive decimation
    detour = [[-80.0, 40.0], [-79.0, 40.0], [-79.0, 41.0], [-78.0, 41.0], [-78.0, 40.0], [-77.0, 40.0]]
    assert decimate_polyline(detour) == detour


@pytest.mark.parametrize("flight", CURATED_STEMS)
def test_positions_have_per_minute_clock_keys(built, flight):
    _, positions, _ = built[flight]
    # interior rows are whole minutes -> et_seconds multiples of 60 (clean airborne
    # snapshot); endpoints are pinned to the true takeoff/impact instants and may
    # be off-minute (AA77's first radar return is 12:19:58Z). clock_seconds
    # anchors at the prod BTS window start (2001-09-09 ET midnight), so a row sits
    # (flight_date - 2001-09-09) whole days into the replay clock — 172800 for the
    # 9/11 flights, matching every existing prod row (verified), and 86400 for
    # AF1's 9/10 positioning file.
    day = date.fromisoformat(positions[0]["flight_date"]) - date(2001, 9, 9)
    offset = 86400 * day.days
    for p in positions[1:-1]:
        assert p["et_seconds"] % 60 == 0
    for p in positions:
        assert p["clock_seconds"] == p["et_seconds"] + offset
        assert p["diverted"] is False


def test_airborne_at_T_window(built):
    """AA11 is aloft 11:59-12:46:40 UTC (et 28740-31600); not before/after."""
    _, positions, _ = built["aa11"]
    ets = {p["et_seconds"] for p in positions}
    assert 30600 in ets          # 12:30:00Z = 08:30 ET -> a row exists
    assert 28680 not in ets      # 11:58:00Z, before takeoff
    assert 31620 not in ets      # 12:47:00Z, after impact
    assert min(ets) == 28740 and max(ets) == 31600  # takeoff / impact pinned


def test_ua93_uses_corrected_shanksville_longitude(built):
    """Guards the flagged fix: crater is at 78deg54'17\"W = -78.90472, not the
    design doc's -78.8539 (~4 km east)."""
    data, _, track = built["ua93"]
    assert abs(data["impact"]["lon"] - (-78.90472)) < 1e-4
    assert track["geometry"]["coordinates"][-1][0] == pytest.approx(-78.90472, abs=1e-3)


# ------------------------------------------------------------------ scoped delete
class _FakeCursor:
    def __init__(self):
        self.calls = []

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        self.rowcount = 0


def test_scoped_delete_targets_only_the_four_ids_never_a_window():
    cur = _FakeCursor()
    notable.scoped_delete(cur, [(f, "2001-09-11") for f in notable.NOTABLE_FLIGHTS])
    assert len(cur.calls) == 2 * len(notable.NOTABLE_FLIGHTS)
    seen_flights = set()
    for sql, params in cur.calls:
        assert "flight_date = %s" in sql and "flight = %s" in sql
        assert "BETWEEN" not in sql and "_between" not in sql   # NOT a date window
        assert "ANY" not in sql                                 # NOT a bulk ID filter
        date_arg, flight = params
        assert date_arg == "2001-09-11"
        assert flight != "AA1002"                               # sentinel BTS flight
        seen_flights.add(flight)
    assert seen_flights == set(notable.NOTABLE_FLIGHTS)
    assert "flight_positions" in cur.calls[0][0]
    assert "flight_tracks" in cur.calls[1][0]


# ------------------------------------------------------------------ end-to-end (DB)
DSN = os.environ.get("NOTABLE_TEST_DSN")
requires_db = pytest.mark.skipif(not DSN, reason="set NOTABLE_TEST_DSN to a throwaway Postgres")


@pytest.fixture
def scratch_db():
    """Fresh scratch tables + a sentinel BTS flight AA1002 and a plain BTS flight."""
    import psycopg
    with psycopg.connect(DSN) as conn:
        with conn.cursor() as cur:
            cur.execute("DROP TABLE IF EXISTS flight_positions, flight_tracks, "
                        "reconstruction_runs")
            cur.execute(notable.LOCAL_SCHEMA_DDL)
            # sentinel BTS rows that MUST survive a scoped reload
            for et in range(30000, 30300, 60):
                cur.execute(
                    "INSERT INTO flight_positions (flight, carrier, flight_date, utc, "
                    "et_seconds, clock_seconds, lat, lon, alt_ft, phase, diverted, run_id) "
                    "VALUES ('AA1002','AA','2001-09-11','2001-09-11T12:00:00Z',%s,%s,"
                    "40,-90,35000,'cruise',false,'bts-seed')", (et, et))
            cur.execute(
                "INSERT INTO flight_positions (flight, carrier, flight_date, utc, "
                "et_seconds, clock_seconds, lat, lon, alt_ft, phase, diverted, run_id) "
                "VALUES ('DL2000','DL','2001-09-11','2001-09-11T12:00:00Z',30000,30000,"
                "41,-91,35000,'cruise',false,'bts-seed')")
            cur.execute(
                "INSERT INTO flight_tracks (flight, flight_date, origin, scheduled_dest, "
                "diverted, run_id, geometry) VALUES ('AA1002','2001-09-11','JFK','LAX',"
                "false,'bts-seed','{\"type\":\"LineString\",\"coordinates\":[[0,0],[1,1]]}')")
        conn.commit()
    yield DSN


def _counts(dsn):
    import psycopg
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM flight_positions WHERE flight='AA1002'")
        aa1002_pos = cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM flight_positions WHERE flight != ALL(%s)",
                    (list(notable.NOTABLE_FLIGHTS),))
        bts_pos = cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM flight_tracks WHERE flight='AA1002'")
        aa1002_trk = cur.fetchone()[0]
        cur.execute("SELECT flight, count(*) FROM flight_positions WHERE flight = ANY(%s) "
                    "GROUP BY flight", (list(notable.NOTABLE_FLIGHTS),))
        notable_pos = dict(cur.fetchall())
    return aa1002_pos, bts_pos, aa1002_trk, notable_pos


@requires_db
def test_end_to_end_scoped_idempotency(scratch_db):
    base = _counts(scratch_db)          # (aa1002_pos, bts_pos, aa1002_trk, notable_pos)
    assert base[0] == 5 and base[1] == 6 and base[2] == 1 and base[3] == {}

    first = notable.run(scratch_db, dry_run=False)
    assert first["flights"] == CURATED_FILE_COUNT
    after1 = _counts(scratch_db)
    # every curated flight loaded; sentinel + BTS counts identical to the seed
    assert set(after1[3]) == set(notable.NOTABLE_FLIGHTS)
    assert (after1[0], after1[1], after1[2]) == (base[0], base[1], base[2])

    # re-run: scoped delete removes ONLY the curated set, re-inserts -> no dupes,
    # sentinel safe
    second = notable.run(scratch_db, dry_run=False)
    assert second["positions_deleted"] == first["positions"]   # deleted exactly its own
    after2 = _counts(scratch_db)
    assert after2 == after1
    assert (after2[0], after2[1], after2[2]) == (5, 6, 1)      # AA1002 + BTS untouched


@requires_db
def test_dry_run_persists_nothing(scratch_db):
    base = _counts(scratch_db)
    summary = notable.run(scratch_db, dry_run=True)
    assert summary["dry_run"] is True and summary["flights"] == CURATED_FILE_COUNT
    assert _counts(scratch_db) == base    # rolled back


# ------------------------------------------------------------------ details/metadata
@pytest.mark.parametrize("flight", CURATED_STEMS)
def test_tracks_carry_aircraft_and_registration(built, flight):
    data, _, track = built[flight]
    assert track["tail_number"] == data["registration"]
    maker = "Lockheed " if flight == "gofer06" else "Boeing "
    assert track["aircraft_type"].startswith(maker), track["aircraft_type"]


@pytest.mark.parametrize("flight", HIJACKED)
def test_details_souls_are_internally_consistent(built, flight):
    _, _, track = built[flight]
    s = track["details"]["souls"]
    assert s["passengers"] + s["crew"] + s["hijackers"] == s["total"]
    assert len(track["details"]["hijackers"]) == s["hijackers"]


def test_fate_utc_is_injected_from_impact(built):
    # AA11's documented impact instant; the JSON's details.fate has no utc key
    _, _, aa11 = built["aa11"]
    assert aa11["details"]["fate"]["utc"] == "2001-09-11T12:46:40Z"
    for flight in HIJACKED:
        data, _, track = built[flight]
        assert track["details"]["fate"]["utc"] == data["impact"]["utc"], flight
        assert track["details"]["fate"]["text"], f"{flight}: fate.text missing"


# ------------------------------------------------------------------ AF1: per-file
# dates, ground spans, landing fields, per-position source
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


@requires_db
def test_scoped_delete_pairs_only_touch_their_dates(scratch_db):
    """Deleting one (flight, flight_date) pair must leave that same flight on
    a different date, and a different flight sharing that date, untouched —
    mirrors scratch_db's own AA1002-sentinel setup in
    test_end_to_end_scoped_idempotency, but scoped per-pair rather than
    per-flight-id-set."""
    import psycopg
    with psycopg.connect(scratch_db) as conn:
        with conn.cursor() as cur:
            for flight, fdate in (("AF1", "2001-09-10"), ("AF1", "2001-09-11"),
                                   ("AA1002", "2001-09-10"), ("AA1002", "2001-09-11")):
                cur.execute(
                    "INSERT INTO flight_positions (flight, carrier, flight_date, utc, "
                    "et_seconds, clock_seconds, lat, lon, alt_ft, phase, diverted, run_id) "
                    "VALUES (%s,%s,%s,%s,30000,30000,40,-90,35000,'cruise',false,'seed')",
                    (flight, flight[:2], fdate, f"{fdate}T12:00:00Z"))
                cur.execute(
                    "INSERT INTO flight_tracks (flight, flight_date, origin, scheduled_dest, "
                    "diverted, run_id, geometry) VALUES (%s,%s,'JFK','LAX',false,'seed',"
                    "'{\"type\":\"LineString\",\"coordinates\":[[0,0],[1,1]]}')",
                    (flight, fdate))
        conn.commit()

        with conn.cursor() as cur:
            pos_del, trk_del = notable.scoped_delete(cur, [("AF1", "2001-09-10")])
        conn.commit()
        assert (pos_del, trk_del) == (1, 1)

        with conn.cursor() as cur:
            cur.execute("SELECT flight, flight_date::text FROM flight_positions "
                        "WHERE flight = ANY(%s)", (["AF1", "AA1002"],))
            remaining_pos = set(cur.fetchall())
            cur.execute("SELECT flight, flight_date::text FROM flight_tracks "
                        "WHERE flight = ANY(%s)", (["AF1", "AA1002"],))
            remaining_trk = set(cur.fetchall())

    assert ("AF1", "2001-09-10") not in remaining_pos
    assert ("AF1", "2001-09-10") not in remaining_trk
    assert ("AF1", "2001-09-11") in remaining_pos
    assert ("AF1", "2001-09-11") in remaining_trk
    assert ("AA1002", "2001-09-10") in remaining_pos
    assert ("AA1002", "2001-09-10") in remaining_trk
    assert ("AA1002", "2001-09-11") in remaining_pos
    assert ("AA1002", "2001-09-11") in remaining_trk


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


def test_af1_geometry_keeps_leg1_radar_returns():
    """AF1's day is too long for the whole-track density invariant (see
    RADAR_DENSE), but the radar-surveyed Sarasota->Barksdale leg must still
    survive decimation as real shape rather than collapsing to its endpoints."""
    _, d0911 = _load_af1()
    _, track = build_flight(d0911)
    verts = {tuple(c) for c in track["geometry"]["coordinates"]}
    radar = [w for w in d0911["waypoints"] if w.get("source") == "radar"]
    assert len(radar) == 97, "leg 1 carries the exported RADES track verbatim"
    kept = [w for w in radar if (round(w["lon"], 5), round(w["lat"], 5)) in verts]
    assert len(kept) > len(radar) // 2


def test_af1_waypoint_provenance_is_marked_and_legs_are_estimated():
    """Every AF1 waypoint carries an explicit source mark; only leg 1 of the
    9/11 file is radar, and the 9/10 positioning file is wholly estimated."""
    d0910, d0911 = _load_af1()
    assert {w["source"] for w in d0910["waypoints"]} == {"estimated"}
    assert {w["source"] for w in d0911["waypoints"]} == {"radar", "estimated"}
    p0, _ = build_flight(d0910)
    p1, _ = build_flight(d0911)
    assert {p["source"] for p in p0} == {"estimated"}
    assert {p["source"] for p in p1} == {"radar", "estimated"}
    # the radar-marked positions cover exactly the leg-1 window. The resample
    # grid is whole minutes (only the very first/last waypoints of a track are
    # pinned off-minute), so the marked run starts at the first whole minute
    # inside the radar span (13:54:41Z) and ends at the last one before it
    # closes (15:32:02Z).
    radar_utc = sorted(p["utc"] for p in p1 if p["source"] == "radar")
    assert radar_utc[0] == "2001-09-11T13:55:00Z"
    assert radar_utc[-1] == "2001-09-11T15:32:00Z"
    assert len(radar_utc) == 98


def test_af1_wheels_times_match_the_researched_anchors():
    d0910, d0911 = _load_af1()
    # 9/10 positioning: derived estimates, three-leg ADW -> Jacksonville -> SRQ
    assert (d0910["origin"], d0910["scheduled_dest"], d0910["landed_at"]) == (
        "ADW", "SRQ", "SRQ")
    assert d0910["wheels_off_utc"] == "2001-09-10T18:00:00Z"
    assert d0910["wheels_on_utc"] == "2001-09-10T21:30:00Z"
    assert [s["code"] for s in d0910["details"]["ground_stops"]] == ["NIP", "SRQ"]
    # 9/11: sourced anchors — 09:54 ET off SRQ, 18:34 ET on at Andrews
    assert (d0911["origin"], d0911["scheduled_dest"], d0911["landed_at"]) == (
        "SRQ", "ADW", "ADW")
    assert d0911["wheels_off_utc"] == "2001-09-11T13:54:00Z"
    assert d0911["wheels_on_utc"] == "2001-09-11T22:34:00Z"
    stops = {s["code"]: s for s in d0911["details"]["ground_stops"]}
    assert stops["BAD"]["start"] == "2001-09-11T15:45:00Z"   # Commission "about 11:45"
    assert stops["BAD"]["end"] == "2001-09-11T17:44:00Z"     # 13:44 ET, chosen mid-range
    assert stops["OFF"]["start"] == "2001-09-11T18:50:00Z"   # 14:50 ET, well corroborated
    assert stops["OFF"]["end"] == "2001-09-11T20:33:00Z"     # 16:33 ET
    assert d0911["details"]["fate"]["utc"] == d0911["wheels_on_utc"]
    assert d0911["details"]["crew"]["captain"] == "Col. Mark Tillman"


def test_af1_leg1_cruise_is_fl390_not_45000():
    """Radar refuted the widely-repeated 45,000 ft for the Sarasota->Barksdale
    leg; only the Offutt->Andrews leg is modelled at 45,000 ft."""
    _, d0911 = _load_af1()
    radar = [w for w in d0911["waypoints"] if w["source"] == "radar"]
    assert max(w["alt_ft"] for w in radar) == 39000
    p1, _ = build_flight(d0911)
    # loader bound is 45,000 ft inclusive — nothing may exceed it
    assert max(p["alt_ft"] for p in p1) == 45000
    top = [p["utc"] for p in p1 if p["alt_ft"] == 45000]
    assert top[0] > "2001-09-11T20:33:00Z"   # after the Offutt departure
