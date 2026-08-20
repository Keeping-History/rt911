"""
One-time extraction of 84 RADES radar returns into the curated notable-flight
waypoint files (``data/notable_flights/*.json``).

Source: the 84th Radar Evaluation Squadron (RADES) 9/11 FOIA release — the
radar analysis the squadron performed for the FBI (memorandum dated 13 Sep
2001). Its Excel products contain per-antenna-sweep (~12 s) radar returns with
decimal lat/lon, Zulu time, Mode C altitude, and Mode 3 beacon code for the
four hijacked aircraft plus the C-130H observer (callsign GOFER06):

- ``rades.september11_RADES_ALL/Projects/Radar Data All 4 Events.xls``
  (sheets: WTC AC#1=AA11, WTC AC#2=UA175, Pentagon AC=AA77, Pittsburgh AC=UA93)
- ``rades.pentagon_RADES_PENTAGON/.../Products/Other/Observer.xls`` (GOFER06)

This replaces the previous 6-12 documented NTSB/Commission anchor waypoints
per flight (great-circle interpolated) with 200-700 surveyed radar returns —
the machine-readable radar data the NTSB Flight Path Studies (scanned PDFs)
could not provide.

Method (deterministic; config below is the reviewable decision record):

1. **Primary-site chaining.** Returns from different radar sites disagree by
   ~0.5-2.4 nm (site registration bias), so interleaving them zigzags. Each
   flight uses an ordered site-priority list: all returns from the first site,
   with coverage gaps > GAP_FILL_S filled from lower-priority sites after a
   median lat/lon bias correction computed from near-in-time overlap pairs.
2. **Spike filter.** Returns implying > SPIKE_KT ground speed to both
   neighbors are dropped (garbled plots, e.g. UA93's fought-over transponder).
3. **Altitude.** Valid Mode C where present (pressure altitude, 100 ft
   quanta). Transponder-off stretches interpolate through the documented NTSB
   altitude anchors (ALT_ANCHORS) that the previous curated files carried.
4. **Gap anchors.** Documented position anchors are re-injected inside radar
   coverage gaps (POS_ANCHORS) — e.g. AA77's turn-back near Pike County OH
   (the flight's westernmost point) fell inside the 12:50-13:09Z coverage
   hole and would otherwise be corner-cut.
5. **Endpoints.** The takeoff anchor (runway, alt 0) is kept from the previous
   curated file; the documented impact anchor is appended so the loader's
   track-end == impact validation holds. GOFER06 did not crash: its track
   starts at an Andrews AFB takeoff anchor and simply ends at its last return.

Times are rounded to whole seconds (the loader's resolution) and deduplicated.
Each emitted waypoint carries ``site`` (radar that surveyed it, or "anchor")
and ``alt_src`` ("modec" | "interp" | "anchor") for review.

Not part of the shipped package — offline, run once:

    python analysis/extract_rades_notables.py --rades-dir <path> [--check]

Requires ``xlrd`` (legacy .xls). ``--check`` re-runs extraction and diffs
against the committed files without writing.
"""

import argparse
import json
import math
import os
import statistics
from datetime import datetime, timedelta, timezone

DAY = datetime(2001, 9, 11, tzinfo=timezone.utc)
GAP_FILL_S = 45          # primary-site gap longer than this gets fill from the next site
GAP_EDGE_S = 15          # fill returns must sit this far from the gap's edges
BIAS_PAIR_S = 30         # overlap pairing window for cross-site bias estimation
MIN_SPACING_S = 5        # drop returns closer than this to the previous kept one
DEVIATION_NM = 1.2       # lateral deviation from the neighbor-interpolated position
DEVIATION_MAX_SPAN_S = 90  # ...judged only when the neighbors are this close in time
MODEC_JUMP_FT = 2500     # Mode C deviating this far from its neighbor median = garbled
MIN_GAP_ANCHOR_S = 60    # POS_ANCHORS are used only inside gaps at least this long

DATA_DIR = os.path.join(os.path.dirname(__file__), os.pardir, "data", "notable_flights")

ALL4_XLS = "rades.september11_RADES_ALL/Projects/Radar Data All 4 Events.xls"
OBSERVER_XLS = ("rades.pentagon_RADES_PENTAGON/01-27-254 Pentagon/Products/Other/"
                "Observer.xls")

