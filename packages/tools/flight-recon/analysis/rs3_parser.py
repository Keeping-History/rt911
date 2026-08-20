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
    w6      flags: b1=Af b6=Ident b7=MCV b8=M3V b9=M2V
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
import os
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
    "BAR": {"lat": 43.455848, "lon": -65.471774, "range_bias_nm": 0.0248, "alt_site_ft": -1760.6},   # Barrington NS (Canada)
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

# --- SEADS-configured recordings (``SEADS_*.RS3``) -------------------------
# The site-byte -> radar mapping is per-recording-config, NOT global: the same
# byte values name DIFFERENT radars in the SEADS files (verified: same-second
# "GIB" returns differ between 12541200 and SEADS_12541200). These southern
# sites were solved from the data itself — RANSAC on joint observations of
# aircraft whose positions are known from calibrated sites, bootstrapped
# southward in two rounds (see #263). Two independent sanity anchors: byte 10
# fits Fort Fisher NC (= QFF) and byte 16 fits Oceana VA (= OCA) within ~2 nm
# of their NEADS-config fits. Bytes without a converged fit decode without
# positions. SEA00/SEA17 and NEADS WSD never converged across the full
# corpus (idle/test channels with no matchable beacon data) — they decode
# without positions by design.
SEADS_SITE_IDS = {0: "SEA00", 3: "SEA03", 4: "SEA04", 5: "SEA05", 6: "SEA06",
                  7: "SEA07", 8: "SEA08", 9: "SEA09", 10: "SEA10", 11: "SEA11",
                  12: "SEA12", 13: "SEA13", 14: "SEA14", 15: "SEA15",
                  16: "SEA16", 17: "SEA17"}
SEADS_SITE_CAL = {
    "SEA03": {"lat": 29.7986, "lon": -82.9794, "range_bias_nm": -0.542, "alt_site_ft": -8512},   # Cross City FL
    "SEA04": {"lat": 30.407197, "lon": -93.464147, "range_bias_nm": -0.5028, "alt_site_ft": 22104.9},  # Lake Charles LA
    "SEA05": {"lat": 28.1546, "lon": -80.7837, "range_bias_nm": -0.611, "alt_site_ft": 18477},   # Patrick AFB FL
    "SEA06": {"lat": 30.4056, "lon": -81.8547, "range_bias_nm": -0.996, "alt_site_ft": -22360},  # Jacksonville FL
    "SEA07": {"lat": 30.3957, "lon": -89.7431, "range_bias_nm": -0.359, "alt_site_ft": -38650},  # Slidell/Stennis MS
    "SEA08": {"lat": 24.6615, "lon": -81.6707, "range_bias_nm": -1.010, "alt_site_ft": 58546},   # Cudjoe Key FL aerostat
    "SEA09": {"lat": 30.1274, "lon": -85.5745, "range_bias_nm": -0.967, "alt_site_ft": 23005},   # Tyndall AFB FL
    "SEA10": {"lat": 33.9530, "lon": -77.9385, "range_bias_nm": 0.510, "alt_site_ft": 150},      # Fort Fisher NC (QFF)
    "SEA11": {"lat": 27.7678, "lon": -81.9866, "range_bias_nm": -0.866, "alt_site_ft": 6908},    # Avon Park FL
    "SEA12": {"lat": 25.7380, "lon": -80.4952, "range_bias_nm": -1.662, "alt_site_ft": 65912},   # Miami FL
    "SEA13": {"lat": 29.391049, "lon": -96.819518, "range_bias_nm": -0.6567, "alt_site_ft": 4751.8},   # Hallettsville TX
    "SEA14": {"lat": 31.0830, "lon": -88.2012, "range_bias_nm": -0.349, "alt_site_ft": -1589},   # SW Alabama
    "SEA15": {"lat": 33.0950, "lon": -80.2116, "range_bias_nm": -0.772, "alt_site_ft": 11406},   # Charleston SC
    "SEA16": {"lat": 36.8053, "lon": -76.0413, "range_bias_nm": 0.508, "alt_site_ft": -24552},   # Oceana VA (OCA)
}


