"""
Load the four notable September 11, 2001 flights (AA11, UA175, AA77, UA93) into
the same ``flight_positions`` / ``flight_tracks`` / ``reconstruction_runs`` tables
the BTS reconstruction writes, so they appear on the streamer ``flights`` channel
and in the Flight Tracker exactly like the 1,945 BTS-derived flights.

These four are absent from BTS On-Time Performance (which records only completed
flights) and are curated from authoritative public radar data — each flight's
NTSB Flight Path Study (2002-02-19), corroborated by the 9/11 Commission Report
(Ch. 1). The reviewable accuracy artifact is ``data/notable_flights/*.json``;
this module only resamples, validates, and loads them.

CRITICAL — scoped idempotency
-----------------------------
Re-running deletes ONLY these four flight IDs for ``flight_date='2001-09-11'``
before re-inserting. It must NOT reuse the BTS loader's delete-by-``flight_date``
window (``pgcopy.copy_positions`` / ``directus.delete_window``), which would wipe
the 1,945 real flights that share that date. A sentinel BTS flight (e.g. AA1002)
and the BTS row count must survive a re-run untouched.

This is a standalone one-time load (a fixed curated set), not a repeatable BTS
Prefect flow, so it is a plain CLI::

    python -m flight_recon.notable --dsn postgres://... [--dry-run] [--init-schema]

``--dry-run`` builds, validates, and exercises the delete/insert inside a
transaction it then ROLLS BACK — nothing is persisted. Loading synthesized 9/11
flight paths to prod is gated on human review of the data files + a dry-run
report (see the design doc's PROD-LOAD REVIEW GATE).
"""

import argparse
import glob
import json
import logging
import os
import uuid
from datetime import datetime, timezone

import psycopg
from psycopg.types.json import Json

from flight_recon.pgcopy import COLUMNS as POSITION_COLUMNS
from flight_recon.resample import fmt_utc, parse_utc, resample_track
from reconstruct import ET_OFFSET, et_seconds

log = logging.getLogger(__name__)

FLIGHT_DATE = "2001-09-11"
NOTABLE_FLIGHTS = ("AA11", "UA175", "AA77", "UA93")
DATA_DIR = os.path.join(os.path.dirname(__file__), os.pardir, "data", "notable_flights")

# clock_seconds anchor: continuous seconds since ET midnight of the loaded BTS
# window's FIRST day — not of flight_date. Every prod run in reconstruction_runs
# used [2001-09-09, 2001-09-12], and every prod 9/11 position row has
# clock_seconds = et_seconds + 172800 (verified 2026-07-08); anchoring anywhere
# else would put these four on a different replay clock than the BTS flights.
_WINDOW_START_UTC = datetime(2001, 9, 9, -ET_OFFSET, 0, 0, tzinfo=timezone.utc)

# Validation bounds (match the BTS loader's North-America envelope).
_LON_MIN, _LON_MAX = -150.0, -65.0
_LAT_MIN, _LAT_MAX = 18.0, 65.0
_ALT_MIN, _ALT_MAX = 0, 45000
_IMPACT_TOL_DEG = 1e-3   # last track vertex vs documented impact (~110 m)

# Scratch-DB schema, matching the column shapes Directus manages in prod
# (flight_recon/directus.py COLLECTIONS). ONLY for --init-schema against a
# throwaway/staging Postgres — prod tables are created by the Directus flow.
LOCAL_SCHEMA_DDL = """
CREATE TABLE IF NOT EXISTS flight_positions (
    id            serial PRIMARY KEY,
    flight        varchar NOT NULL,
    carrier       varchar,
    flight_date   date NOT NULL,
    utc           timestamptz,
    et_seconds    integer NOT NULL,
    clock_seconds integer NOT NULL,
    lat           double precision,
    lon           double precision,
    alt_ft        integer,
    phase         varchar,
    diverted      boolean,
    run_id        varchar NOT NULL
);
CREATE TABLE IF NOT EXISTS flight_tracks (
    id             serial PRIMARY KEY,
    flight         varchar NOT NULL,
    flight_date    date NOT NULL,
    origin         varchar,
    scheduled_dest varchar,
    landed_at      varchar,
    diverted       boolean,
    wheels_off_utc timestamptz,
    wheels_on_utc  timestamptz,
    geometry       json,
    run_id         varchar NOT NULL
);
CREATE TABLE IF NOT EXISTS reconstruction_runs (
    run_id                 varchar PRIMARY KEY,
    start                  date,
    "end"                  date,
    source_file            varchar,
    flights_reconstructed  integer,
    positions_count        integer,
    tracks_count           integer,
    skipped_count          integer,
    skipped                json,
    skipped_by_reason      json,
    cancelled_by_day       json,
    created_at             timestamptz DEFAULT now()
);
"""