RADES_SOURCE = ("84th Radar Evaluation Squadron (RADES) radar data analysis for the FBI, "
                "13 Sep 2001 (FOIA release): per-sweep radar returns with computed "
                "lat/lon, Mode C altitude, and Mode 3 beacon code")

# --------------------------------------------------------------------- config
# Per-flight extraction config. site_priority order is a curated judgment:
# the site with the longest continuous coverage of the flight goes first
# (measured from the data; see the module docstring).
#
# alt_anchors / pos_anchors carry over documented NTSB/Commission anchors from
# the previous curated files, used ONLY where radar data cannot answer
# (transponder-off altitude, positions inside coverage gaps).
FLIGHTS = {
    "AA11": {
        "sheet": "WTC AC#1",
        "site_priority": ["RIV", "NOR"],
        # transponder off ~12:21Z: NTSB estimated cruise 29,000 ft until descent
        "alt_anchors": [("2001-09-11T12:21:00Z", 29000),
                        ("2001-09-11T12:26:30Z", 29000),
                        ("2001-09-11T12:37:00Z", 29000)],
        "pos_anchors": [],
    },
    "UA175": {
        "sheet": "WTC AC#2",
        "site_priority": ["RIV"],
        "alt_anchors": [],
        "pos_anchors": [],
    },
    "AA77": {
        "sheet": "Pentagon AC",
        "site_priority": ["PLA", "GIB", "OCA"],
        # transponder off 12:56Z; primary-only return leg (NTSB profile)
        "alt_anchors": [("2001-09-11T13:10:00Z", 33000),
                        ("2001-09-11T13:20:00Z", 22000),
                        ("2001-09-11T13:29:00Z", 7000)],
        # The documented turn-back (deviation start 12:54Z, transponder off
        # 12:56Z) sits inside the 12:50:39-13:09:29Z radar coverage gap. The
        # previous curated apex (39.08,-83.07 "Pike County OH") is refuted by
        # the radar: 449 kt westbound at 12:50:39Z from -81.94 deg cannot reach
        # -83.07 deg by 12:54Z (would need ~980 kt). These anchors dead-reckon
        # that 449 kt track to the documented 12:54Z deviation start, a
        # standard-rate 180 through south, and an eastbound roll-out whose
        # closure to the 13:09:29Z reacquisition (38.42,-80.78) works out to a
        # plausible ~380 kt.
        "pos_anchors": [("2001-09-11T12:54:00Z", 38.83, -82.48, 35000),
                        ("2001-09-11T12:55:30Z", 38.76, -82.57, 35000),
                        ("2001-09-11T12:57:00Z", 38.70, -82.48, 35000)],
        "pos_anchors_note": (
            "COVERAGE GAP - DEAD-RECKONED TURN: AA77's turn-back sits inside the "
            "12:50:39-13:09:29Z radar coverage hole. The three gap anchors are NOT "
            "surveyed returns: they dead-reckon the last radar ground speed (449 kt "
            "westbound) to the documented 12:54Z course deviation (NTSB/Commission), "
            "trace a standard-rate reversal through south, and roll out eastbound "
            "consistent with the 13:09:29Z primary-radar reacquisition. The "
            "previously-curated Pike County OH apex (-83.07) was speed-infeasible "
            "against the radar data and has been corrected to ~-82.57."),
    },
    "UA93": {
        "sheet": "Pittsburgh AC",
        "site_priority": ["PLA", "GIB", "DAN", "REM", "RIV", "DTW", "OCA"],
        # Transponder off ~13:41Z; the 13:47:07-14:01:45Z coverage gap spans
        # the final descent. The previously-curated position anchors inside it
        # (40.25,-79.35 @13:52 and 40.08,-78.98 @13:59) are refuted by the
        # radar edges — reaching the first from the 13:47:07Z return needs
        # ~825 kt, and the second sits SOUTH of the 14:01:45Z reacquisition
        # (the track would zigzag). The great-circle chord between the radar
        # edge returns closes at a plausible ~350 kt, so the gap keeps NO
        # position anchors; the documented descent profile enters as
        # altitude-only anchors instead.
        "alt_anchors": [("2001-09-11T13:52:00Z", 16000),
                        ("2001-09-11T13:59:00Z", 7000)],
        "pos_anchors": [],
        "extra_notes": [
            "COVERAGE GAP 13:47:07-14:01:45Z: the previously-curated in-gap "
            "position anchors were speed/geometry-infeasible against the radar "
            "gap edges and were removed; the track crosses the gap on the "
            "great-circle chord (~350 kt closure). The documented descent "
            "(NTSB profile) is preserved as altitude-only anchors at 13:52Z "
            "(16,000 ft) and 13:59Z (7,000 ft).",
        ],
    },
    "GOFER06": {
        "sheet": None,   # separate workbook (OBSERVER_XLS)
        "site_priority": ["PLA", "GIB", "DAN", "OCA"],
        "alt_anchors": [],
        "pos_anchors": [],
        # first radar return is at 300 ft in the climb out of Andrews AFB;
        # anchor the runway ~90 s earlier ("took off about 09:30 ET")
        "takeoff": ("2001-09-11T13:31:00Z", 38.8108, -76.8670),
        "extra_notes": [
            "TAKEOFF ANCHOR APPROXIMATION: the Andrews AFB runway anchor at "
            "13:31:00Z is placed ~90 s before the first radar return (13:32:26Z, "
            "300 ft Mode C in the climb-out); O'Brien reported taking off 'about "
            "09:30' ET. NO IMPACT: the aircraft did not crash — the track simply "
            "ends at the last RADES return (14:29:20Z) as it leaves the analyzed "
            "coverage, en route Minneapolis-St. Paul.",
        ],
    },
}


