"""
Segment the RS3 Message Viewer CSV exports (issue #263) into per-aircraft
radar tracks and estimate how many can be identified against BTS.

Input: ``MV_Exp_*.csv`` files exported from the RS3 app's Message Viewer
(see RADES_RS3_EXPORT.md). Columns of interest: ``Id`` (radar site), ``Time``
(UTC, ms), ``M3``+``M3V`` (Mode 3 squawk + valid bit), ``MC``+``MCV`` (Mode C
altitude ft + valid bit), ``DecLat``/``DecLon`` (RS3-computed position).

Pipeline (each stage prints its numbers; nothing is loaded anywhere):

1. **Unify** the exports into one beacon-return table (valid M3 only). The
   "Pentagon Combined" export contributes only its pre-11:30Z stretch — the
   four half-hour raw-file exports cover 11:30-13:30Z with identical sites.
2. **Segment** into tracks: within each squawk code, a greedy nearest-track
   association with a staleness gap (240 s) and a speed gate
   (max(6 nm, dt x 650 kt) + 3 nm cross-site allowance). Squawk codes are
   NOT unique across the airspace — e.g. code 1443 (AA11's) flies near
   Dayton OH before AA11 leaves the Boston gate — so continuity does the
   real work.
3. **Filter** to aircraft-grade tracks: >= 25 returns, >= 8 min, >= 10 nm
   net displacement (drops parrot checks, ground targets, garble).
4. **Correlate departures with BTS**: a track whose first return is below
   6,000 ft within 8 nm of an airport is a departure signature; match it to
   BTS 9/11 flights wheels-off from that airport within a tolerance of the
   estimated liftoff (first return - 60 s). Reports the
   candidates-per-track histogram and the count of unambiguous 1:1 flights.

Validated against the five curated notable flights: AA77's squawk-3743
returns in the exports end 12:50:38.660Z @ 38.8308,-81.9414 — identical to
the curated track's last pre-gap waypoint.

Not part of the shipped package — offline analysis:

    python analysis/segment_rades_exports.py \
        --exports-dir ".../Radar_Evaluation_Squadron_(RADES)/exports" \
        [--bts /srv/flight-recon-data/bts_2001-09.csv] \
        [--airports /srv/flight-recon-data/airports.csv] \
        [--out tracks.pkl]

Requires pandas (the flight-recon venv has it).
"""

import argparse
import glob
import json
import math
import os
import pickle
from collections import Counter

import numpy as np
import pandas as pd

COLS = ["Id", "Time", "M3", "M3V", "MC", "MCV", "DecLat", "DecLon"]
GAP_S = 240.0     # track staleness
MAX_KT = 650.0    # speed gate ceiling
BIAS_NM = 3.0     # cross-site registration allowance
MIN_RETURNS = 25
MIN_DUR_S = 480
MIN_NET_NM = 10.0
DEP_ALT_FT = 6000
DEP_AP_NM = 8.0
LIFTOFF_LEAD_S = 60

# Coverage box (1-99th pct of track endpoints seen in the 2026-07 exports).
COVER = dict(la0=31.2, la1=47.7, lo0=-95.6, lo1=-66.4)


def secs(t):
    try:
        h, m, s = str(t).split(":")
        return int(h) * 3600 + int(m) * 60 + float(s)
    except Exception:
        return np.nan


def dist_nm(a1, o1, a2, o2):
    return math.hypot((a1 - a2) * 60, (o1 - o2) * 60 * math.cos(math.radians((a1 + a2) / 2)))


def load_beacon(exports_dir):
    frames = []
    combined = glob.glob(os.path.join(exports_dir, "*Combined*.csv"))
    halves = sorted(set(glob.glob(os.path.join(exports_dir, "MV_Exp_1254*.csv"))) - set(combined))
    for p in combined:
        df = pd.read_csv(p, usecols=COLS, dtype={"M3": "string", "MC": "string"}, low_memory=False)
        df["secs"] = df.Time.map(secs)
        df = df[(df.M3V == 1) & df.secs.notna() & (df.secs < 11.5 * 3600)]
        frames.append(df)
    for p in halves:
        df = pd.read_csv(p, usecols=COLS, dtype={"M3": "string", "MC": "string"}, low_memory=False)
        df["secs"] = df.Time.map(secs)
        frames.append(df[(df.M3V == 1) & df.secs.notna()])
    b = pd.concat(frames, ignore_index=True).dropna(subset=["DecLat", "DecLon"])
    b["mc_ft"] = pd.to_numeric(b.MC, errors="coerce").where(b.MCV == 1)
    print(f"beacon returns: {len(b):,}  span {b.secs.min()/3600:.2f}h -> {b.secs.max()/3600:.2f}h  "
          f"squawks {b.M3.nunique()}")
    return b


