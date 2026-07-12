"""
GHCN-Daily helpers for the almanac flow.

Values from NCEI daily-summaries CSV are tenths (degC*10 / mm*10), padded
with whitespace, empty when missing (verified live). All almanac math
honors the cutoff date -- records set during the replay window must not
appear (anachronism rule).
"""

import csv
import io
import math

EARTH_RADIUS_KM = 6371.0


def derive_ghcn_id(isd_id):
    """US WBAN-based GHCN id; None when the WBAN is the 99999 placeholder."""
    wban = isd_id.split("-")[1]
    if wban == "99999":
        return None
    return f"USW000{wban}"


def parse_ghcnd_stations(text):
    """Fixed-width ghcnd-stations.txt -> [{id, lat, lon, name}]."""
    out = []
    for line in text.splitlines():
        if len(line) < 40:
            continue
        out.append({"id": line[0:11].strip(), "lat": float(line[12:20]),
                    "lon": float(line[21:30]), "name": line[38:71].strip()})
    return out


def _haversine_km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def nearest_ghcn(lat, lon, stations, max_km=20.0):
    """Haversine-nearest station id within max_km, or None if none qualify."""
    best, best_km = None, max_km
    for st in stations:
        km = _haversine_km(lat, lon, st["lat"], st["lon"])
        if km <= best_km:
            best, best_km = st["id"], km
    return best


def _tenths(v):
    v = (v or "").strip()
    return round(int(v) / 10.0, 1) if v not in ("", "9999", "-9999") else None


def parse_daily_rows(text):
    """NCEI daily-summaries CSV -> [{date, prcp_mm, tmax_c, tmin_c}]."""
    return [{"date": r["DATE"], "prcp_mm": _tenths(r.get("PRCP")),
             "tmax_c": _tenths(r.get("TMAX")), "tmin_c": _tenths(r.get("TMIN"))}
            for r in csv.DictReader(io.StringIO(text))]


def compute_almanac(rows, month_days, cutoff="2001-09-08",
                    normal_start=1971, normal_end=2000):
    """Per MM-DD: record high/low/precip (ties -> latest year) + normal means."""
    out = {}
    for md in month_days:
        day_rows = sorted(
            (r for r in rows if r["date"][5:] == md and r["date"] <= cutoff),
            key=lambda r: r["date"],
        )
        entry = {"record_high_c": None, "record_high_year": None,
                 "record_low_c": None, "record_low_year": None,
                 "normal_high_c": None, "normal_low_c": None,
                 "record_precip_mm": None, "record_precip_year": None}
        highs, lows = [], []
        for r in day_rows:
            year = int(r["date"][:4])
            if r["tmax_c"] is not None:
                if (entry["record_high_c"] is None
                        or r["tmax_c"] >= entry["record_high_c"]):
                    entry["record_high_c"], entry["record_high_year"] = r["tmax_c"], year
                if normal_start <= year <= normal_end:
                    highs.append(r["tmax_c"])
            if r["tmin_c"] is not None:
                if (entry["record_low_c"] is None
                        or r["tmin_c"] <= entry["record_low_c"]):
                    entry["record_low_c"], entry["record_low_year"] = r["tmin_c"], year
                if normal_start <= year <= normal_end:
                    lows.append(r["tmin_c"])
            if r["prcp_mm"] is not None and (
                entry["record_precip_mm"] is None
                or r["prcp_mm"] >= entry["record_precip_mm"]
            ):
                entry["record_precip_mm"], entry["record_precip_year"] = (
                    r["prcp_mm"], year
                )
        if highs:
            entry["normal_high_c"] = round(sum(highs) / len(highs), 1)
        if lows:
            entry["normal_low_c"] = round(sum(lows) / len(lows), 1)
        out[md] = entry
    return out