# ------------------------------------------------------------------- reading
def _cell(sh, r, c):
    v = sh.cell_value(r, c)
    return v if v != "" else None


def read_all4(path):
    """Read the 4-sheet incident workbook → {flight: [return dicts]}."""
    import xlrd
    wb = xlrd.open_workbook(path)
    out = {}
    by_sheet = {cfg["sheet"]: fl for fl, cfg in FLIGHTS.items() if cfg["sheet"]}
    for sh in wb.sheets():
        fl = by_sheet.get(sh.name)
        if not fl:
            continue
        rows = []
        for r in range(2, sh.nrows):
            site, t = _cell(sh, r, 1), _cell(sh, r, 2)
            lat, lon = _cell(sh, r, 10), _cell(sh, r, 11)
            if not site or not isinstance(t, float) or lat is None or lon is None:
                continue
            mc = _cell(sh, r, 9)
            rows.append({"site": site, "secs": t * 86400.0, "lat": lat, "lon": lon,
                         "alt": float(mc) if isinstance(mc, float) else None})
        out[fl] = rows
    return out


def read_observer(path):
    """Read Observer.xls (GOFER06). Mode C has an explicit valid bit here."""
    import xlrd
    sh = xlrd.open_workbook(path).sheet_by_index(0)
    rows = []
    for r in range(2, sh.nrows):
        site, t = _cell(sh, r, 1), _cell(sh, r, 2)
        lat, lon = _cell(sh, r, 11), _cell(sh, r, 12)
        if not site or not isinstance(t, float) or lat is None or lon is None:
            continue
        mc, valid = _cell(sh, r, 7), _cell(sh, r, 8)
        alt = float(mc) if isinstance(mc, float) and valid == 1.0 else None
        rows.append({"site": site, "secs": t * 86400.0, "lat": lat, "lon": lon,
                     "alt": alt})
    return rows


# ---------------------------------------------------------------- geometry
def _dist_nm(a, b):
    dlat = (a["lat"] - b["lat"]) * 60.0
    dlon = (a["lon"] - b["lon"]) * 60.0 * math.cos(math.radians(a["lat"]))
    return math.hypot(dlat, dlon)