def segment(b):
    tracks = []
    for code, g in b.groupby("M3", sort=False):
        g = g.sort_values("secs")
        open_tracks = []
        for row in g.itertuples(index=False):
            t, lat, lon = row.secs, row.DecLat, row.DecLon
            best, bestd = None, None
            for tr in open_tracks:
                dt = t - tr["t"]
                if dt > GAP_S:
                    continue
                gate = max(6.0, dt / 3600.0 * MAX_KT) + BIAS_NM
                d = dist_nm(lat, lon, tr["lat"], tr["lon"])
                if d <= gate and (bestd is None or d < bestd):
                    best, bestd = tr, d
            open_tracks = [tr for tr in open_tracks if t - tr["t"] <= GAP_S]
            if best is None:
                best = {"code": code, "pts": []}
                open_tracks.append(best)
                tracks.append(best)
            best["pts"].append((t, lat, lon, row.mc_ft, row.Id))
            best["t"], best["lat"], best["lon"] = t, lat, lon
    print(f"raw tracks: {len(tracks):,}")
    good = [tr for tr in tracks
            if len(tr["pts"]) >= MIN_RETURNS
            and tr["pts"][-1][0] - tr["pts"][0][0] >= MIN_DUR_S
            and dist_nm(tr["pts"][0][1], tr["pts"][0][2],
                        tr["pts"][-1][1], tr["pts"][-1][2]) >= MIN_NET_NM]
    print(f"aircraft-grade tracks (>={MIN_RETURNS} rtns, >={MIN_DUR_S//60} min, "
          f">={MIN_NET_NM:.0f} nm): {len(good):,}")
    return [{"code": tr["code"], "pts": tr["pts"]} for tr in good]


