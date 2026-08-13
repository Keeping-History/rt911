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

1. **Load** only the decoded recordings that cover 13:30-16:30Z with southern
   coverage — the SEADS (Southeast Air Defense Sector) half-hour raw files,
   whose sensors do reach Sarasota, plus (with ``--all-files``) the whole raw
   corpus via ``segment_rades_exports.load_beacon_decoded``.
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
5. **Export** the chosen chain (``--pick <index>``) as a waypoint file in the
   curated notable-flight shape, decimated to ~1 per DECIMATE_S with the first
   and last returns kept verbatim.

Not part of the shipped package — offline analysis:

    python analysis/find_af1_leg1.py \
        --decoded-dir "../../../Radar_Evaluation_Squadron_(RADES)/decoded" \
        [--pick 0 --out data/rades/af1_leg1_waypoints.json]

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

# Recordings that cover 13:30Z onward with coverage over peninsular Florida.
# (The Pentagon/WTC/UA93 sets' sensors are northeastern; SEADS is the Southeast
# Air Defense Sector and is the only part of the corpus that sees Sarasota.)
WINDOW_FILE_KEYS = ("SEADS_12541330", "SEADS_12541400", "SEADS_12541430",
                    "SEADS_12541500", "SEADS_12541530", "SEADS_12541600")


def hms(secs):
    return f"{int(secs) // 3600:02d}:{int(secs) % 3600 // 60:02d}:{int(secs) % 60:02d}"


def utc_iso(secs):
    return (DAY + timedelta(seconds=float(secs))).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_window(decoded_dir, all_files=False):
    """Beacon-return table for the hunt window.

    ``--all-files`` delegates to the segmenter's own corpus loader; the default
    reads only WINDOW_FILE_KEYS with the identical column/validity contract
    (valid Mode 3, decoded position, Mode C only where its valid bit is set),
    because loading all 56 raw recordings costs ~16 M rows for data that is
    almost entirely outside this window and this part of the country.
    """
    if all_files:
        return seg.load_beacon_decoded(decoded_dir)
    with open(os.path.join(decoded_dir, "summary.json")) as fh:
        summary = json.load(fh)
    picked = [r for r in summary
              if r.get("status") == "ok"
              and "/Data/Raw/" in r["file"].replace("\\", "/")
              and any(k in r["out"] for k in WINDOW_FILE_KEYS)]
    if not picked:
        raise SystemExit(f"no window recordings found under {decoded_dir}")
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
    """
    alts = [None if pd.isna(p[3]) else float(p[3]) for p in pts]
    out, dropped = [], 0
    for i, p in enumerate(pts):
        a = alts[i]
        if a is not None:
            near = [x for x in alts[max(0, i - half):i + half + 1] if x is not None and x != a]
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
    """
    rows, no_alt = [], 0
    for t, lat, lon, alt, site in decimate(drop_modec_spikes(tr["pts"])):
        if pd.isna(alt):
            no_alt += 1
            continue
        rows.append({"utc": utc_iso(t), "lat": round(float(lat), 4),
                     "lon": round(float(lon), 4), "alt_ft": int(round(float(alt))),
                     "site": str(site), "alt_src": "modec", "source": "radar"})
    if no_alt:
        print(f"dropped {no_alt} decimated fix(es) with no valid Mode C")
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w") as fh:
        json.dump(rows, fh, indent=1)
    print(f"\nexported {len(rows)} waypoints -> {out_path} "
          f"({rows[0]['utc']} .. {rows[-1]['utc']})")
    return rows


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--decoded-dir", required=True, help="rs3_batch_decode output directory")
    p.add_argument("--all-files", action="store_true",
                   help="load the whole raw corpus instead of the window recordings")
    p.add_argument("--pick", type=int, default=None,
                   help="index of the reported chain to export as waypoints")
    p.add_argument("--out", default=None, help="waypoint JSON path (with --pick)")
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

    if args.pick is not None:
        if not args.out:
            raise SystemExit("--pick requires --out")
        export(reported[args.pick], args.out)


if __name__ == "__main__":
    main()
