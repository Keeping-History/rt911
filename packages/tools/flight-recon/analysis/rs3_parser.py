"""
Standalone parser for 84 RADES ``RS3`` binary sensor recordings (issue #263)
— no Windows/RS3 app required.

Format (reverse-engineered from known plaintext: the RS3 app's own Message
Viewer CSV export of ``12541130.RS3`` aligns 1:1, in order, with the binary's
639,590 messages; every field below validates against that export):

- File header up to the first ``99 99 FF FF`` separator ("RADES Sensor Data").
- Messages separated by ``99 99 FF FF``. Little-endian uint16 words:
    w0.lo   site id            (per-file byte -> site code table)
    w0.b3   Af flag
    w1.lo   message type       (2=Reinf 3=Bcn 1=Sch 26=IPS ...)
    w2.lo   payload word count; w2.hi bit1 = has 4-byte trailer
    w3..w4  UTC epoch seconds  (uint32)
    w5      fine time, 20 microsecond units
  Aircraft messages (Bcn/Reinf/Sch and the RTQC test targets):
    w6      flags: b6=Ident b7=MCV b8=M3V b9=M2V
    w7      slant range: (w7 >> 2) / 8 nm  (b1 = Mrg)   [RTQC variants: w7/32]
    w8      azimuth: (w8 >> 1) * 360 / 4096 deg (true)
    w9      flags: b7=M3X b8=M2X b9=Disc
    w10     Mode 3 code << 1   (12-bit, displayed as 4-digit octal)
    w11     Mode 2 code << 1
    w12     Mode C  << 1, in 100 ft (already Gillham-decoded by the radar)
    w13     radar height-finder altitude * 12.5 ft (Reinf; approximate)

Positions: RS3 computes lat/lon from slant range + azimuth via a WGS84
geodesic from the site, with a slant-to-ground correction using Mode C
altitude. ``SITE_CAL`` below was least-squares fitted per site against the
RS3-computed positions (median residual ~0.035 nm, p95 < 0.11 nm — inside the
radars' own cross-site registration noise). Sites without calibration (e.g.
the SEADS southern radars) still parse; their rows just carry range/azimuth
with empty lat/lon until a matching RS3 CSV export calibrates them
(``--calibrate``).

Usage:

    python analysis/rs3_parser.py decode  FILE.RS3 [-o out.csv]
    python analysis/rs3_parser.py validate FILE.RS3 MV_Exp_FILE.csv
    python analysis/rs3_parser.py calibrate FILE.RS3 MV_Exp_FILE.csv

Requires numpy/pandas (+ pyproj and scipy for positions/calibration; decode
degrades to no-position output without pyproj).
"""

import argparse
import csv as csvmod
import math
import struct
import sys
from datetime import datetime, timezone

SEP = b"\x99\x99\xff\xff"
FT_PER_NM = 6076.115
M_PER_NM = 1852.0

SITE_IDS = {13: "BAR", 18: "BM4", 6: "BUC", 12: "CAR", 8: "DAN", 11: "DTW",
            9: "EMP", 3: "GIB", 15: "GM4", 17: "NM4", 5: "NOR", 10: "NSH",
            0: "OCA", 14: "OM4", 2: "PLA", 1: "QFF", 7: "REM", 4: "RIV",
            16: "RM4", 19: "WSD"}

TYPE_IDS = {1: "Sch", 2: "Reinf", 3: "Bcn", 4: "SRTQC", 5: "BRTQC", 6: "Status",
            7: "M4", 9: "Sch Strb", 12: "Map", 15: "M4 Req", 26: "IPS",
            27: "Marker", 33: "Par Err", 34: "Hdr Err", 35: "Syn Err"}

AIRCRAFT_TYPES = {"Sch", "Reinf", "Bcn"}

