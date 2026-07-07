#!/usr/bin/env python3
"""
Reconstruct plausible per-flight trajectories from BTS Airline On-Time data.

Input : BTS On-Time CSV (one row per flight) + airport reference table
Output: positions      (timestamped lat/lon/alt, keyed to ET seconds and to a
                        continuous window clock for the 911realtime.org replay)
        tracks         (one GeoJSON LineString Feature per flight, for maps)
        summary        (counts + skip reasons + cancelled-by-day, for provenance)

Method: great-circle interpolation between the actual takeoff and landing
airports, parameterized by the real wheels-off -> wheels-on interval. For
diverted flights the endpoint is the DIVERSION airport, not the scheduled
destination — so the 9/11 forced-landings show up as flights bending off-route
and coming down early. These are plausible tracks, NOT surveyed radar paths.

Usable as a library (`reconstruct(start, end, flights_path, airports_path)`)
or as a CLI:

    python reconstruct.py --start 2001-09-09 --end 2001-09-12 \
        --flights data/sample_bts_2001-09-09_2001-09-12.csv \
        --airports data/airports.csv [--out-dir out] [--plot]
"""

import argparse
import json
import math
import os
from datetime import date, datetime, timedelta, timezone

import pandas as pd

STEP_SECONDS = 60          # trajectory sample cadence
CRUISE_ALT_FT = 35000
CLIMB_FRAC = 0.15          # fraction of airborne time spent climbing / descending
ET_OFFSET = -4             # Eastern Daylight Time in Sept 2001, for the replay clock

REQUIRED_FLIGHT_COLS = {
    "FlightDate", "Reporting_Airline", "Flight_Number", "Origin", "Dest",
    "WheelsOff", "WheelsOn", "Cancelled", "Diverted", "DivAirport",
}
REQUIRED_AIRPORT_COLS = {"code", "lat", "lon", "utc_offset"}


def load_airports(airports_path):
    airports = pd.read_csv(airports_path)
    missing = REQUIRED_AIRPORT_COLS - set(airports.columns)
    if missing:
        raise ValueError(f"airports CSV missing columns: {sorted(missing)}")
    airports = airports.set_index("code")
    return {c: (r.lat, r.lon, int(r.utc_offset)) for c, r in airports.iterrows()}


def local_hhmm_to_utc(hhmm, utc_offset, flight_date):
    """BTS times are local hhmm at the relevant airport. Return aware UTC datetime."""
    if pd.isna(hhmm) or str(hhmm).strip() in ("", "nan"):
        return None
    s = str(int(float(hhmm))).zfill(4)
    h, m = int(s[:2]), int(s[2:])
    # 2400 -> next-day midnight edge case
    day = datetime.strptime(flight_date, "%Y-%m-%d")
    if h == 24:
        h, day = 0, day + timedelta(days=1)
    local = day.replace(hour=h, minute=m)
    return (local - timedelta(hours=utc_offset)).replace(tzinfo=timezone.utc)


def gc_interp(lat1, lon1, lat2, lon2, f):
    """Great-circle intermediate point at fraction f in [0,1]."""
    p1, l1, p2, l2 = map(math.radians, (lat1, lon1, lat2, lon2))
    d = 2 * math.asin(math.sqrt(
        math.sin((p2 - p1) / 2) ** 2 +
        math.cos(p1) * math.cos(p2) * math.sin((l2 - l1) / 2) ** 2))
    if d == 0:
        return lat1, lon1
    a = math.sin((1 - f) * d) / math.sin(d)
    b = math.sin(f * d) / math.sin(d)
    x = a * math.cos(p1) * math.cos(l1) + b * math.cos(p2) * math.cos(l2)
    y = a * math.cos(p1) * math.sin(l1) + b * math.cos(p2) * math.sin(l2)
    z = a * math.sin(p1) + b * math.sin(p2)
    return math.degrees(math.atan2(z, math.hypot(x, y))), math.degrees(math.atan2(y, x))


def altitude(f):
    if f < CLIMB_FRAC:
        return CRUISE_ALT_FT * f / CLIMB_FRAC
    if f > 1 - CLIMB_FRAC:
        return CRUISE_ALT_FT * (1 - f) / CLIMB_FRAC
    return CRUISE_ALT_FT


def phase(f):
    """Flight phase at fraction f — same thresholds altitude() uses."""
    if f < CLIMB_FRAC:
        return "climb"
    if f > 1 - CLIMB_FRAC:
        return "descent"
    return "cruise"


def et_seconds(utc_dt):
    et = utc_dt + timedelta(hours=ET_OFFSET)
    return et.hour * 3600 + et.minute * 60 + et.second


