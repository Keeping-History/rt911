"""
Load 84 RADES radar tracks into Directus-managed tables — stories 1 and 2 of
``plans/2026-07-29-radar-tracks-load-design.md`` (#262/#263).

- **Story 1 (named upgrade):** the verified-tier flights get their
  great-circle reconstructions replaced by real radar tracks. The existing
  ``flight_tracks`` row's metadata is PRESERVED (origin, dest, tail, times,
  landed_at, details) — only geometry, positions, ``details.track_source``,
  and ``run_id`` change. Guard: the prod row's ``wheels_off_utc`` must agree
  with the BTS leg the matcher named (multi-leg flight numbers exist);
  mismatches are skipped and reported.
- **Story 2 (diverted restoration):** the verified diverted flights are
  ABSENT from prod (BTS pre-2003 has no diversion landing detail). They are
  added with ``diverted = true`` and ``landed_at`` = the radar-derived
  landing airport. Guard: if the id already exists (another leg of the same
  number), skip and report.

Chain points are cleaned before resampling (multi-site jitter thinning,
lateral-deviation spike drop, Mode C garble blanking, altitude
interpolation) — the same physics as the notable extractor, generalized.

CRITICAL — scoped idempotency: deletes are by the exact flight-id list for
``flight_date='2001-09-11'`` (never a window), so the 1,945 BTS flights and
the 5 curated notables are untouched. The curated notables are NEVER in the
tier (positional control) and are additionally hard-excluded here.

    python -m flight_recon.rades_load --dsn ... --stitched stitched.pkl \
        [--tier data/rades/verified_tier.json] [--dry-run] [--init-schema]

PROD-LOAD REVIEW GATE: as with the notables, loading to prod requires human
review of the tier artifact + a dry-run report first.
"""

import argparse
import json
import logging
import math
import os
import pickle
import uuid
from datetime import datetime, timedelta, timezone

import psycopg
from psycopg.types.json import Json

from flight_recon.notable import (
    FLIGHT_DATE, LOCAL_SCHEMA_DDL, _WINDOW_START_UTC,
    copy_positions, insert_tracks,
)
from flight_recon.resample import decimate_polyline, fmt_utc, resample_track
from reconstruct import ET_OFFSET, et_seconds  # noqa: F401  (ET_OFFSET re-exported)

log = logging.getLogger(__name__)

DAY = datetime(2001, 9, 11, tzinfo=timezone.utc)
NOTABLE_IDS = {"AA11", "UA175", "AA77", "UA93", "GOFER06"}

MIN_SPACING_S = 5.0
DEVIATION_NM = 1.2
DEVIATION_MAX_SPAN_S = 90.0
MODEC_JUMP_FT = 2500.0
ALT_MAX_FT = 45000
LANDING_AP_NM = 8.0


def dist_nm(a1, o1, a2, o2):
    return math.hypot((a1 - a2) * 60, (o1 - o2) * 60 * math.cos(math.radians((a1 + a2) / 2)))