def tables_for(path):
    """(site_ids, site_cal) for a recording — SEADS-config files are detected
    by filename; everything else uses the validated NEADS-config tables."""
    name = os.path.basename(path).upper()
    if name.startswith("SEADS"):
        return SEADS_SITE_IDS, SEADS_SITE_CAL
    return SITE_IDS, SITE_CAL


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
    site_ids, site_cal = tables_for(path)
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
        site = site_ids.get(words[0] & 0xFF, f"site{words[0] & 0xFF}")
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
            "Disc": (w(9) >> 9) & 1, "Af": (w(6) >> 1) & 1,
            "DecLat": "", "DecLon": "",
        }
        cal = site_cal.get(site)
        if geod is not None and cal is not None:
            alt_nm = max((mc_ft or 0) - cal["alt_site_ft"], 0.0) / FT_PER_NM
            r = max(rng + cal["range_bias_nm"], 0.05)
            ground = math.sqrt(max(r * r - alt_nm * alt_nm, 1e-4))
            lon2, lat2, _ = geod.fwd(cal["lon"], cal["lat"], az, ground * M_PER_NM)
            row["DecLat"] = round(lat2, 4)
            row["DecLon"] = round(lon2, 4)
        yield row


def decode_df(path, with_positions=True):
    """Vectorized decode -> pandas DataFrame (FIELDS columns).

    Same semantics as ``decode()`` but ~50x faster: field math and the WGS84
    geodesic run on whole arrays. Requires numpy/pandas (+ pyproj for
    positions)."""
    import numpy as np
    import pandas as pd
    site_ids, site_cal = tables_for(path)
    rows = []
    for words, _n in iter_messages(path):
        tb = words[1] & 0xFF
        if TYPE_IDS.get(tb) not in AIRCRAFT_TYPES:
            continue
        w = words + (0,) * (14 - len(words))
        rows.append((words[0] & 0xFF, tb, words[3] | (words[4] << 16), words[5],
                     w[6], w[7], w[8], w[9], w[10], w[11], w[12], w[13]))
    if not rows:
        return pd.DataFrame(columns=FIELDS)
    a = np.array(rows, dtype=np.int64)
    site_b, type_b, epoch, fine = a[:, 0], a[:, 1], a[:, 2], a[:, 3]
    w6, w7, w8, w9, w10, w11, w12, w13 = (a[:, i] for i in range(4, 12))
    t = epoch + fine * 20e-6
    m3v = (w6 >> 8) & 1
    mcv = (w6 >> 7) & 1
    mtype = pd.Series(type_b).map(TYPE_IDS)
    site = pd.Series(site_b).map(lambda b: site_ids.get(b, f"site{b}"))
    mc_ft = np.where(mcv == 1, (w12 >> 1) * 100, np.nan)
    rng = (w7 >> 2) / 8.0
    az = (w8 >> 1) * 360.0 / 4096.0
    dt = pd.to_datetime(t, unit="s", utc=True)
    df = pd.DataFrame({
        "Id": site, "MsgType": mtype,
        "Date": dt.strftime("%d %b %Y"),
        "Time": dt.strftime("%H:%M:%S.%f").str[:-3],
        "epoch_s": np.round(t, 6),
        "Range": rng, "AzDegs": np.round(az, 3),
        "M3": np.where(m3v | ((w10 >> 1) > 0),
                       pd.Series(w10 >> 1).map(oct4), ""),
        "M3V": m3v, "M3X": (w9 >> 7) & 1,
        "M2": np.where(((w6 >> 9) & 1) | ((w11 >> 1) > 0),
                       pd.Series(w11 >> 1).map(oct4), ""),
        "M2V": (w6 >> 9) & 1, "M2X": (w9 >> 8) & 1,
        "MC": mc_ft, "MCV": mcv,
        "HeightApprox": np.where(mtype == "Reinf", w13 * 12.5, np.nan),
        "Ident": (w6 >> 6) & 1, "Mrg": (w7 >> 1) & 1,
        "Disc": (w9 >> 9) & 1, "Af": (w6 >> 1) & 1,
        "DecLat": np.nan, "DecLon": np.nan,
    })
    if with_positions:
        try:
            geod = _geod()
        except ImportError:
            return df
        for s, cal in site_cal.items():
            m = np.asarray(df.Id == s)
            if not m.any():
                continue
            alt_nm = np.maximum(np.nan_to_num(mc_ft[m], nan=0.0) - cal["alt_site_ft"], 0.0) / FT_PER_NM
            r = np.maximum(rng[m] + cal["range_bias_nm"], 0.05)
            ground = np.sqrt(np.maximum(r * r - alt_nm * alt_nm, 1e-4))
            lon2, lat2, _ = geod.fwd(np.full(m.sum(), cal["lon"]), np.full(m.sum(), cal["lat"]),
                                     az[m], ground * M_PER_NM)
            df.loc[m, "DecLat"] = np.round(lat2, 4)
            df.loc[m, "DecLon"] = np.round(lon2, 4)
    return df


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