# ---------------------------------------------------------------- reconstruction
def reconstruct(start, end, flights_path, airports_path):
    """
    Rebuild trajectories for every flight with FlightDate in [start, end].

    Returns (positions, tracks, summary, flown):
      positions — list of dicts, one per flight per STEP_SECONDS
      tracks    — list of GeoJSON Feature dicts (LineString per flight)
      summary   — counts, skip reasons, cancelled_by_day (provenance)
      flown     — per-flight wheels-off/on intervals (diagnostics)
    """
    start_d = date.fromisoformat(str(start))
    end_d = date.fromisoformat(str(end))
    if end_d < start_d:
        raise ValueError(f"end {end_d} precedes start {start_d}")

    AP = load_airports(airports_path)
    flights = pd.read_csv(flights_path, dtype={"FlightDate": str})
    missing = REQUIRED_FLIGHT_COLS - set(flights.columns)
    if missing:
        raise ValueError(f"flights CSV missing columns: {sorted(missing)}")

    in_window = flights[
        (flights.FlightDate >= start_d.isoformat()) &
        (flights.FlightDate <= end_d.isoformat())
    ]

    # clock_seconds: continuous seconds since ET midnight of the window's first
    # day — the replay-clock key that spans days without resetting.
    window_start_utc = datetime.combine(start_d, datetime.min.time(), timezone.utc) \
        - timedelta(hours=ET_OFFSET)

    positions, features, flown, skipped = [], [], [], []
    cancelled_by_day = {}

    for _, r in in_window.iterrows():
        fid = f"{r.Reporting_Airline}{int(r.Flight_Number)}"
        fdate = r.FlightDate
        if int(r.Cancelled) == 1:
            cancelled_by_day[fdate] = cancelled_by_day.get(fdate, 0) + 1
            skipped.append((fid, fdate, "cancelled"))
            continue
        diverted = int(r.Diverted) == 1
        end_code = r.DivAirport if diverted and pd.notna(r.DivAirport) else r.Dest
        if r.Origin not in AP or end_code not in AP:
            skipped.append((fid, fdate, "unknown airport"))
            continue

        olat, olon, ooff = AP[r.Origin]
        elat, elon, eoff = AP[end_code]
        t_off = local_hhmm_to_utc(r.WheelsOff, ooff, fdate)   # origin local -> UTC
        t_on = local_hhmm_to_utc(r.WheelsOn, eoff, fdate)     # endpoint local -> UTC
        if t_off is None or t_on is None or t_on <= t_off:
            skipped.append((fid, fdate, "no usable airborne interval"))
            continue

        dur = (t_on - t_off).total_seconds()
        coords = []
        t = t_off
        while t <= t_on:
            f = (t - t_off).total_seconds() / dur
            lat, lon = gc_interp(olat, olon, elat, elon, f)
            positions.append({
                "flight": fid, "carrier": r.Reporting_Airline,
                "utc": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "flight_date": fdate,
                "et_seconds": et_seconds(t),
                "clock_seconds": int((t - window_start_utc).total_seconds()),
                "lat": round(lat, 4), "lon": round(lon, 4),
                "alt_ft": round(altitude(f)), "phase": phase(f),
                "diverted": diverted,
            })
            coords.append([round(lon, 4), round(lat, 4)])
            t += timedelta(seconds=STEP_SECONDS)

        flown.append({"fid": fid, "off": t_off, "on": t_on,
                      "o": r.Origin, "e": end_code, "div": diverted,
                      "olat": olat, "olon": olon, "elat": elat, "elon": elon})
        features.append({
            "type": "Feature",
            "properties": {"flight": fid, "flight_date": fdate,
                           "origin": r.Origin,
                           "scheduled_dest": r.Dest, "landed_at": end_code,
                           "diverted": diverted,
                           "wheels_off_utc": t_off.strftime("%Y-%m-%dT%H:%M:%SZ"),
                           "wheels_on_utc": t_on.strftime("%Y-%m-%dT%H:%M:%SZ")},
            "geometry": {"type": "LineString", "coordinates": coords},
        })

    summary = {
        "start": start_d.isoformat(), "end": end_d.isoformat(),
        "source_file": os.path.basename(str(flights_path)),
        "flights_reconstructed": len(flown),
        "positions_count": len(positions),
        "tracks_count": len(features),
        "skipped_count": len(skipped),
        "skipped": [{"flight": a, "flight_date": b, "reason": c} for a, b, c in skipped],
        "cancelled_by_day": cancelled_by_day,
    }
    return positions, features, summary, flown