def chain_sites(rows, priority):
    """Primary-site selection with bias-corrected gap fill from lower sites."""
    by_site = {}
    for r in rows:
        by_site.setdefault(r["site"], []).append(r)
    for rs in by_site.values():
        rs.sort(key=lambda r: r["secs"])

    unknown = set(by_site) - set(priority)
    if unknown:
        raise SystemExit(f"sites {sorted(unknown)} missing from site_priority")

    selected = list(by_site.get(priority[0], []))
    for site in priority[1:]:
        cand = by_site.get(site, [])
        if not cand or not selected:
            selected.extend(cand)
            selected.sort(key=lambda r: r["secs"])
            continue
        # bias of this site vs the current selection, from near-in-time pairs
        pairs = []
        for c in cand:
            near = min(selected, key=lambda s: abs(s["secs"] - c["secs"]))
            if abs(near["secs"] - c["secs"]) <= BIAS_PAIR_S:
                pairs.append((near["lat"] - c["lat"], near["lon"] - c["lon"]))
        blat = statistics.median(p[0] for p in pairs) if pairs else 0.0
        blon = statistics.median(p[1] for p in pairs) if pairs else 0.0
        # fill gaps (incl. before-first / after-last) longer than GAP_FILL_S
        edges = ([selected[0]["secs"] - 10 * GAP_FILL_S * 60] +
                 [r["secs"] for r in selected] +
                 [selected[-1]["secs"] + 10 * GAP_FILL_S * 60])
        fills = []
        for c in cand:
            for a, b in zip(edges, edges[1:]):
                if (a + GAP_EDGE_S < c["secs"] < b - GAP_EDGE_S
                        and (b - a) > GAP_FILL_S):
                    fills.append({**c, "lat": c["lat"] + blat, "lon": c["lon"] + blon})
                    break
        selected.extend(fills)
        selected.sort(key=lambda r: r["secs"])

    out = []
    for r in selected:
        if out and r["secs"] - out[-1]["secs"] < MIN_SPACING_S:
            continue
        out.append(r)
    return out


def drop_spikes(rows):
    """Iteratively drop laterally-displaced plots (garbled returns).

    A plot is garbled when it deviates > DEVIATION_NM from where the time
    interpolation of its two neighbors puts it — robust through real turns
    (12 s sweep chords deviate well under 0.5 nm even in a tight spiral) and
    through steep dives (the interpolation tracks the trend). Judged only when
    the neighbors are within DEVIATION_MAX_SPAN_S, so coverage gaps are never
    bridged by the test. The worst offender is removed and the pass repeats.
    """
    rows = list(rows)
    while True:
        worst, worst_dev = None, DEVIATION_NM
        for i in range(1, len(rows) - 1):
            p, c, n = rows[i - 1], rows[i], rows[i + 1]
            span = n["secs"] - p["secs"]
            if span <= 0 or span > DEVIATION_MAX_SPAN_S:
                continue
            f = (c["secs"] - p["secs"]) / span
            expect = {"lat": p["lat"] + f * (n["lat"] - p["lat"]),
                      "lon": p["lon"] + f * (n["lon"] - p["lon"])}
            dev = _dist_nm(c, expect)
            if dev > worst_dev:
                worst, worst_dev = i, dev
        if worst is None:
            return rows
        del rows[worst]


def drop_gap_edge_spikes(rows):
    """Drop garbled plots at coverage-gap edges, which the neighbor-
    interpolation test cannot judge (one neighbor is minutes away). A point
    entering (or leaving) a > MIN_GAP_ANCHOR_S gap is tested against the
    constant-velocity extrapolation of its two same-side neighbors instead."""
    out = list(rows)
    changed = True
    while changed:
        changed = False
        for i, c in enumerate(out):
            gap_before = i == 0 or c["secs"] - out[i - 1]["secs"] > MIN_GAP_ANCHOR_S
            gap_after = i == len(out) - 1 or out[i + 1]["secs"] - c["secs"] > MIN_GAP_ANCHOR_S
            if gap_before and not gap_after and i + 2 < len(out):
                a, b = out[i + 1], out[i + 2]
            elif gap_after and not gap_before and i - 2 >= 0:
                a, b = out[i - 1], out[i - 2]
            else:
                continue
            span = b["secs"] - a["secs"]
            if not span or abs(span) > DEVIATION_MAX_SPAN_S:
                continue
            f = (c["secs"] - a["secs"]) / span
            expect = {"lat": a["lat"] + f * (b["lat"] - a["lat"]),
                      "lon": a["lon"] + f * (b["lon"] - a["lon"])}
            if _dist_nm(c, expect) > DEVIATION_NM:
                del out[i]
                changed = True
                break
    return out


