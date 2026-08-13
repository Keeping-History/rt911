"""
Bounded RADES radar hunt for Air Force One's 9/11 leg 1: Sarasota-Bradenton
(SRQ) -> Barksdale AFB (BAD), roughly 13:54-15:45Z on 2001-09-11.

Why this can work at all: a national ground stop was complete by ~13:25Z, so
almost nothing departed anywhere after it. A chain of radar returns that lifts
off the SRQ area between 13:40 and 14:30Z is therefore a very short list, and
the timeline research (``plans/2026-08-13-af1-research.md``) pins the wheels-off
to 13:54-13:57Z. Identification here is time + origin + course + continuity;
the beacon code is reported but never used as identity, because Mode 3 codes
are reused across the airspace (see ``segment_rades_exports.py``).

Method:

1. **Select and load** recordings by content: every SEADS (Southeast Air Defense
   Sector) raw recording, whose sensors do reach Sarasota, plus every other raw
   recording probed to hold returns inside the corridor box during the window.
   ``--all-files`` instead loads the whole raw corpus via
   ``segment_rades_exports.load_beacon_decoded``.
2. **Clip** to the Florida->Louisiana corridor box (lat 26-34, lon -94.5..-81)
   and 13:30-16:10Z.
3. **Chain** with the segmenter's own machinery: ``segment()`` (per-code
   nearest-track association with staleness + speed gates) then ``stitch()``
   (relinks across squawk changes and coverage lapses). The gates are relaxed
   here (see HUNT_* below) so short fragments survive to be stitched instead of
   being dropped as non-aircraft.
4. **Seed** on returns within SEED_DEG of SRQ between 13:40 and 14:30Z, and
   report every chain touching a seed with >= MIN_CHAIN_RETURNS returns:
   first/last fix, course over the first 15 min, Mode C profile, beacon codes.
5. **Export** the chosen chain — named by beacon code + first-return time, never
   by its position in the report — as a waypoint file in the curated
   notable-flight shape, decimated to ~1 per DECIMATE_S with the first and last
   returns kept verbatim.

Not part of the shipped package — offline analysis. Run it bare first to read the
report, then re-run naming the chain you want. The command below reproduces the
committed AF1 leg-1 file exactly:

    python analysis/find_af1_leg1.py \
        --decoded-dir "../../../Radar_Evaluation_Squadron_(RADES)/decoded" \
        --pick-code 3755 --pick-first 13:54:41 \
        --out data/rades/af1_leg1_waypoints.json

Requires pandas (the flight-recon venv has it).
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import segment_rades_exports as seg  # noqa: E402  (chaining + geometry helpers)

DAY = datetime(2001, 9, 11, tzinfo=timezone.utc)

SRQ = (27.3954, -82.5544)          # Sarasota-Bradenton Intl
BAD = (32.5019, -93.6628)          # Barksdale AFB

# Corridor clip: Florida -> Louisiana, wide enough for the reported Gulf routing.
BBOX = dict(la0=26.0, la1=34.0, lo0=-94.5, lo1=-81.0)
T0, T1 = 13.5 * 3600, 16.0 * 3600 + 600      # 13:30 - 16:10Z
SEED_T0, SEED_T1 = 13 * 3600 + 40 * 60, 14 * 3600 + 30 * 60
SEED_DEG = 0.4                     # seed radius around SRQ, degrees
MIN_CHAIN_RETURNS = 20
COURSE_WINDOW_S = 15 * 60          # "mean course over the first 15 min"
DECIMATE_S = 60
MODEC_JUMP_FT = 2500               # garbled-altitude guard (see extract_rades_notables)

# Relaxed segmentation gates: the shipped defaults (>=25 returns, >=8 min,
# >=10 nm) exist to drop ground clutter from a whole-day corpus. Here the
# corridor+window clip has already done that filtering, and dropping short
# fragments before stitch() would break exactly the chain we are hunting.
HUNT_MIN_RETURNS = 8
HUNT_MIN_DUR_S = 120
HUNT_MIN_NET_NM = 3.0

# File selection is by *content*, not by a hand-written allow-list: every SEADS
# (Southeast Air Defense Sector) raw recording is taken unconditionally, and
# every other raw recording is probed for returns that actually land inside the
# corridor box during the hunt window. A hardcoded list would silently decide
# the search's own negative result.
SEADS_KEY = "SEADS_1254"


def hms(secs):
    return f"{int(secs) // 3600:02d}:{int(secs) % 3600 // 60:02d}:{int(secs) % 60:02d}"


def utc_iso(secs):
    return (DAY + timedelta(seconds=float(secs))).strftime("%Y-%m-%dT%H:%M:%SZ")


def raw_recordings(decoded_dir):
    """The ``Data/Raw`` originals from the batch decoder's summary.

    The combined/filtered products in the corpus are subsets of these and would
    double-count returns — the same ``raw_only`` rule ``load_beacon_decoded``
    applies.
    """
    with open(os.path.join(decoded_dir, "summary.json")) as fh:
        summary = json.load(fh)
    return [r for r in summary
            if r.get("status") == "ok"
            and "/Data/Raw/" in r["file"].replace("\\", "/")]


def contributes_to_corridor(path):
    """True when a recording holds any return inside the corridor + window.

    Reads three columns only, so probing the whole corpus is cheap relative to
    loading it. Position validity is not checked here: this is a screen, and a
    file with no positioned returns in the box cannot gain any later.
    """
    df = pd.read_csv(path, usecols=["epoch_s", "DecLat", "DecLon"], low_memory=False)
    secs = df.epoch_s % 86400
    return bool(((secs >= T0) & (secs <= T1)
                 & df.DecLat.between(BBOX["la0"], BBOX["la1"])
                 & df.DecLon.between(BBOX["lo0"], BBOX["lo1"])).any())


def select_recordings(decoded_dir):
    """Every SEADS raw recording, plus any other raw recording with corridor content.

    Prints the accept/reject decision for every non-SEADS recording so the
    search's coverage claim is auditable rather than asserted.
    """
    raw = raw_recordings(decoded_dir)
    seads = [r for r in raw if SEADS_KEY in r["out"]]
    others = [r for r in raw if SEADS_KEY not in r["out"]]
    print(f"recording selection: {len(seads)} SEADS + probing {len(others)} others "
          f"for corridor content")
    extra, rejected = [], []
    for rec in others:
        if contributes_to_corridor(os.path.join(decoded_dir, rec["out"])):
            extra.append(rec)
            print(f"  + {rec['out']}: has corridor returns in window")
        else:
            rejected.append(rec["out"])
    print(f"  - {len(rejected)} recordings contribute nothing to the corridor/window")
    picked = seads + extra
    if not picked:
        raise SystemExit(f"no usable recordings found under {decoded_dir}")
    return picked


def load_window(decoded_dir, all_files=False):
    """Beacon-return table for the hunt window.

    ``--all-files`` delegates to the segmenter's own corpus loader (the whole
    raw corpus, ~16 M rows); the default reads the content-selected recordings
    with the identical column/validity contract (valid Mode 3, decoded position,
    Mode C only where its valid bit is set).
    """
    if all_files:
        return seg.load_beacon_decoded(decoded_dir)
    picked = select_recordings(decoded_dir)
    frames = []
    for rec in picked:
        df = pd.read_csv(os.path.join(decoded_dir, rec["out"]),
                         usecols=["Id", "epoch_s", "M3", "M3V", "MC", "MCV", "DecLat", "DecLon"],
                         dtype={"M3": "string"}, low_memory=False)
        df = df[(df.M3V == 1) & df.DecLat.notna()]
        df["secs"] = df.epoch_s % 86400
        df["mc_ft"] = pd.to_numeric(df.MC, errors="coerce").where(df.MCV == 1)
        frames.append(df[["Id", "secs", "M3", "DecLat", "DecLon", "mc_ft"]])
        print(f"  loaded {rec['out']}: {len(df):,} valid beacon returns")
    b = pd.concat(frames, ignore_index=True)
    b = b.drop_duplicates(subset=["Id", "secs", "M3", "DecLat", "DecLon"])
    print(f"beacon returns: {len(b):,}  span {b.secs.min()/3600:.2f}h -> "
          f"{b.secs.max()/3600:.2f}h  squawks {b.M3.nunique()}")
    return b


def clip(b):
    m = ((b.secs >= T0) & (b.secs <= T1)
         & (b.DecLat >= BBOX["la0"]) & (b.DecLat <= BBOX["la1"])
         & (b.DecLon >= BBOX["lo0"]) & (b.DecLon <= BBOX["lo1"]))
    out = b[m]
    print(f"corridor clip (lat {BBOX['la0']}..{BBOX['la1']}, lon {BBOX['lo0']}..{BBOX['lo1']}, "
          f"{hms(T0)}-{hms(T1)}Z): {len(out):,} returns, {out.M3.nunique()} squawks")
    return out


def chain(b):
    """Segment + stitch with the hunt's relaxed gates (restores them after)."""
    saved = (seg.MIN_RETURNS, seg.MIN_DUR_S, seg.MIN_NET_NM)
    seg.MIN_RETURNS, seg.MIN_DUR_S, seg.MIN_NET_NM = (
        HUNT_MIN_RETURNS, HUNT_MIN_DUR_S, HUNT_MIN_NET_NM)
    try:
        return seg.stitch(seg.segment(b))
    finally:
        seg.MIN_RETURNS, seg.MIN_DUR_S, seg.MIN_NET_NM = saved


