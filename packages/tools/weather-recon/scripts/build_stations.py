"""
Build data/stations.csv from NOAA's isd-history.csv and the curated ICAO list.

Dev-run only (output is committed):

    python scripts/build_stations.py            # uses cached data/isd-history.csv if present
    python scripts/build_stations.py --refresh  # re-download the master list

Reports any curated ICAO with no ISD row covering 2001-09-09..12 — trim or
substitute those and re-run until the report is empty.
"""

import argparse
import csv
import sys
from pathlib import Path

ISD_HISTORY_URL = "https://www.ncei.noaa.gov/pub/data/noaa/isd-history.csv"
ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data" / "isd-history.csv"
OUT = ROOT / "data" / "stations.csv"
FIELDS = ["station_id", "name", "lat", "lon", "elevation_m", "country", "tz", "isd_id"]

# Curated station list: major-city METAR sites across the US, Canada and
# Mexico with 2001 coverage. 188 sites; every US state except Delaware, 17 CA / 18 MX.
CURATED_ICAOS = {
    # US — Northeast
    "KBOS", "KPWM", "KBGR", "KBTV", "KMHT", "KPVD", "KBDL", "KALB", "KSYR",
    "KROC", "KBUF", "KJFK", "KLGA", "KEWR", "KPHL", "KABE", "KAVP", "KCXY",
    "KPIT", "KDCA", "KIAD", "KBWI",
    # US — Southeast
    "KRIC", "KORF", "KRDU", "KGSO", "KCLT", "KCAE", "KCHS", "KSAV", "KATL",
    "KTLH", "KJAX", "KMCO", "KTPA", "KMIA", "KPBI", "KEYW",
    "KFMY",  # KRSW substitute: Fort Myers Page Field (KRSW has no 2001-09 rows)
    "KBHM", "KMGM", "KMOB", "KHSV", "KBNA", "KMEM", "KTYS", "KCHA", "KSDF",
    "KLEX", "KCRW", "KJAN",
    # US — Midwest
    "KCLE", "KCMH", "KCVG", "KDAY", "KTOL", "KIND", "KFWA", "KSBN", "KDTW",
    "KGRR", "KLAN", "KORD", "KMDW", "KRFD", "KPIA", "KSPI", "KMLI", "KMKE",
    "KMSN", "KGRB", "KMSP", "KDLH", "KRST", "KFAR", "KBIS", "KFSD", "KRAP",
    "KDSM", "KCID", "KOMA", "KLNK", "KICT", "KSTL", "KMCI", "KSGF", "KCOU",
    # US — South-central
    "KOKC", "KTUL", "KLIT", "KFSM", "KDFW", "KDAL", "KIAH", "KAUS",
    "KSAT", "KELP", "KLBB", "KAMA", "KMAF", "KCRP", "KBRO", "KSHV",
    "KMSY", "KLCH",
    # US — Mountain
    "KDEN", "KCOS", "KPUB", "KGJT", "KCYS", "KCPR", "KBIL", "KGTF", "KBZN",
    "KMSO", "KHLN", "KBOI", "KIDA", "KPIH", "KSLC", "KLAS", "KRNO", "KELY",
    "KPHX", "KTUS", "KFLG", "KYUM", "KABQ", "KROW",
    # US — Pacific
    "KSEA", "KGEG", "KYKM", "KPDX", "KEUG", "KMFR", "KSFO", "KOAK", "KSJC",
    "KSMF", "KFAT", "KBFL", "KLAX", "KSAN", "KSBA", "KMRY", "KRDD",
    # US — Alaska & Hawaii
    "PANC", "PAFA", "PAJN", "PHNL", "PHOG", "PHTO", "PHLI",
    # Canada
    "CYVR", "CYYJ", "CYYC", "CYEG", "CYXE", "CYQR", "CYWG", "CYQT", "CYYZ",
    "CYOW", "CYUL", "CWQB", "CYHZ", "CYSJ", "CYYT", "CYXY", "CYZF",
    # Mexico
    "MMMX", "MMGL", "MMMY", "MMTJ", "MMHO", "MMCS", "MMCU", "MMMZ", "MMSD",
    "MMPR", "MMLO", "MMAA", "MMVR", "MMMD", "MMUN", "MMOX", "MMVA", "MMTM",
}