def drop_garbled_modec(rows):
    """Blank Mode C values that jump > MODEC_JUMP_FT off their neighbor median
    (garbled readouts, e.g. AA77's lone 58,500 ft plot amid a 35,000 ft cruise).
    The position is kept; the altitude falls back to interpolation."""
    idx = [i for i, r in enumerate(rows) if r["alt"] is not None]
    orig = {i: rows[i]["alt"] for i in idx}  # judge against the unblanked values
    cleaned = 0
    for k, i in enumerate(idx):
        neigh = [orig[j] for j in idx[max(0, k - 2):k] + idx[k + 1:k + 3]]
        if len(neigh) >= 2 and abs(orig[i] - statistics.median(neigh)) > MODEC_JUMP_FT:
            rows[i] = {**rows[i], "alt": None}
            cleaned += 1
    return rows, cleaned


def dedupe_seconds(rows):
    """Round to whole seconds; keep the first return per second."""
    out, seen = [], set()
    for r in sorted(rows, key=lambda r: r["secs"]):
        s = round(r["secs"])
        if s in seen:
            continue
        seen.add(s)
        out.append({**r, "secs": float(s)})
    return out


def fill_altitude(rows, alt_anchors, impact=None):
    """Mode C where valid; linear interpolation through documented anchors
    (and the impact altitude) across transponder-off stretches."""
    known = [(r["secs"], r["alt"]) for r in rows if r["alt"] is not None]
    known += [(_secs(ts), float(alt)) for ts, alt in alt_anchors]
    if impact is not None:
        known.append(impact)  # (secs, alt_ft) — documented impact instant
    known.sort()
    if not known:
        raise SystemExit("no altitude source at all")
    out = []
    for r in rows:
        if r["alt"] is not None:
            out.append({**r, "alt_src": "modec"})
            continue
        alt = _interp(known, r["secs"])
        out.append({**r, "alt": alt, "alt_src": "interp"})
    return out


def _interp(pairs, x):
    if x <= pairs[0][0]:
        return pairs[0][1]
    if x >= pairs[-1][0]:
        return pairs[-1][1]
    for (x0, y0), (x1, y1) in zip(pairs, pairs[1:]):
        if x0 <= x <= x1:
            f = 0.0 if x1 == x0 else (x - x0) / (x1 - x0)
            return y0 + f * (y1 - y0)
    raise AssertionError


def _secs(ts):
    dt = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    return (dt - DAY).total_seconds()


def _stamp(secs):
    return (DAY + timedelta(seconds=secs)).strftime("%Y-%m-%dT%H:%M:%SZ")


def inject_gap_anchors(rows, pos_anchors):
    """Insert documented anchors that fall inside radar gaps >= MIN_GAP_ANCHOR_S."""
    out = list(rows)
    for ts, lat, lon, alt in pos_anchors:
        s = _secs(ts)
        before = [r for r in out if r["secs"] < s]
        after = [r for r in out if r["secs"] > s]
        if not before or not after:
            raise SystemExit(f"pos_anchor {ts} outside radar span")
        gap = after[0]["secs"] - before[-1]["secs"]
        if gap < MIN_GAP_ANCHOR_S:
            raise SystemExit(f"pos_anchor {ts} not inside a gap (gap={gap:.0f}s)")
        out.append({"site": "anchor", "secs": s, "lat": lat, "lon": lon,
                    "alt": float(alt), "alt_src": "anchor"})
    out.sort(key=lambda r: r["secs"])
    return out