TRACK_COLUMNS = ["flight", "flight_date", "origin", "scheduled_dest", "landed_at",
                 "diverted", "wheels_off_utc", "wheels_on_utc", "geometry", "run_id"]


# ----------------------------------------------------------------- pure build
def load_flight_file(path):
    with open(path) as fh:
        return json.load(fh)


def build_flight(data):
    """Resample one curated flight into (positions rows, track row) and validate.

    ``positions`` are ``flight_positions`` dicts sans ``run_id`` (added at load);
    ``track`` is a ``flight_tracks`` dict whose ``geometry`` is a GeoJSON
    LineString. Raises ValueError on any integrity violation."""
    flight = data["flight"]
    samples = resample_track(data["waypoints"])

    positions, coords, prev_min = [], [], None
    for s in samples:
        utc = s["utc"]
        if not (_LAT_MIN <= s["lat"] <= _LAT_MAX and _LON_MIN <= s["lon"] <= _LON_MAX):
            raise ValueError(f"{flight}: position out of NA bounds: {s['lat']},{s['lon']}")
        if not (_ALT_MIN <= s["alt_ft"] <= _ALT_MAX):
            raise ValueError(f"{flight}: alt_ft {s['alt_ft']} out of [0, 45000]")
        minute = utc.replace(second=0, microsecond=0)
        if prev_min is not None and minute <= prev_min:
            raise ValueError(f"{flight}: non-increasing minute bucket at {utc}")
        prev_min = minute
        positions.append({
            "flight": flight, "carrier": data["carrier"], "flight_date": FLIGHT_DATE,
            "utc": fmt_utc(utc),
            "et_seconds": et_seconds(utc),
            "clock_seconds": int((utc - _WINDOW_START_UTC).total_seconds()),
            "lat": s["lat"], "lon": s["lon"], "alt_ft": s["alt_ft"],
            "phase": s["phase"], "diverted": False,
        })
        coords.append([s["lon"], s["lat"]])

    # per-minute coverage: every minute in [takeoff, impact] present exactly once
    first_min = parse_utc(positions[0]["utc"]).replace(second=0, microsecond=0)
    last_min = samples[-1]["utc"].replace(second=0, microsecond=0)
    want = int((last_min - first_min).total_seconds() // 60) + 1
    if len(positions) != want:
        raise ValueError(f"{flight}: expected {want} per-minute rows, got {len(positions)}")

    imp = data["impact"]
    last = coords[-1]
    if abs(last[0] - imp["lon"]) > _IMPACT_TOL_DEG or abs(last[1] - imp["lat"]) > _IMPACT_TOL_DEG:
        raise ValueError(f"{flight}: track end {last} != impact ({imp['lon']},{imp['lat']})")

    track = {
        "flight": flight, "flight_date": FLIGHT_DATE, "origin": data["origin"],
        "scheduled_dest": data["scheduled_dest"], "landed_at": None,
        "diverted": False, "wheels_off_utc": positions[0]["utc"],
        "wheels_on_utc": None,
        "geometry": {"type": "LineString", "coordinates": coords},
    }
    return positions, track


def build_all(data_dir=DATA_DIR):
    """Build every notable flight found in ``data_dir``. Returns (positions, tracks)."""
    files = sorted(glob.glob(os.path.join(data_dir, "*.json")))
    if not files:
        raise FileNotFoundError(f"no notable-flight JSON files in {data_dir}")
    all_positions, all_tracks, seen = [], [], set()
    for path in files:
        data = load_flight_file(path)
        if data["flight"] not in NOTABLE_FLIGHTS:
            raise ValueError(f"{path}: flight {data['flight']} not in {NOTABLE_FLIGHTS}")
        seen.add(data["flight"])
        positions, track = build_flight(data)
        all_positions.extend(positions)
        all_tracks.append(track)
        log.info("built %s: %d positions", data["flight"], len(positions))
    missing = set(NOTABLE_FLIGHTS) - seen
    if missing:
        log.warning("notable-flight files missing for: %s", sorted(missing))
    return all_positions, all_tracks


# ----------------------------------------------------------------- db writes
def scoped_delete(cur, flights=NOTABLE_FLIGHTS, flight_date=FLIGHT_DATE):
    """Delete ONLY the given flight IDs on ``flight_date`` — never a date window.

    Returns (positions_deleted, tracks_deleted)."""
    ids = list(flights)
    cur.execute("DELETE FROM flight_positions WHERE flight_date = %s AND flight = ANY(%s)",
                (flight_date, ids))
    pos = cur.rowcount
    cur.execute("DELETE FROM flight_tracks WHERE flight_date = %s AND flight = ANY(%s)",
                (flight_date, ids))
    trk = cur.rowcount
    log.info("scoped delete: %d positions, %d tracks for %s on %s", pos, trk, ids, flight_date)
    return pos, trk


def copy_positions(cur, positions, run_id):
    with cur.copy(f"COPY flight_positions ({', '.join(POSITION_COLUMNS)}) FROM STDIN") as cp:
        for p in positions:
            cp.write_row([p["flight"], p["carrier"], p["flight_date"], p["utc"],
                          p["et_seconds"], p["clock_seconds"], p["lat"], p["lon"],
                          p["alt_ft"], p["phase"], p["diverted"], run_id])
    return len(positions)


def insert_tracks(cur, tracks, run_id):
    placeholders = ", ".join(["%s"] * len(TRACK_COLUMNS))
    sql = f"INSERT INTO flight_tracks ({', '.join(TRACK_COLUMNS)}) VALUES ({placeholders})"
    for t in tracks:
        cur.execute(sql, (t["flight"], t["flight_date"], t["origin"], t["scheduled_dest"],
                          t["landed_at"], t["diverted"], t["wheels_off_utc"],
                          t["wheels_on_utc"], Json(t["geometry"]), run_id))
    return len(tracks)


def insert_run(cur, run_id, positions_count, tracks_count):
    """Append one provenance row citing the NTSB studies (append-only ledger)."""
    source = ("NTSB Flight Path Studies (2002-02-19) for AA11, UA175, AA77, UA93 + "
              "9/11 Commission Report Ch.1 — curated notable_flights load")
    cur.execute(
        'INSERT INTO reconstruction_runs (run_id, start, "end", source_file, '
        "flights_reconstructed, positions_count, tracks_count, skipped_count, "
        "skipped, skipped_by_reason, cancelled_by_day, created_at) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        (run_id, FLIGHT_DATE, FLIGHT_DATE, source, tracks_count, positions_count,
         tracks_count, 0, Json([]), Json({}), Json({}),
         datetime.now(timezone.utc)))