def seeded_chains(chains):
    """Chains containing a return near SRQ inside the departure window."""
    hits = []
    for tr in chains:
        for t, lat, lon, _alt, _site in tr["pts"]:
            if (SEED_T0 <= t <= SEED_T1
                    and abs(lat - SRQ[0]) <= SEED_DEG
                    and abs(lon - SRQ[1]) <= SEED_DEG):
                hits.append(tr)
                break
    hits.sort(key=lambda tr: tr["pts"][0][0])
    return hits


def course_over(pts, window_s):
    """Great-circle course from the first fix to the last fix within window_s."""
    t0 = pts[0][0]
    ref = pts[0]
    for p in pts:
        if p[0] - t0 > window_s:
            break
        ref = p
    if ref is pts[0]:
        return None
    return seg.bearing_deg(pts[0][1], pts[0][2], ref[1], ref[2])


def alt_profile(pts):
    a = [float(p[3]) for p in pts if not pd.isna(p[3])]
    if not a:
        return "no Mode C"
    first, last = a[0], a[-1]
    return (f"{first:,.0f} -> max {max(a):,.0f} -> {last:,.0f} ft "
            f"(n={len(a)}/{len(pts)} with Mode C)")


def describe(tr, idx):
    pts = tr["pts"]
    p0, p1 = pts[0], pts[-1]
    crs = course_over(pts, COURSE_WINDOW_S)
    net = seg.dist_nm(p0[1], p0[2], p1[1], p1[2])
    d_srq0 = seg.dist_nm(p0[1], p0[2], *SRQ)
    d_bad1 = seg.dist_nm(p1[1], p1[2], *BAD)
    sites = sorted({p[4] for p in pts})
    print(f"\n[{idx}] {len(pts)} returns  codes={tr.get('codes', [tr['code']])}  "
          f"fragments={tr.get('n_fragments', 1)}")
    print(f"     first {hms(p0[0])}Z  {p0[1]:.4f},{p0[2]:.4f}  "
          f"{'' if pd.isna(p0[3]) else f'{float(p0[3]):,.0f} ft'}  ({d_srq0:.1f} nm from SRQ)")
    print(f"     last  {hms(p1[0])}Z  {p1[1]:.4f},{p1[2]:.4f}  "
          f"{'' if pd.isna(p1[3]) else f'{float(p1[3]):,.0f} ft'}  ({d_bad1:.0f} nm from BAD)")
    print(f"     duration {(p1[0]-p0[0])/60:.1f} min, net {net:.1f} nm, "
          f"course(first 15 min) {'n/a' if crs is None else f'{crs:.0f} deg'}")
    print(f"     Mode C: {alt_profile(pts)}")
    print(f"     sites: {','.join(sites)}")