def correlate(tracks, bts_path, airports_path):
    ap = pd.read_csv(airports_path).set_index("code")
    bts = pd.read_csv(bts_path, dtype={"Flight_Number": "string"})
    bts = bts[(bts.FlightDate == "2001-09-11") & (bts.Cancelled == 0)].copy()

    def wo_utc(row):
        try:
            hhmm = int(float(row.WheelsOff))
            return (hhmm // 100) * 3600 + (hhmm % 100) * 60 - ap.loc[row.Origin, "utc_offset"] * 3600
        except Exception:
            return np.nan
    bts["wo_secs"] = [wo_utc(r) for r in bts.itertuples(index=False)]
    bts = bts.dropna(subset=["wo_secs"])

    ap_in = ap[(ap.lat > COVER["la0"]) & (ap.lat < COVER["la1"])
               & (ap.lon > COVER["lo0"]) & (ap.lon < COVER["lo1"])]
    apl = list(ap_in.itertuples())

    deps = []
    for tr in tracks:
        t, lat, lon, alt, _site = tr["pts"][0]
        a = None if pd.isna(alt) else float(alt)
        if a is None:
            low = [float(p[3]) for p in tr["pts"][:5] if not pd.isna(p[3])]
            a = min(low) if low else None
        if a is None or a > DEP_ALT_FT:
            continue
        best, bd = None, DEP_AP_NM
        for arow in apl:
            d = dist_nm(lat, lon, arow.lat, arow.lon)
            if d < bd:
                best, bd = arow.Index, d
        if best:
            deps.append({"code": tr["code"], "t0": t, "ap": best, "n": len(tr["pts"])})
    print(f"departure-signature tracks: {len(deps):,}")

    w0, w1 = 9.5 * 3600, 13.5 * 3600
    bts_in = bts[(bts.wo_secs >= w0) & (bts.wo_secs <= w1) & bts.Origin.isin(ap_in.index)]
    print(f"BTS wheels-off 09:30-13:30Z from in-coverage airports: {len(bts_in):,}")

    results = {}
    for tol in (150, 300):
        amb = Counter()
        matched = {}
        for d in deps:
            est = d["t0"] - LIFTOFF_LEAD_S
            c = bts_in[(bts_in.Origin == d["ap"]) & ((bts_in.wo_secs - est).abs() <= tol)]
            amb[min(len(c), 4)] += 1
            if len(c) == 1:
                f = c.iloc[0]
                matched[f.Reporting_Airline + str(f.Flight_Number)] = (d, dict(
                    origin=f.Origin, dest=f.Dest, wo_secs=float(f.wo_secs)))
        print(f"tol +-{tol//60}min: candidates-per-track {dict(sorted(amb.items()))} | "
              f"BTS flights 1:1: {len(matched):,}")
        results[tol] = matched
    return results


# ------------------------------------------------------------------ matcher v2
# Upgrades over correlate(): global mutual-best assignment (each track and each
# BTS flight used at most once, best score first — hub congestion stops
# producing "2+ candidates, discard"), per-airport wheels-off bias calibration
# (BTS times are minute-quantized local; towers also differ systematically in
# taxi/queue offsets), destination-bearing consistency (a departure's outbound
# course must roughly agree with the great-circle bearing to its BTS
# destination), and arrival-side matching as independent evidence (tracks
# ending low near an airport vs BTS WheelsOn).

BEARING_FREE_DEG = 35     # departures turn on SIDs; under this, no penalty
BEARING_GATE_DEG = 100    # beyond this, the pairing is rejected outright
BEARING_WEIGHT = 3.0      # score seconds per degree beyond the free cone
SCORE_GATE_S = 300.0      # max acceptable score for an assignment
COURSE_SAMPLE_S = 300     # outbound course measured at first return + this


def bearing_deg(lat1, lon1, lat2, lon2):
    dlon = math.radians(lon2 - lon1)
    la1, la2 = math.radians(lat1), math.radians(lat2)
    y = math.sin(dlon) * math.cos(la2)
    x = math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(dlon)
    return math.degrees(math.atan2(y, x)) % 360


def ang_diff(a, b):
    return abs((a - b + 180) % 360 - 180)


def _endpoint_signatures(tracks, apl):
    """Departure and arrival signatures with an outbound/inbound course."""
    deps, arrs = [], []
    for i, tr in enumerate(tracks):
        pts = tr["pts"]
        for kind, p0, seq in (("dep", pts[0], pts), ("arr", pts[-1], pts[::-1])):
            t, lat, lon, alt, _site = p0
            a = None if pd.isna(alt) else float(alt)
            if a is None:
                low = [float(q[3]) for q in seq[:5] if not pd.isna(q[3])]
                a = min(low) if low else None
            if a is None or a > DEP_ALT_FT:
                continue
            best, bd = None, DEP_AP_NM
            for arow in apl:
                d = dist_nm(lat, lon, arow.lat, arow.lon)
                if d < bd:
                    best, bd = arow.Index, d
            if not best:
                continue
            # course away from (dep) / toward (arr) the airport, sampled a few
            # minutes into / before the end of the track
            ref = next((q for q in seq if abs(q[0] - t) >= COURSE_SAMPLE_S), seq[-1])
            course = (bearing_deg(lat, lon, ref[1], ref[2]) if kind == "dep"
                      else bearing_deg(ref[1], ref[2], lat, lon))
            sig = {"track": i, "code": tr["code"], "t": t, "ap": best,
                   "course": course, "n": len(pts)}
            (deps if kind == "dep" else arrs).append(sig)
    return deps, arrs


def _assign(sigs, flights, ap, time_col, bias, lead_s, use_bearing):
    """Greedy global mutual-best assignment. Returns {flight_key: (sig, score)}."""
    by_airport = {}
    for f in flights.itertuples(index=False):
        by_airport.setdefault(getattr(f, "airport"), []).append(f)
    pairs = []
    for s in sigs:
        est = s["t"] - lead_s - bias.get(s["ap"], 0.0)
        for f in by_airport.get(s["ap"], []):
            dt = abs(getattr(f, time_col) - est)
            if dt > 2 * SCORE_GATE_S:
                continue
            score = dt
            if use_bearing:
                other = f.Dest if time_col == "wo_secs" else f.Origin
                if other in ap.index:
                    brg = bearing_deg(ap.loc[s["ap"], "lat"], ap.loc[s["ap"], "lon"],
                                      ap.loc[other, "lat"], ap.loc[other, "lon"])
                    diff = ang_diff(s["course"], brg)
                    if diff > BEARING_GATE_DEG:
                        continue
                    score += BEARING_WEIGHT * max(0.0, diff - BEARING_FREE_DEG)
            if score <= SCORE_GATE_S:
                pairs.append((score, s, f))
    pairs.sort(key=lambda x: x[0])
    used_tracks, used_flights, out = set(), set(), {}
    for score, s, f in pairs:
        key = f.Reporting_Airline + str(f.Flight_Number)
        if s["track"] in used_tracks or key in used_flights:
            continue
        used_tracks.add(s["track"])
        used_flights.add(key)
        out[key] = (s, score)
    return out


def correlate_v2(tracks, bts_path, airports_path, notable_codes=("1443", "3020", "3321", "3743", "1527", "2427")):
    ap = pd.read_csv(airports_path).set_index("code")
    bts = pd.read_csv(bts_path, dtype={"Flight_Number": "string"})
    bts = bts[(bts.FlightDate == "2001-09-11") & (bts.Cancelled == 0)].copy()

    def hhmm_utc(v, origin_or_dest):
        try:
            hhmm = int(float(v))
            return (hhmm // 100) * 3600 + (hhmm % 100) * 60 - ap.loc[origin_or_dest, "utc_offset"] * 3600
        except Exception:
            return np.nan
    bts["wo_secs"] = [hhmm_utc(r.WheelsOff, r.Origin) for r in bts.itertuples(index=False)]
    bts["wn_secs"] = [hhmm_utc(r.WheelsOn, r.Dest) for r in bts.itertuples(index=False)]

    ap_in = ap[(ap.lat > COVER["la0"]) & (ap.lat < COVER["la1"])
               & (ap.lon > COVER["lo0"]) & (ap.lon < COVER["lo1"])]
    apl = list(ap_in.itertuples())
    deps, arrs = _endpoint_signatures(tracks, apl)
    print(f"v2 signatures: {len(deps):,} departures, {len(arrs):,} arrivals")

    w0, w1 = 9.5 * 3600, 13.5 * 3600
    bd = bts.dropna(subset=["wo_secs"])
    bd = bd[(bd.wo_secs >= w0) & (bd.wo_secs <= w1) & bd.Origin.isin(ap_in.index)].copy()
    bd["airport"] = bd.Origin
    ba = bts.dropna(subset=["wn_secs"])
    ba = ba[(ba.wn_secs >= w0) & (ba.wn_secs <= w1) & ba.Dest.isin(ap_in.index)].copy()
    ba["airport"] = ba.Dest

    # pass 1 (time only, tight) → per-airport wheels-off bias from >=5 matches
    pass1 = _assign(deps, bd, ap, "wo_secs", {}, LIFTOFF_LEAD_S, use_bearing=False)
    resid = {}
    for key, (s, _sc) in pass1.items():
        f = bd[(bd.Reporting_Airline + bd.Flight_Number.astype(str)) == key].iloc[0]
        if abs(s["t"] - LIFTOFF_LEAD_S - f.wo_secs) <= 120:
            resid.setdefault(s["ap"], []).append(s["t"] - LIFTOFF_LEAD_S - f.wo_secs)
    bias = {a: float(np.median(v)) for a, v in resid.items() if len(v) >= 5}
    print(f"v2 pass1: {len(pass1):,} matches; bias calibrated for {len(bias)} airports "
          f"(median offsets {sorted(round(b) for b in bias.values())[:8]}...)")

    dep_m = _assign(deps, bd, ap, "wo_secs", bias, LIFTOFF_LEAD_S, use_bearing=True)
    arr_m = _assign(arrs, ba, ap, "wn_secs", bias, -30, use_bearing=True)

    both = {k for k in dep_m if k in arr_m
            if dep_m[k][0]["track"] == arr_m[k][0]["track"]}
    all_named = set(dep_m) | set(arr_m)
    print(f"v2 named: departures {len(dep_m):,}, arrivals {len(arr_m):,}, "
          f"both-ends-same-track {len(both):,}, union {len(all_named):,}")

    # negative control: hijacked/observer squawk tracks must stay unnamed
    bad = [k for k, (s, _sc) in list(dep_m.items()) + list(arr_m.items())
           if s["code"] in notable_codes]
    print(f"v2 negative control (notable squawks named): {bad or 'none'}")
    return {"dep": dep_m, "arr": arr_m, "both": both}


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--exports-dir", required=True)
    p.add_argument("--bts", default="/srv/flight-recon-data/bts_2001-09.csv")
    p.add_argument("--airports", default="/srv/flight-recon-data/airports.csv")
    p.add_argument("--out", help="pickle path for the aircraft-grade tracks")
    p.add_argument("--matches-out", help="JSON path for the +-2min 1:1 matches")
    args = p.parse_args(argv)

    b = load_beacon(args.exports_dir)
    tracks = segment(b)
    if args.out:
        with open(args.out, "wb") as fh:
            pickle.dump(tracks, fh)
    results = correlate(tracks, args.bts, args.airports)
    correlate_v2(tracks, args.bts, args.airports)
    if args.matches_out:
        payload = [{"flight": fl, "squawk": d["code"], "first_return_secs": d["t0"],
                    "airport": d["ap"], "returns": d["n"], **meta}
                   for fl, (d, meta) in sorted(results[150].items())]
        with open(args.matches_out, "w") as fh:
            json.dump(payload, fh, indent=1)


if __name__ == "__main__":
    main()
