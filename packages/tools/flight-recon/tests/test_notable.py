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
from pathlib import Path

import pytest

from flight_recon import notable
from flight_recon.notable import NOTABLE_FLIGHTS, build_all
from flight_recon.resample import decimate_polyline, parse_utc, resample_track

DATA_DIR = Path(__file__).parent.parent / "data" / "notable_flights"

# The four crashed flights (documented impact); GOFER06 is the observer.
HIJACKED = ("AA11", "UA175", "AA77", "UA93")

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
    """Every notable flight built from its real curated data file."""
    out = {}
    for path in DATA_DIR.glob("*.json"):
        data = notable.load_flight_file(path)
        out[data["flight"]] = (data, *notable.build_flight(data))
    return out


def test_all_five_flights_present(built):
    assert set(built) == set(notable.NOTABLE_FLIGHTS)


@pytest.mark.parametrize("flight", notable.NOTABLE_FLIGHTS)
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


@pytest.mark.parametrize("flight", notable.NOTABLE_FLIGHTS)
def test_track_geometry_is_radar_dense(built, flight):
    """The RADES upgrade's point: geometry follows the surveyed returns, not
    the per-minute resample — even after decimation it must retain more shape
    than one vertex per minute (AA77's spiral alone is ~40 returns)."""
    _, positions, track = built[flight]
    assert len(track["geometry"]["coordinates"]) > len(positions)


def test_gofer06_is_an_observer_not_a_crash(built):
    data, positions, track = built["GOFER06"]
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


@pytest.mark.parametrize("flight", notable.NOTABLE_FLIGHTS)
def test_positions_have_per_minute_clock_keys(built, flight):
    _, positions, _ = built[flight]
    # interior rows are whole minutes -> et_seconds multiples of 60 (clean airborne
    # snapshot); endpoints are pinned to the true takeoff/impact instants and may
    # be off-minute (AA77's first radar return is 12:19:58Z). clock_seconds
    # anchors at the prod BTS window start (2001-09-09 ET midnight), so 9/11 rows
    # sit exactly two days into the replay clock — matching every existing prod
    # row (clock_seconds - et_seconds = 172800, verified).
    for p in positions[1:-1]:
        assert p["et_seconds"] % 60 == 0
    for p in positions:
        assert p["clock_seconds"] == p["et_seconds"] + 172800
        assert p["diverted"] is False


def test_airborne_at_T_window(built):
    """AA11 is aloft 11:59-12:46:40 UTC (et 28740-31600); not before/after."""
    _, positions, _ = built["AA11"]
    ets = {p["et_seconds"] for p in positions}
    assert 30600 in ets          # 12:30:00Z = 08:30 ET -> a row exists
    assert 28680 not in ets      # 11:58:00Z, before takeoff
    assert 31620 not in ets      # 12:47:00Z, after impact
    assert min(ets) == 28740 and max(ets) == 31600  # takeoff / impact pinned


def test_ua93_uses_corrected_shanksville_longitude(built):
    """Guards the flagged fix: crater is at 78deg54'17\"W = -78.90472, not the
    design doc's -78.8539 (~4 km east)."""
    data, _, track = built["UA93"]
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
    notable.scoped_delete(cur)
    assert len(cur.calls) == 2
    for sql, params in cur.calls:
        assert "flight_date = %s" in sql and "flight = ANY(%s)" in sql
        assert "BETWEEN" not in sql and "_between" not in sql   # NOT a date window
        date_arg, ids = params
        assert date_arg == "2001-09-11"
        assert ids == list(notable.NOTABLE_FLIGHTS)
        assert "AA1002" not in ids                              # sentinel BTS flight
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
    assert first["flights"] == 5
    after1 = _counts(scratch_db)
    # five flights loaded; sentinel + BTS counts identical to the seed
    assert set(after1[3]) == set(notable.NOTABLE_FLIGHTS)
    assert (after1[0], after1[1], after1[2]) == (base[0], base[1], base[2])

    # re-run: scoped delete removes ONLY the five, re-inserts -> no dupes, sentinel safe
    second = notable.run(scratch_db, dry_run=False)
    assert second["positions_deleted"] == first["positions"]   # deleted exactly its own
    after2 = _counts(scratch_db)
    assert after2 == after1
    assert (after2[0], after2[1], after2[2]) == (5, 6, 1)      # AA1002 + BTS untouched


@requires_db
def test_dry_run_persists_nothing(scratch_db):
    base = _counts(scratch_db)
    summary = notable.run(scratch_db, dry_run=True)
    assert summary["dry_run"] is True and summary["flights"] == 5
    assert _counts(scratch_db) == base    # rolled back


# ------------------------------------------------------------------ details/metadata
@pytest.mark.parametrize("flight", notable.NOTABLE_FLIGHTS)
def test_tracks_carry_aircraft_and_registration(built, flight):
    data, _, track = built[flight]
    assert track["tail_number"] == data["registration"]
    maker = "Lockheed " if flight == "GOFER06" else "Boeing "
    assert track["aircraft_type"].startswith(maker), track["aircraft_type"]


@pytest.mark.parametrize("flight", HIJACKED)
def test_details_souls_are_internally_consistent(built, flight):
    _, _, track = built[flight]
    s = track["details"]["souls"]
    assert s["passengers"] + s["crew"] + s["hijackers"] == s["total"]
    assert len(track["details"]["hijackers"]) == s["hijackers"]


def test_fate_utc_is_injected_from_impact(built):
    # AA11's documented impact instant; the JSON's details.fate has no utc key
    _, _, aa11 = built["AA11"]
    assert aa11["details"]["fate"]["utc"] == "2001-09-11T12:46:40Z"
    for flight in HIJACKED:
        data, _, track = built[flight]
        assert track["details"]["fate"]["utc"] == data["impact"]["utc"], flight
        assert track["details"]["fate"]["text"], f"{flight}: fate.text missing"