# pick_station_rows() picks a curated ICAO's isd-history row by exact ICAO
# match + BEGIN/END coverage of the window -- but for these stations that
# row is a dead end against the live NCEI global-hourly API: either its
# USAF is the "999999" placeholder, or its own file simply has no FM-15
# (METAR/SPECI) rows for 2001-09-09..12 (only daily-summary/NEXRAD reports,
# or nothing at all). In each case below a *different* isd-history row for
# the same airport (same coordinates; often a blank-ICAO or placeholder-WBAN
# "period" row whose BEGIN/END metadata looks stale) does carry the hourly
# reports. Verified against the live NCEI API 2026-07-12 -- see
# .superpowers/sdd/task-2a-6-report.md for the per-station investigation.
# KFLG has no working alternate (genuinely no 2001-09 ISD hourly data) and
# is deliberately absent here.
ISD_OVERRIDES = {
    "CYUL": "716270-99999",  # ICAO row 716270-94792 is empty; -99999 has the data
    "KBGR": "726088-14606",  # ICAO row 726070-99999 is empty; period row (END 19971231) has 2001 data anyway
    "KCXY": "725118-99999",  # ICAO row 725118-14751 has only SOD (daily summary) reports, no METAR
    "KDAL": "722583-13960",  # ICAO row 722580-13960 is empty; period row (END 19971231) has 2001 data anyway
    "KMHT": "743945-99999",  # ICAO row 743945-14710 is empty; -99999 has the data
    "KMRY": "724915-99999",  # ICAO row has placeholder USAF 999999-23259 (empty); real-USAF blank-ICAO row has the data
    "KOAK": "724930-99999",  # ICAO row 724930-23230 is empty; -99999 has the data
    "KSMF": "724839-99999",  # ICAO row 724839-93225 is empty; -99999 has the data
    "MMUN": "765906-99999",  # ICAO row 765950-99999 has essentially no data; an earlier-period Cancun Intl row does
}


def pick_station_rows(rows, icaos, start="20010909", end="20010912"):
    """Per ICAO in `icaos`, the isd-history row covering [start, end] with the
    latest END. ICAOs with no covering row are simply absent from the result."""
    picked = {}
    for row in rows:
        icao = (row.get("ICAO") or "").strip()
        if icao not in icaos:
            continue
        if not (row["BEGIN"] <= start and row["END"] >= end):
            continue
        if icao not in picked or row["END"] > picked[icao]["END"]:
            picked[icao] = row
    return picked


def station_record(row, tz):
    """One stations.csv record from an isd-history row."""
    elev = row.get("ELEV(M)", "").strip()
    return {
        "station_id": row["ICAO"].strip(),
        "name": row["STATION NAME"].strip(),
        "lat": float(row["LAT"]),
        "lon": float(row["LON"]),
        "elevation_m": float(elev) if elev else None,
        "country": row["CTRY"].strip(),
        "tz": tz,
        "isd_id": f'{row["USAF"]}-{row["WBAN"]}',
    }


def apply_overrides(records, rows, missing, tf, overrides=ISD_OVERRIDES):
    """Apply `overrides` (ICAO -> "USAF-WBAN") to `records` in place.

    For an ICAO whose record is already in `records` (picked, but with a
    dead isd_id), just repoint its isd_id -- name/lat/lon/elevation/
    country/tz stay as pick_station_rows originally found them. For an
    ICAO in `missing` (pick_station_rows found no covering row at all),
    look the override's USAF-WBAN up in `rows` and build+append a fresh
    record from it (the override row's own ICAO field may be blank or
    wrong, so `station_id` is always set to the curated ICAO, not the
    row's). Mutates `records` and `missing`; returns the set of override
    ICAOs whose USAF-WBAN wasn't found in `rows` at all.
    """
    by_usaf_wban = {(r["USAF"].strip(), r["WBAN"].strip()): r for r in rows}
    by_station_id = {r["station_id"]: r for r in records}

    unresolved = set()
    for icao, isd_id in overrides.items():
        if icao in by_station_id:
            by_station_id[icao]["isd_id"] = isd_id
            continue
        if icao not in missing:
            continue
        usaf, wban = isd_id.split("-")
        override_row = by_usaf_wban.get((usaf, wban))
        if override_row is None:
            unresolved.add(icao)
            continue
        tz = tf.timezone_at(lng=float(override_row["LON"]), lat=float(override_row["LAT"]))
        rec = station_record(override_row, tz)
        rec["station_id"] = icao
        records.append(rec)
        missing.discard(icao)
    return unresolved


def main(refresh=False):
    import httpx
    from timezonefinder import TimezoneFinder

    if refresh or not CACHE.is_file():
        print(f"downloading {ISD_HISTORY_URL} ...")
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_bytes(httpx.get(ISD_HISTORY_URL, timeout=120,
                                    follow_redirects=True).raise_for_status().content)
    with CACHE.open(newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    picked = pick_station_rows(rows, CURATED_ICAOS)

    missing = set(CURATED_ICAOS - set(picked))
    tf = TimezoneFinder()
    records = []
    for icao in sorted(picked):
        row = picked[icao]
        tz = tf.timezone_at(lng=float(row["LON"]), lat=float(row["LAT"]))
        records.append(station_record(row, tz))

    unresolved = apply_overrides(records, rows, missing, tf)
    records.sort(key=lambda r: r["station_id"])

    with OUT.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(records)
    print(f"wrote {len(records)} stations to {OUT}")
    if unresolved:
        print(f"WARNING: {len(unresolved)} ISD_OVERRIDES entries have no matching "
              f"isd-history row: {', '.join(sorted(unresolved))}", file=sys.stderr)
    if missing:
        print(f"WARNING: {len(missing)} curated ICAOs lack 2001-09 ISD coverage: "
              f"{', '.join(sorted(missing))}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true")
    sys.exit(main(refresh=ap.parse_args().refresh))