def cmd_solve_sites(args):
    """Solve uncalibrated site positions from joint observations.

    Aircraft whose positions are known from calibrated sites (same squawk,
    same moment, tight cluster) provide ground truth; each uncalibrated
    site's location + biases are fitted by RANSAC over its (range, azimuth)
    returns matched to that truth. This is how the 12 SEADS radars were
    recovered (#263); sanity anchors: SEA10=Fort Fisher(QFF), SEA16=Oceana(OCA)
    within ~2 nm of their independent NEADS fits."""
    import glob as globmod
    import numpy as np
    import pandas as pd
    from scipy.optimize import least_squares
    geod = _geod()
    targets = set(args.sites.split(","))

    frames = []
    for path in sorted(globmod.glob(os.path.join(args.decoded_dir, "*.csv.gz"))):
        df = pd.read_csv(path, usecols=["Id", "epoch_s", "M3", "M3V", "Range", "AzDegs",
                                        "MC", "MCV", "DecLat", "DecLon"], low_memory=False)
        df = df[df.M3V == 1]
        if not (set(df.Id.unique()) & targets):
            # keep a slice anyway: truth can come from any file, but skip
            # whole files with no target rows unless we are short on truth
            pass
        frames.append(df)
    b = pd.concat(frames, ignore_index=True)
    b["bucket"] = (b.epoch_s // 6).astype(int)
    b["mc"] = pd.to_numeric(b.MC, errors="coerce").where(b.MCV == 1)

    ref = b[b.DecLat.notna() & b.mc.notna()]
    grp = ref.groupby(["M3", "bucket"]).agg(
        lat=("DecLat", "mean"), lon=("DecLon", "mean"),
        la0=("DecLat", "min"), la1=("DecLat", "max"),
        lo0=("DecLon", "min"), lo1=("DecLon", "max"), alt=("mc", "mean"))
    tight = grp[((grp.la1 - grp.la0) * 60 < 4) & ((grp.lo1 - grp.lo0) * 50 < 4)]
    truth = {idx: (r.lat, r.lon, r.alt) for idx, r in tight.iterrows()}
    print(f"truth buckets: {len(truth):,} from {len(frames)} decodes")

    rng_state = np.random.RandomState(7)

    def dist(a1, o1, a2, o2):
        return math.hypot((a1 - a2) * 60, (o1 - o2) * 60 * math.cos(math.radians((a1 + a2) / 2)))

    for site in sorted(targets):
        g = b[(b.Id == site) & b.DecLat.isna()]
        if g.empty:
            g = b[b.Id == site]
        samples = []
        for row in g.itertuples(index=False):
            t = (truth.get((row.M3, row.bucket)) or truth.get((row.M3, row.bucket - 1))
                 or truth.get((row.M3, row.bucket + 1)))
            if t:
                samples.append((row.Range, row.AzDegs, *t))
        if len(samples) < 200:
            print(f"{site}: only {len(samples)} joint samples — cannot solve")
            continue
        sarr = np.array(samples[:12000])
        rngs, az, la, lo, alt = sarr.T

        def pred(p):
            alt_nm = np.maximum(alt - p[3], 0.0) / FT_PER_NM
            r = np.maximum(rngs + p[2], 0.05)
            ground = np.sqrt(np.maximum(r ** 2 - alt_nm ** 2, 1e-4))
            plo, pla, _ = geod.fwd(np.full(len(r), p[1]), np.full(len(r), p[0]),
                                   az, ground * M_PER_NM)
            return pla, plo

        def err_of(p):
            pla, plo = pred(p)
            return np.hypot((pla - la) * 60, (plo - lo) * 60 * np.cos(np.radians(la)))

        best = None
        for _ in range(400):
            pick = rng_state.choice(len(sarr), 3, replace=False)

            def r3(p):
                g_ = np.sqrt(np.maximum(rngs[pick] ** 2
                                        - (np.maximum(alt[pick], 0) / FT_PER_NM) ** 2, 1e-4))
                plo, pla, _ = geod.fwd(np.full(3, p[1]), np.full(3, p[0]),
                                       az[pick], g_ * M_PER_NM)
                return np.concatenate([(pla - la[pick]) * 60, (plo - lo[pick]) * 60])
            try:
                f = least_squares(r3, x0=[la[pick].mean(), lo[pick].mean()],
                                  method="lm", max_nfev=60)
            except Exception:
                continue
            e = err_of([f.x[0], f.x[1], 0.0, 0.0])
            inl = e < 2.5
            if best is None or inl.sum() > best[0]:
                best = (int(inl.sum()), f.x, inl)
        if best is None or best[0] < 100:
            print(f"{site}: RANSAC failed ({0 if best is None else best[0]} inliers of {len(sarr)})")
            continue
        m = best[2]

        def rf(p):
            pla, plo = pred(p)
            return np.concatenate([((pla - la) * 60)[m],
                                   ((plo - lo) * 60 * np.cos(np.radians(la)))[m]])
        fit = least_squares(rf, x0=[best[1][0], best[1][1], 0.0, 0.0], method="lm")
        e = err_of(fit.x)
        m2 = e < 0.5
        if m2.sum() > 50:
            def rf2(p):
                pla, plo = pred(p)
                return np.concatenate([((pla - la) * 60)[m2],
                                       ((plo - lo) * 60 * np.cos(np.radians(la)))[m2]])
            fit = least_squares(rf2, x0=fit.x, method="lm")
            e = err_of(fit.x)
        inl = int((e < 0.5).sum())
        ok = inl >= 300 and abs(fit.x[2]) < 3
        print(f'{site}: n={len(sarr):,} inliers={inl:,} ({inl/len(sarr):.0%}) '
              f'fit {fit.x[0]:.6f},{fit.x[1]:.6f} rbias={fit.x[2]:.4f} alt={fit.x[3]:.1f} '
              f'{"ACCEPT" if ok else "REJECT (weak/degenerate)"}')
        if ok:
            print(f'    "{site}": {{"lat": {fit.x[0]:.6f}, "lon": {fit.x[1]:.6f}, '
                  f'"range_bias_nm": {fit.x[2]:.4f}, "alt_site_ft": {fit.x[3]:.1f}}},')


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
    ss = sub.add_parser("solve-sites",
                        help="fit uncalibrated sites from joint observations over decoded csvs")
    ss.add_argument("decoded_dir")
    ss.add_argument("--sites", default="BAR,WSD,SEA00,SEA04,SEA13,SEA17")
    ss.set_defaults(fn=cmd_solve_sites)
    args = p.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
