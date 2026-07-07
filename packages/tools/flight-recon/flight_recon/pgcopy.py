"""
Direct-Postgres fast path for flight_positions.

The Directus items API tops out around 300 rows/s on rt911-api even with
activity logging disabled — a 4-day window (~3.5M position rows) would take
hours. Positions are bulk time-series data with no Directus-side hooks, so
(matching how the 447k-row pager tables were loaded) they go straight into
the table Directus already manages, via COPY. Directus reads them exactly as
if they'd come through the API. Tracks and the run ledger still use the
items API.

Also creates the replay-clock query indexes — Directus doesn't manage
indexes, and without them the site's airborne-set lookup
(flight_date + et_seconds) seq-scans millions of rows.
"""

import logging

import psycopg

log = logging.getLogger(__name__)

COLUMNS = ["flight", "carrier", "flight_date", "utc", "et_seconds", "clock_seconds",
           "lat", "lon", "alt_ft", "phase", "diverted", "run_id"]

INDEXES = [
    ("idx_flight_positions_date_et",
     "CREATE INDEX IF NOT EXISTS idx_flight_positions_date_et "
     "ON flight_positions (flight_date, et_seconds)"),
    ("idx_flight_positions_clock",
     "CREATE INDEX IF NOT EXISTS idx_flight_positions_clock "
     "ON flight_positions (clock_seconds)"),
]


def copy_positions(dsn, positions, run_id, start, end):
    """Delete-window then COPY-insert positions. Returns (deleted, inserted)."""
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM flight_positions WHERE flight_date BETWEEN %s AND %s",
                (str(start), str(end)))
            deleted = cur.rowcount
            if deleted:
                log.warning("idempotent reload: deleted %d flight_positions rows in "
                            "[%s, %s] before COPY", deleted, start, end)
            with cur.copy(
                    f"COPY flight_positions ({', '.join(COLUMNS)}) FROM STDIN") as copy:
                for p in positions:
                    copy.write_row([
                        p["flight"], p["carrier"], p["flight_date"], p["utc"],
                        p["et_seconds"], p["clock_seconds"], p["lat"], p["lon"],
                        p["alt_ft"], p["phase"], p["diverted"], run_id,
                    ])
            for name, ddl in INDEXES:
                cur.execute(ddl)
                log.info("ensured index %s", name)
        conn.commit()
    return deleted, len(positions)