def drop_modec_spikes(pts, jump_ft=MODEC_JUMP_FT, half=3):
    """Blank Mode C that disagrees with its neighbours' median (garbled plots).

    Same guard ``extract_rades_notables.py`` applies to the curated flights: on
    this chain exactly one return of ~2,000 reads 43,800 ft in the middle of a
    steady FL390 cruise. Position is left untouched; only the altitude is
    invalidated, so the fix can still be decimated away or carried as a
    no-Mode-C return.

    The neighbour set excludes the reading under test **by index, not by value**.
    Excluding by value inverts the guard on exactly the windows it exists for: in
    six 39,000 ft readings around one 43,800 ft spike, every good reading's
    neighbour set collapses to ``[43800]`` and the guard blanks the six good
    readings along with the spike.
    """
    alts = [None if pd.isna(p[3]) else float(p[3]) for p in pts]
    out, dropped = [], 0
    for i, p in enumerate(pts):
        a = alts[i]
        if a is not None:
            lo = max(0, i - half)
            near = [x for j, x in enumerate(alts[lo:i + half + 1], start=lo)
                    if x is not None and j != i]
            if near and abs(a - float(np.median(near))) > jump_ft:
                p = (p[0], p[1], p[2], np.nan, p[4])
                dropped += 1
        out.append(p)
    if dropped:
        print(f"Mode C spike guard: blanked {dropped} garbled altitude(s)")
    return out