# Per-site geodesic calibration fitted against the RS3 app's own computed
# positions (see module docstring). alt_site_ft absorbs site elevation and
# systematic slant/refraction bias; range_bias_nm absorbs bin-center offset.
SITE_CAL = {
    "BUC": {"lat": 44.629523, "lon": -67.395544, "range_bias_nm": -0.0657, "alt_site_ft": 653.7},
    "CAR": {"lat": 46.886121, "lon": -67.971448, "range_bias_nm": -0.0684, "alt_site_ft": 919.8},
    "DAN": {"lat": 42.638565, "lon": -77.652982, "range_bias_nm": -0.0820, "alt_site_ft": 3334.3},
    "DTW": {"lat": 42.276776, "lon": -83.474126, "range_bias_nm": -0.0677, "alt_site_ft": 1577.9},
    "EMP": {"lat": 44.802101, "lon": -86.051392, "range_bias_nm": -0.0694, "alt_site_ft": -979.0},
    "GIB": {"lat": 39.824761, "lon": -74.953978, "range_bias_nm": -0.0516, "alt_site_ft": -6.7},
    "NOR": {"lat": 42.034441, "lon": -70.054276, "range_bias_nm": -0.0397, "alt_site_ft": -1893.6},
    "NSH": {"lat": 47.397711, "lon": -93.170753, "range_bias_nm": -0.0823, "alt_site_ft": 1663.6},
    "OCA": {"lat": 36.827516, "lon": -76.013803, "range_bias_nm": -0.0915, "alt_site_ft": 1356.7},
    "PLA": {"lat": 38.882296, "lon": -77.702801, "range_bias_nm": -0.0643, "alt_site_ft": 1857.8},
    "QFF": {"lat": 33.990464, "lon": -77.917708, "range_bias_nm": -0.1056, "alt_site_ft": 1466.9},
    "REM": {"lat": 43.345469, "lon": -75.248787, "range_bias_nm": -0.0804, "alt_site_ft": 2721.5},
    "RIV": {"lat": 40.878652, "lon": -72.687049, "range_bias_nm": -0.0483, "alt_site_ft": -47.5},
}

FIELDS = ["Id", "MsgType", "Date", "Time", "epoch_s", "Range", "AzDegs",
          "M3", "M3V", "M3X", "M2", "M2V", "M2X", "MC", "MCV", "HeightApprox",
          "Ident", "Mrg", "Disc", "Af", "DecLat", "DecLon"]


def _geod():
    from pyproj import Geod
    return Geod(ellps="WGS84")


def iter_messages(path):
    """Yield (words, nbytes) per message.

    Separator-split first; then each part is walked by the header's own
    length field (12 + 2*payload [+4 trailer]), so a part carrying trailing
    bytes (the end-of-file footer; a payload that embedded the separator)
    still yields its leading message, plus any sane chained messages in the
    remainder."""
    data = open(path, "rb").read()
    parts = data.split(SEP)
    if b"RADES Sensor Data" not in parts[0]:
        raise SystemExit(f"{path}: not an RS3 sensor recording")
    first_epoch = None
    for p in parts[1:]:
        off = 0
        first_in_part = True
        while len(p) - off >= 12:
            head = struct.unpack_from("<6H", p, off)
            payload = head[2] & 0xFF
            trailer = 4 if head[2] & 0x0200 else 0
            n = 12 + 2 * payload + trailer
            epoch = head[3] | (head[4] << 16)
            sane = (head[1] & 0xFF) in TYPE_IDS and len(p) - off >= n and (
                first_epoch is None or abs(epoch - first_epoch) < 86400)
            if not sane:
                break  # remainder is footer/garble — drop it
            if first_epoch is None:
                first_epoch = epoch
            words = struct.unpack_from(f"<{n//2}H", p, off)
            yield words, n
            off += n
            if first_in_part and off == len(p):
                break
            first_in_part = False


def oct4(v):
    return format(v, "04o")