# ---------------------------------------------------------------- CLI
def _airborne_check(flown, day):
    """Print airborne counts vs the replay clock for one day (sanity check)."""
    def airborne_at(utc_dt):
        return [f["fid"] for f in flown if f["off"] <= utc_dt <= f["on"]]

    y, m, d = (int(x) for x in day.split("-"))
    print(f"\nAirborne count vs the replay clock ({day}):")
    print(f"{'UTC':>6}  {'ET':>8}  count  flights")
    for mins in range(11 * 60, 15 * 60 + 1, 15):
        u = datetime(y, m, d, mins // 60, mins % 60, tzinfo=timezone.utc)
        ap_list = airborne_at(u)
        et = u + timedelta(hours=ET_OFFSET)
        flag = "  <- FAA ground stop" if (u.hour == 13 and u.minute == 45) else ""
        print(f"{u.strftime('%H:%M'):>6}  {et.strftime('%I:%M%p')}  {len(ap_list):>5}  "
              f"{','.join(ap_list)}{flag}")


def _plot(flown, out_path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(11, 6.5))
    ax.set_facecolor("#0d1117")
    fig.patch.set_facecolor("#0d1117")
    for f in flown:
        lats, lons = [], []
        for i in range(101):
            la, lo = gc_interp(f["olat"], f["olon"], f["elat"], f["elon"], i / 100)
            lats.append(la)
            lons.append(lo)
        col = "#e0a458" if f["div"] else "#5aa0d0"
        ax.plot(lons, lats, color=col, lw=1.6, alpha=0.9, zorder=2)
        ax.plot(f["elon"], f["elat"], "o", color=col, ms=5, zorder=3)
    seen = set()
    for f in flown:
        for code, la, lo in ((f["o"], f["olat"], f["olon"]), (f["e"], f["elat"], f["elon"])):
            if code in seen:
                continue
            seen.add(code)
            ax.plot(lo, la, "s", color="#c9d1d9", ms=4, zorder=4)
            ax.annotate(code, (lo, la), color="#c9d1d9", fontsize=8,
                        xytext=(4, 4), textcoords="offset points")
    ax.plot([], [], color="#5aa0d0", lw=1.6, label="completed to destination")
    ax.plot([], [], color="#e0a458", lw=1.6, label="diverted (forced down)")
    ax.legend(facecolor="#161b22", edgecolor="#2a2f37", labelcolor="#c9d1d9", loc="lower left")
    ax.set_xlim(-125, -66)
    ax.set_ylim(24, 50)
    ax.set_title("Sample reconstruction (endpoints = actual landing airport)",
                 color="#c9d1d9")
    ax.tick_params(colors="#6b7280")
    for s in ax.spines.values():
        s.set_color("#2a2f37")
    plt.tight_layout()
    plt.savefig(out_path, dpi=130, facecolor="#0d1117")


def main(argv=None):
    p = argparse.ArgumentParser(
        description="Reconstruct plausible per-flight trajectories from BTS On-Time data.")
    p.add_argument("--start", required=True, help="YYYY-MM-DD (inclusive)")
    p.add_argument("--end", required=True, help="YYYY-MM-DD (inclusive)")
    p.add_argument("--flights", required=True, help="BTS On-Time CSV")
    p.add_argument("--airports", required=True, help="airports.csv (code,lat,lon,utc_offset)")
    p.add_argument("--out-dir", default=".", help="where to write positions.csv / tracks.geojson")
    p.add_argument("--plot", action="store_true", help="also write sample_tracks.png")
    args = p.parse_args(argv)

    positions, features, summary, flown = reconstruct(
        args.start, args.end, args.flights, args.airports)

    os.makedirs(args.out_dir, exist_ok=True)
    pos_csv = os.path.join(args.out_dir, "positions.csv")
    pd.DataFrame(positions).to_csv(pos_csv, index=False)
    geojson = os.path.join(args.out_dir, "tracks.geojson")
    with open(geojson, "w") as fh:
        json.dump({"type": "FeatureCollection", "features": features}, fh, indent=1)

    print(f"Reconstructed {summary['flights_reconstructed']} flights, "
          f"{summary['positions_count']} position samples.")
    if summary["skipped"]:
        print("Skipped:", ", ".join(f"{s['flight']} {s['flight_date']} ({s['reason']})"
                                    for s in summary["skipped"]))
    if summary["cancelled_by_day"]:
        print("Cancelled by day:", summary["cancelled_by_day"])

    if args.start <= "2001-09-11" <= args.end:
        _airborne_check(flown, "2001-09-11")

    wrote = [pos_csv, geojson]
    if args.plot:
        png = os.path.join(args.out_dir, "sample_tracks.png")
        _plot(flown, png)
        wrote.append(png)
    print("\nWrote", ", ".join(wrote))


if __name__ == "__main__":
    main()