def decimate(pts, step_s=DECIMATE_S, lookahead_s=30):
    """~1 fix per step_s, first and last kept verbatim.

    At each due time the first fix carrying valid Mode C within lookahead_s is
    preferred, so a single transponder dropout doesn't cost the waypoint its
    altitude.
    """
    keep = [pts[0]]
    i = 1
    end = len(pts) - 1
    while i < end:
        if pts[i][0] - keep[-1][0] < step_s:
            i += 1
            continue
        pick = i
        if pd.isna(pts[i][3]):
            for j in range(i + 1, end):
                if pts[j][0] - pts[i][0] > lookahead_s:
                    break
                if not pd.isna(pts[j][3]):
                    pick = j
                    break
        keep.append(pts[pick])
        i = pick + 1
    if pts[-1][0] != keep[-1][0]:
        keep.append(pts[-1])
    return keep


def export(tr, out_path):
    """Waypoint file in the curated notable-flight shape (Task 5 consumes it).

    Every emitted waypoint carries a real Mode C reading — no interpolation and
    no carry-forward, because ``alt_src: "modec"`` has to mean what it says.
    Dropping a Mode-C-less fix mid-track is fine (the next one is 60 s away);
    dropping the *first* or *last* one silently would break the documented
    verbatim-endpoints contract, so that is called out loudly instead.
    """
    kept = decimate(drop_modec_spikes(tr["pts"]))
    rows, no_alt = [], 0
    for idx, (t, lat, lon, alt, site) in enumerate(kept):
        if pd.isna(alt):
            no_alt += 1
            if idx in (0, len(kept) - 1):
                print(f"WARNING: {'first' if idx == 0 else 'last'} fix ({hms(t)}Z) has no "
                      f"valid Mode C and was dropped — the exported endpoint is NOT the "
                      f"chain's endpoint")
            continue
        rows.append({"utc": utc_iso(t), "lat": round(float(lat), 4),
                     "lon": round(float(lon), 4), "alt_ft": int(round(float(alt))),
                     "site": str(site), "alt_src": "modec", "source": "radar"})
    if not rows:
        raise SystemExit("no exportable waypoints: the chain has no valid Mode C at all")
    if no_alt:
        print(f"dropped {no_alt} decimated fix(es) with no valid Mode C")
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w") as fh:
        json.dump(rows, fh, indent=1)
    print(f"\nexported {len(rows)} waypoints -> {out_path} "
          f"({rows[0]['utc']} .. {rows[-1]['utc']})")
    return rows


def find_chain(reported, code, first_hms, tol_s=60):
    """The reported chain carrying ``code`` whose first return is at ``first_hms``.

    Selection is by content, never by position in the report: the reported list
    is ordered by first-return time and its indices shift whenever the corpus or
    any constant changes, so an index would quietly export a different aircraft.
    Ambiguity is an error, not a coin flip.
    """
    h, m, s = (int(x) for x in first_hms.split(":"))
    want = h * 3600 + m * 60 + s
    hit = [tr for tr in reported
           if code in tr.get("codes", [tr["code"]])
           and abs(tr["pts"][0][0] - want) <= tol_s]
    if len(hit) != 1:
        raise SystemExit(
            f"--pick-code {code} --pick-first {first_hms} matched {len(hit)} chains "
            f"(need exactly 1). Re-read the report above and pass the code and "
            f"first-return time of the chain you mean.")
    return hit[0]


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--decoded-dir", required=True, help="rs3_batch_decode output directory")
    p.add_argument("--all-files", action="store_true",
                   help="load the whole raw corpus instead of the content-selected recordings")
    p.add_argument("--pick-code", default=None,
                   help="beacon code of the reported chain to export (with --pick-first)")
    p.add_argument("--pick-first", default=None,
                   help="that chain's first-return time, HH:MM:SS UTC")
    p.add_argument("--out", default=None, help="waypoint JSON path")
    args = p.parse_args(argv)

    b = clip(load_window(args.decoded_dir, args.all_files))
    chains = chain(b)
    hits = seeded_chains(chains)
    print(f"\nchains touching the SRQ seed box ({SEED_DEG} deg, "
          f"{hms(SEED_T0)}-{hms(SEED_T1)}Z): {len(hits)}")
    reported = [tr for tr in hits if len(tr["pts"]) >= MIN_CHAIN_RETURNS]
    print(f"of which >= {MIN_CHAIN_RETURNS} returns: {len(reported)}")
    for i, tr in enumerate(reported):
        describe(tr, i)

    if args.pick_code or args.pick_first:
        if not (args.pick_code and args.pick_first and args.out):
            raise SystemExit("exporting needs --pick-code, --pick-first and --out")
        export(find_chain(reported, args.pick_code, args.pick_first), args.out)


if __name__ == "__main__":
    main()