def decode(path, with_positions=True):
    """Yield decoded rows (dicts, FIELDS keys) for every aircraft message."""
    geod = None
    if with_positions:
        try:
            geod = _geod()
        except ImportError:
            print("pyproj not available — emitting rows without positions", file=sys.stderr)
    for words, _n in iter_messages(path):
        mtype = TYPE_IDS.get(words[1] & 0xFF, f"type{words[1] & 0xFF}")
        if mtype not in AIRCRAFT_TYPES:
            continue
        site = SITE_IDS.get(words[0] & 0xFF, f"site{words[0] & 0xFF}")
        epoch = words[3] | (words[4] << 16)
        t = epoch + words[5] * 20e-6
        dt = datetime.fromtimestamp(t, tz=timezone.utc)
        w = lambda i: words[i] if len(words) > i else 0  # noqa: E731
        m3v = (w(6) >> 8) & 1
        mcv = (w(6) >> 7) & 1
        m2v = (w(6) >> 9) & 1
        rng = (w(7) >> 2) / 8.0
        az = (w(8) >> 1) * 360.0 / 4096.0
        mc_ft = ((w(12) >> 1) * 100) if mcv else None
        # Mode C words carry a sign convention above 0x7FF ((wrap for < -1200 ft
        # garble)) — clamp the display like RS3 does via validity only.
        row = {
            "Id": site, "MsgType": mtype,
            "Date": dt.strftime("%d %b %Y"),
            "Time": dt.strftime("%H:%M:%S.") + f"{int(round((t % 1) * 1000)):03d}",
            "epoch_s": round(t, 6),
            "Range": rng, "AzDegs": round(az, 3),
            "M3": oct4(w(10) >> 1) if m3v or (w(10) >> 1) else "",
            "M3V": m3v, "M3X": (w(9) >> 7) & 1,
            "M2": oct4(w(11) >> 1) if m2v or (w(11) >> 1) else "",
            "M2V": m2v, "M2X": (w(9) >> 8) & 1,
            "MC": mc_ft if mc_ft is not None else "",
            "MCV": mcv,
            "HeightApprox": w(13) * 12.5 if mtype == "Reinf" else "",
            "Ident": (w(6) >> 6) & 1, "Mrg": (w(7) >> 1) & 1,
            "Disc": (w(9) >> 9) & 1, "Af": (w(0) >> 3) & 1,
            "DecLat": "", "DecLon": "",
        }
        cal = SITE_CAL.get(site)
        if geod is not None and cal is not None:
            alt_nm = max((mc_ft or 0) - cal["alt_site_ft"], 0.0) / FT_PER_NM
            r = max(rng + cal["range_bias_nm"], 0.05)
            ground = math.sqrt(max(r * r - alt_nm * alt_nm, 1e-4))
            lon2, lat2, _ = geod.fwd(cal["lon"], cal["lat"], az, ground * M_PER_NM)
            row["DecLat"] = round(lat2, 4)
            row["DecLon"] = round(lon2, 4)
        yield row


def cmd_decode(args):
    out = args.output or (args.rs3.rsplit(".", 1)[0] + ".decoded.csv")
    n = 0
    with open(out, "w", newline="") as fh:
        wr = csvmod.DictWriter(fh, fieldnames=FIELDS)
        wr.writeheader()
        for row in decode(args.rs3):
            wr.writerow(row)
            n += 1
    print(f"{args.rs3}: {n:,} aircraft messages -> {out}")


def cmd_validate(args):
    import numpy as np
    import pandas as pd
    ours = pd.DataFrame(decode(args.rs3))
    ref = pd.read_csv(args.csv, low_memory=False)
    ref = ref[ref.MsgType.isin(AIRCRAFT_TYPES)].reset_index(drop=True)
    print(f"rows: ours {len(ours):,} vs reference {len(ref):,}")
    if len(ours) != len(ref):
        raise SystemExit("row count mismatch — cannot align")
    def num(s):
        return np.array(pd.to_numeric(s, errors="coerce"), float)
    checks = {
        "Id": (np.asarray(ours.Id) == np.asarray(ref.Id)).mean(),
        "MsgType": (np.asarray(ours.MsgType) == np.asarray(ref.MsgType)).mean(),
        "Time(ms)": (np.abs(num(ours.epoch_s) % 86400
                            - num(ref.Time.map(lambda t: sum(f * float(x) for f, x
                                  in zip((3600, 60, 1), str(t).split(":")))))) < 0.001).mean(),
        "Range": (np.abs(num(ours.Range) - num(ref.Range)) < 1e-6).mean(),
        "AzDegs": (np.abs(num(ours.AzDegs) - num(ref.AzDegs)) < 0.002).mean(),
        # transponder flags exist only on beacon-bearing rows in the export
        "M3V": (num(ours.M3V)[ref.M3V.notna()] == num(ref.M3V)[ref.M3V.notna()]).mean(),
        "MCV": (num(ours.MCV)[ref.MCV.notna()] == num(ref.MCV)[ref.MCV.notna()]).mean(),
    }
    m3v = (num(ours.M3V) == 1) & (num(ref.M3V) == 1)
    checks["M3|valid"] = (num(ours.M3[m3v]) == num(ref.M3[m3v])).mean()
    mcv = (num(ours.MCV) == 1) & (num(ref.MCV) == 1)
    checks["MC|valid"] = (num(ours.MC[mcv]) == num(ref.MC[mcv])).mean()
    pos = ours.DecLat.ne("") & ref.DecLat.notna()
    dla = (num(ours.DecLat[pos]) - num(ref.DecLat[pos])) * 60
    dlo = ((num(ours.DecLon[pos]) - num(ref.DecLon[pos])) * 60
           * np.cos(np.radians(num(ref.DecLat[pos]))))
    err = np.hypot(dla, dlo)
    checks["pos p50 nm"] = float(np.percentile(err, 50))
    checks["pos p95 nm"] = float(np.percentile(err, 95))
    checks["pos<0.25nm"] = float((err < 0.25).mean())
    for k, v in checks.items():
        print(f"  {k:>10}: {v:.5f}")