# ------------------------------------------------------------------ cleaning
def clean_chain(pts):
    """Multi-site radar chain -> strictly-increasing cleaned points.

    (secs, lat, lon, mc_ft_or_None). Thin to MIN_SPACING_S, drop lateral
    spikes vs the neighbor interpolation, blank garbled Mode C, then fill
    altitude by linear interpolation (edges clamp)."""
    pts = sorted(pts, key=lambda p: p[0])
    thinned = []
    for p in pts:
        if thinned and p[0] - thinned[-1][0] < MIN_SPACING_S:
            continue
        alt = p[3]
        thinned.append([p[0], p[1], p[2], None if alt is None or alt != alt else float(alt)])
    # iterative lateral spike removal
    changed = True
    while changed and len(thinned) > 2:
        changed = False
        worst, worst_dev = None, DEVIATION_NM
        for i in range(1, len(thinned) - 1):
            a, c, b = thinned[i - 1], thinned[i], thinned[i + 1]
            span = b[0] - a[0]
            if span <= 0 or span > DEVIATION_MAX_SPAN_S:
                continue
            f = (c[0] - a[0]) / span
            dev = dist_nm(c[1], c[2], a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2]))
            if dev > worst_dev:
                worst, worst_dev = i, dev
        if worst is not None:
            del thinned[worst]
            changed = True
    # Mode C garble: blank values jumping off the neighbor median
    idx = [i for i, p in enumerate(thinned) if p[3] is not None]
    orig = {i: thinned[i][3] for i in idx}
    for k, i in enumerate(idx):
        neigh = [orig[j] for j in idx[max(0, k - 2):k] + idx[k + 1:k + 3]]
        if len(neigh) >= 2:
            med = sorted(neigh)[len(neigh) // 2]
            if abs(orig[i] - med) > MODEC_JUMP_FT or orig[i] > ALT_MAX_FT:
                thinned[i][3] = None
    # altitude interpolation across blanks (edges clamp)
    known = [(p[0], p[3]) for p in thinned if p[3] is not None]
    if not known:
        return []
    for p in thinned:
        if p[3] is None:
            if p[0] <= known[0][0]:
                p[3] = known[0][1]
            elif p[0] >= known[-1][0]:
                p[3] = known[-1][1]
            else:
                for (x0, y0), (x1, y1) in zip(known, known[1:]):
                    if x0 <= p[0] <= x1:
                        f = 0.0 if x1 == x0 else (p[0] - x0) / (x1 - x0)
                        p[3] = y0 + f * (y1 - y0)
                        break
    return thinned


def chain_waypoints(pts):
    """Cleaned points -> the resample_track waypoint contract (whole seconds,
    strictly increasing)."""
    wps, seen = [], set()
    for t, lat, lon, alt in pts:
        s = int(round(t))
        if s in seen:
            continue
        seen.add(s)
        wps.append({"utc": fmt_utc(DAY + timedelta(seconds=s)),
                    "lat": round(lat, 5), "lon": round(lon, 5),
                    "alt_ft": max(0, min(int(round(alt)), ALT_MAX_FT))})
    return wps


def build_rows(flight, carrier, wps, diverted):
    """Waypoints -> (positions rows, dense geometry) via the per-minute core."""
    samples = resample_track(wps)
    positions, coords = [], {}
    for s in samples:
        positions.append({
            "flight": flight, "carrier": carrier, "flight_date": FLIGHT_DATE,
            "utc": fmt_utc(s["utc"]), "et_seconds": et_seconds(s["utc"]),
            "clock_seconds": int((s["utc"] - _WINDOW_START_UTC).total_seconds()),
            "lat": s["lat"], "lon": s["lon"], "alt_ft": s["alt_ft"],
            "phase": s["phase"], "diverted": diverted,
        })
        coords[fmt_utc(s["utc"])] = (s["lon"], s["lat"])
    for w in wps:
        coords.setdefault(w["utc"], (w["lon"], w["lat"]))
    dense = [[round(lon, 5), round(lat, 5)]
             for _k, (lon, lat) in sorted(coords.items())]
    return positions, decimate_polyline(dense)


# ------------------------------------------------------------------ stories
def load_inputs(stitched_path, tier_path):
    # stitched.pkl is a self-produced intermediate of analysis/
    # segment_rades_exports.py run on this machine — not untrusted input.
    # (pickle load is fine here; regenerate rather than accept from elsewhere.)
    with open(stitched_path, "rb") as fh:
        chains = pickle.load(fh)
    with open(tier_path) as fh:
        tier = json.load(fh)
    return chains, tier


def bts_leg_index(bts_path, airports_path):
    """flight-id -> BTS leg metadata for the tier flights (wheels-off UTC,
    carrier, origin/dest, tail). Multi-leg numbers keep ALL legs."""
    import pandas as pd
    ap = pd.read_csv(airports_path).set_index("code")
    bts = pd.read_csv(bts_path, dtype={"Flight_Number": "string"})
    bts = bts[(bts.FlightDate == FLIGHT_DATE) & (bts.Cancelled == 0)]
    out = {}
    for r in bts.itertuples(index=False):
        try:
            hhmm = int(float(r.WheelsOff))
            off = ap.loc[r.Origin, "utc_offset"]
            wo = DAY + timedelta(seconds=(hhmm // 100) * 3600 + (hhmm % 100) * 60 - off * 3600)
        except Exception:
            wo = None
        out.setdefault(r.Reporting_Airline + str(r.Flight_Number), []).append(
            {"carrier": r.Reporting_Airline, "origin": r.Origin, "dest": r.Dest,
             "wheels_off": wo, "diverted": int(r.Diverted) == 1,
             "tail": None if r.Tail_Number != r.Tail_Number else str(r.Tail_Number)})
    return out


def nearest_airport(lat, lon, airports_path):
    import pandas as pd
    ap = pd.read_csv(airports_path)
    d = ((ap.lat - lat).abs() * 60) ** 2 + ((ap.lon - lon).abs() * 45) ** 2
    row = ap.loc[d.idxmin()]
    return (row.code, dist_nm(lat, lon, row.lat, row.lon))


def build_all(chains, tier, bts_path, airports_path):
    """-> (named: {flight: (positions, geometry, meta)}, diverted: {...}, skips)"""
    legs = bts_leg_index(bts_path, airports_path)
    named, diverted, skips = {}, {}, []
    for entry in tier:
        flight = entry["flight"]
        if flight in NOTABLE_IDS:
            skips.append((flight, "curated-notable"))
            continue
        chain = chains[entry["track_index"]]
        pts = clean_chain(chain["pts"])
        wps = chain_waypoints(pts)
        if len(wps) < 10:
            skips.append((flight, "chain too small after cleaning"))
            continue
        is_diverted = "diverted-tracked" in entry["evidence"]
        carrier = legs.get(flight, [{}])[0].get("carrier") or flight[:2]
        positions, geometry = build_rows(flight, carrier, wps, is_diverted)
        meta = {"entry": entry, "wps": len(wps),
                "track_source": {"kind": "rades-radar", "evidence": entry["evidence"],
                                 "codes": entry.get("codes", []),
                                 "returns": entry.get("returns")}}
        if is_diverted:
            end = pts[-1]
            code, d = nearest_airport(end[1], end[2], airports_path)
            if d > LANDING_AP_NM:
                skips.append((flight, f"diverted but track end {d:.0f} nm from any airport"))
                continue
            meta["landed_at"] = code
            leg = next((x for x in legs.get(flight, []) if x["diverted"]), None)
            meta["leg"] = leg or (legs.get(flight) or [None])[0]
            diverted[flight] = (positions, geometry, meta)
        else:
            leg = None
            if flight in legs:
                t0 = DAY + timedelta(seconds=positions[0]["et_seconds"] - ET_OFFSET * 3600)
                leg = min((x for x in legs[flight] if x["wheels_off"]),
                          key=lambda x: abs((x["wheels_off"] - t0).total_seconds()),
                          default=None)
            meta["leg"] = leg
            named[flight] = (positions, geometry, meta)
    log.info("built %d named upgrades, %d diverted additions, %d skips",
             len(named), len(diverted), len(skips))
    return named, diverted, skips


# ------------------------------------------------------------------ db
def run(dsn, stitched_path, tier_path, bts_path, airports_path,
        dry_run=False, init_schema=False, run_id=None, leg_tolerance_s=900):
    run_id = run_id or f"rades-{uuid.uuid4().hex[:12]}"
    chains, tier = load_inputs(stitched_path, tier_path)
    named, diverted, skips = build_all(chains, tier, bts_path, airports_path)

    summary = {"run_id": run_id, "dry_run": dry_run, "skipped": [list(s) for s in skips],
               "named_loaded": 0, "diverted_loaded": 0,
               "positions": 0, "positions_deleted": 0}
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            if init_schema:
                cur.execute(LOCAL_SCHEMA_DDL)
                log.warning("ensured scratch schema")

            # --- story 1: named upgrades, metadata-preserving
            load_named, tracks_out, positions_out = [], [], []
            for flight, (positions, geometry, meta) in sorted(named.items()):
                cur.execute("SELECT origin, scheduled_dest, landed_at, diverted, "
                            "wheels_off_utc, wheels_on_utc, tail_number, aircraft_type, "
                            "details FROM flight_tracks WHERE flight = %s AND flight_date = %s",
                            (flight, FLIGHT_DATE))
                rows = cur.fetchall()
                if not rows:
                    summary["skipped"].append([flight, "no existing prod row"])
                    continue
                if len(rows) > 1:
                    # multi-leg flight number: the by-id delete would remove the
                    # sibling leg too (this bit us once — run rades-repair-*).
                    summary["skipped"].append(
                        [flight, f"multi-leg id in prod ({len(rows)} rows) — not touching"])
                    continue
                row = rows[0]
                (origin, sdest, landed_at, dvt, wo, wn, tail, actype, details) = row
                leg = meta["leg"]
                if leg and leg["wheels_off"] and wo is not None:
                    if abs((leg["wheels_off"] - wo).total_seconds()) > leg_tolerance_s:
                        summary["skipped"].append(
                            [flight, f"leg mismatch: prod wheels_off {wo} vs named leg "
                                     f"{leg['wheels_off']}"])
                        continue
                details = dict(details or {})
                details["track_source"] = meta["track_source"]
                tracks_out.append({
                    "flight": flight, "flight_date": FLIGHT_DATE, "origin": origin,
                    "scheduled_dest": sdest, "landed_at": landed_at, "diverted": dvt,
                    "wheels_off_utc": wo.isoformat() if wo else None,
                    "wheels_on_utc": wn.isoformat() if wn else None,
                    "tail_number": tail, "aircraft_type": actype, "details": details,
                    "geometry": {"type": "LineString", "coordinates": geometry},
                })
                positions_out.extend(positions)
                load_named.append(flight)

            # --- story 2: diverted additions (id must be absent)
            load_div = []
            for flight, (positions, geometry, meta) in sorted(diverted.items()):
                cur.execute("SELECT 1 FROM flight_tracks WHERE flight = %s AND flight_date = %s",
                            (flight, FLIGHT_DATE))
                if cur.fetchone() is not None:
                    summary["skipped"].append([flight, "id exists in prod (other leg) — not adding"])
                    continue
                leg = meta["leg"] or {}
                details = {
                    "track_source": meta["track_source"],
                    "fate": {"text": f"Diverted to {meta['landed_at']} under the FAA "
                                     "national ground stop",
                             "utc": positions[-1]["utc"]},
                }
                tracks_out.append({
                    "flight": flight, "flight_date": FLIGHT_DATE,
                    "origin": leg.get("origin"), "scheduled_dest": leg.get("dest"),
                    "landed_at": meta["landed_at"], "diverted": True,
                    "wheels_off_utc": positions[0]["utc"], "wheels_on_utc": positions[-1]["utc"],
                    "tail_number": leg.get("tail"), "aircraft_type": None, "details": details,
                    "geometry": {"type": "LineString", "coordinates": geometry},
                })
                positions_out.extend(positions)
                load_div.append(flight)

            ids = load_named + load_div
            cur.execute("DELETE FROM flight_positions WHERE flight_date = %s AND flight = ANY(%s)",
                        (FLIGHT_DATE, ids))
            summary["positions_deleted"] = cur.rowcount
            cur.execute("DELETE FROM flight_tracks WHERE flight_date = %s AND flight = ANY(%s)",
                        (FLIGHT_DATE, ids))
            copy_positions(cur, positions_out, run_id)
            insert_tracks(cur, [t | {"details": t["details"]} for t in tracks_out], run_id)
            source = ("84 RADES radar tracks (FOIA) — verified-tier named upgrade + "
                      "diverted restorations; see plans/2026-07-29-radar-tracks-load-design.md")
            cur.execute(
                'INSERT INTO reconstruction_runs (run_id, start, "end", source_file, '
                "flights_reconstructed, positions_count, tracks_count, skipped_count, "
                "skipped, skipped_by_reason, cancelled_by_day, created_at) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (run_id, FLIGHT_DATE, FLIGHT_DATE, source, len(ids), len(positions_out),
                 len(tracks_out), len(summary["skipped"]), Json(summary["skipped"]),
                 Json({}), Json({}), datetime.now(timezone.utc)))
            summary.update(named_loaded=len(load_named), diverted_loaded=len(load_div),
                           positions=len(positions_out))
        if dry_run:
            conn.rollback()
            log.warning("DRY RUN: rolled back — nothing persisted")
        else:
            conn.commit()
            log.warning("committed: %d named + %d diverted, %d positions (run_id=%s)",
                        summary["named_loaded"], summary["diverted_loaded"],
                        summary["positions"], run_id)
    return summary


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--dsn", default=os.environ.get("RT911_DB_DSN"))
    p.add_argument("--stitched", required=True)
    p.add_argument("--tier", default=os.path.join(os.path.dirname(__file__), os.pardir,
                                                  "data", "rades", "verified_tier.json"))
    p.add_argument("--bts", default="/srv/flight-recon-data/bts_2001-09.csv")
    p.add_argument("--airports", default="/srv/flight-recon-data/airports.csv")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--init-schema", action="store_true")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING,
                        format="%(levelname)s %(message)s")
    if not args.dsn:
        p.error("no DSN")
    summary = run(args.dsn, args.stitched, args.tier, args.bts, args.airports,
                  dry_run=args.dry_run, init_schema=args.init_schema)
    print(json.dumps(summary, indent=1, default=str))


if __name__ == "__main__":
    main()