# ----------------------------------------------------------------- orchestration
def run(dsn, data_dir=DATA_DIR, dry_run=False, init_schema=False, run_id=None):
    run_id = run_id or f"notable-{uuid.uuid4().hex[:12]}"
    positions, tracks = build_all(data_dir)
    log.info("built %d flights: %d positions, %d tracks (run_id=%s)",
             len(tracks), len(positions), len(tracks), run_id)

    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            if init_schema:
                cur.execute(LOCAL_SCHEMA_DDL)
                log.warning("ensured scratch schema (flight_positions/tracks/runs)")
            pos_del, trk_del = scoped_delete(cur)
            n_pos = copy_positions(cur, positions, run_id)
            n_trk = insert_tracks(cur, tracks, run_id)
            insert_run(cur, run_id, n_pos, n_trk)
        if dry_run:
            conn.rollback()
            log.warning("DRY RUN: rolled back — nothing persisted")
        else:
            conn.commit()
            log.warning("committed %d positions + %d tracks + 1 run (run_id=%s)",
                        n_pos, n_trk, run_id)

    return {"run_id": run_id, "flights": len(tracks), "positions": n_pos,
            "tracks": n_trk, "positions_deleted": pos_del, "tracks_deleted": trk_del,
            "dry_run": dry_run}


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--dsn", default=os.environ.get("RT911_DB_DSN"),
                   help="Postgres DSN (default $RT911_DB_DSN). NEVER a prod DSN without review.")
    p.add_argument("--data-dir", default=DATA_DIR)
    p.add_argument("--dry-run", action="store_true",
                   help="build + validate + exercise delete/insert, then ROLL BACK")
    p.add_argument("--init-schema", action="store_true",
                   help="create flight_positions/tracks/runs if missing (scratch DBs only)")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING,
                        format="%(levelname)s %(message)s")
    if not args.dsn:
        p.error("no DSN: pass --dsn or set $RT911_DB_DSN")

    summary = run(args.dsn, args.data_dir, dry_run=args.dry_run, init_schema=args.init_schema)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