def cmd_calibrate(args):
    import numpy as np
    import pandas as pd
    from scipy.optimize import least_squares
    geod = _geod()
    ours = pd.DataFrame(decode(args.rs3, with_positions=False))
    ref = pd.read_csv(args.csv, low_memory=False)
    ref = ref[ref.MsgType.isin(AIRCRAFT_TYPES)].reset_index(drop=True)
    if len(ours) != len(ref):
        raise SystemExit("row count mismatch — export must be of the same file")
    ref = ref.assign(_rng=pd.to_numeric(ours.Range), _az=pd.to_numeric(ours.AzDegs),
                     _mc=pd.to_numeric(ours.MC, errors="coerce"))
    for site, g in ref.groupby("Id"):
        g = g[g.DecLat.notna() & g._rng.notna()]
        if len(g) < 500 or str(site).endswith("M4"):
            continue
        g = g.sample(6000, random_state=1) if len(g) > 6000 else g
        rng = np.array(g._rng, float)
        az = np.array(g._az, float)
        la = np.array(pd.to_numeric(g.DecLat), float)
        lo = np.array(pd.to_numeric(g.DecLon), float)
        alt = np.nan_to_num(np.array(g._mc, float), nan=0.0)

        def resid(p):
            sla, slo, rbias, alt_site = p
            alt_nm = np.maximum(alt - alt_site, 0.0) / FT_PER_NM
            r = np.maximum(rng + rbias, 0.05)
            ground = np.sqrt(np.maximum(r ** 2 - alt_nm ** 2, 1e-4))
            plo, pla, _ = geod.fwd(np.full_like(ground, slo), np.full_like(ground, sla),
                                   az, ground * M_PER_NM)
            return np.concatenate([(pla - la) * 60, (plo - lo) * 60 * np.cos(np.radians(la))])
        fit = least_squares(resid, x0=[la.mean(), lo.mean(), 0.0, 0.0], method="lm")
        r = resid(fit.x)
        err = np.hypot(r[:len(rng)], r[len(rng):])
        print(f'    "{site}": {{"lat": {fit.x[0]:.6f}, "lon": {fit.x[1]:.6f}, '
              f'"range_bias_nm": {fit.x[2]:.4f}, "alt_site_ft": {fit.x[3]:.1f}}},'
              f'  # p95 {np.percentile(err, 95):.4f} nm, n={len(g)}')


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("decode", help="RS3 binary -> CSV of aircraft messages")
    d.add_argument("rs3")
    d.add_argument("-o", "--output")
    d.set_defaults(fn=cmd_decode)
    v = sub.add_parser("validate", help="compare decode against an RS3-app CSV export")
    v.add_argument("rs3")
    v.add_argument("csv")
    v.set_defaults(fn=cmd_validate)
    c = sub.add_parser("calibrate", help="fit SITE_CAL entries from a binary+export pair")
    c.add_argument("rs3")
    c.add_argument("csv")
    c.set_defaults(fn=cmd_calibrate)
    args = p.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