# ---------------------------------------------------------------- assembly
def build_waypoints(flight, cfg, rows, old):
    rows = chain_sites(rows, cfg["site_priority"])
    rows = drop_spikes(rows)
    rows = drop_gap_edge_spikes(rows)
    rows = dedupe_seconds(rows)
    rows, garbled = drop_garbled_modec(rows)
    if garbled:
        print(f"{flight}: blanked {garbled} garbled Mode C value(s)")

    impact = old.get("impact")
    impact_alt = ((_secs(impact["utc"]), float(impact["alt_ft"]))
                  if impact else None)
    if impact:
        # a radar plot can postdate the documented impact instant by a sweep
        # (plot extrapolation); the impact anchor must be the track's last word
        n = len(rows)
        rows = [r for r in rows if r["secs"] < _secs(impact["utc"])]
        if n - len(rows):
            print(f"{flight}: dropped {n - len(rows)} return(s) at/after impact")
    rows = fill_altitude(rows, cfg["alt_anchors"], impact_alt)
    rows = inject_gap_anchors(rows, cfg["pos_anchors"])

    # takeoff anchor: runway position at brakes-release, before radar pickup
    if "takeoff" in cfg:
        t_ts, t_lat, t_lon = cfg["takeoff"]
    else:
        first = old["waypoints"][0]
        t_ts, t_lat, t_lon = first["utc"], first["lat"], first["lon"]
    wps = []
    if _secs(t_ts) < rows[0]["secs"]:
        wps.append({"utc": t_ts, "lat": t_lat, "lon": t_lon, "alt_ft": 0,
                    "site": "anchor", "alt_src": "anchor"})
    else:
        # radar coverage begins at/on the runway (e.g. AA77 out of IAD under
        # the nearby The Plains radar) — the anchor would be redundant
        print(f"{flight}: radar covers takeoff; runway anchor skipped")

    for r in rows:
        wps.append({"utc": _stamp(r["secs"]), "lat": round(r["lat"], 5),
                    "lon": round(r["lon"], 5), "alt_ft": max(0, round(r["alt"])),
                    "site": r["site"], "alt_src": r["alt_src"]})

    # impact anchor pinned last (loader validates track end == impact)
    if impact:
        if _secs(impact["utc"]) <= rows[-1]["secs"]:
            raise SystemExit(f"{flight}: impact not after last return")
        wps.append({"utc": impact["utc"], "lat": impact["lat"], "lon": impact["lon"],
                    "alt_ft": impact["alt_ft"], "site": "anchor", "alt_src": "anchor"})
    return wps


def provenance(flight, cfg, wps):
    n_radar = sum(1 for w in wps if w["site"] != "anchor")
    n_anchor = len(wps) - n_radar
    sites = sorted({w["site"] for w in wps if w["site"] != "anchor"})
    notes = [
        f"RADAR-SURVEYED TRACK: {n_radar} of {len(wps)} waypoints are 84 RADES "
        f"radar returns (sites {', '.join(sites)}; ~12 s antenna sweep), extracted by "
        "analysis/extract_rades_notables.py. Cross-site registration bias is corrected "
        "toward the primary site; garbled plots are speed-filtered. The remaining "
        f"{n_anchor} waypoints are documented anchors (takeoff runway, coverage-gap "
        "positions, impact point).",
        "ALTITUDE: alt_src='modec' waypoints carry the transponder's Mode C pressure "
        "altitude (100 ft quanta); alt_src='interp' waypoints (transponder off) "
        "interpolate through the documented NTSB profile anchors; alt_src='anchor' "
        "are the documented anchors themselves.",
    ]
    if cfg["pos_anchors"]:
        notes.append(cfg.get("pos_anchors_note") or (
            "COVERAGE GAPS: documented NTSB/Commission position anchors are "
            "re-injected inside radar coverage holes ("
            + ", ".join(ts for ts, *_ in cfg["pos_anchors"])
            + ") so documented maneuvers there are not corner-cut."))
    notes.extend(cfg.get("extra_notes", []))
    return notes


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--rades-dir", required=True,
                    help="root of the RADES FOIA release folder")
    ap.add_argument("--data-dir", default=DATA_DIR)
    ap.add_argument("--check", action="store_true",
                    help="diff against committed files; write nothing")
    args = ap.parse_args(argv)

    returns = read_all4(os.path.join(args.rades_dir, ALL4_XLS))
    returns["GOFER06"] = read_observer(os.path.join(args.rades_dir, OBSERVER_XLS))

    for flight, cfg in FLIGHTS.items():
        path = os.path.join(args.data_dir, f"{flight.lower()}.json")
        with open(path) as fh:
            old = json.load(fh)
        wps = build_waypoints(flight, cfg, returns[flight], old)
        doc = {**old}
        doc["waypoints"] = wps
        doc["sources"] = [RADES_SOURCE] + [s for s in old["sources"]
                                           if "84th Radar" not in s]
        doc["provenance_notes"] = provenance(flight, cfg, wps)
        new = json.dumps(doc, indent=1) + "\n"
        if args.check:
            with open(path) as fh:
                same = fh.read() == new
            print(f"{flight}: {'OK' if same else 'DIFFERS'} ({len(wps)} waypoints)")
        else:
            with open(path, "w") as fh:
                fh.write(new)
            print(f"{flight}: wrote {len(wps)} waypoints "
                  f"({sum(1 for w in wps if w['site'] != 'anchor')} radar returns)")


if __name__ == "__main__":
    main()
