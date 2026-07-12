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
# Mexico with 2001 coverage. ~175 sites; every US state, ~13 CA / ~15 MX.
CURATED_ICAOS = {
    # US — Northeast
    "KBOS", "KPWM", "KBGR", "KBTV", "KMHT", "KPVD", "KBDL", "KALB", "KSYR",
    "KROC", "KBUF", "KJFK", "KLGA", "KEWR", "KPHL", "KABE", "KAVP", "KCXY",
    "KPIT", "KDCA", "KIAD", "KBWI",
    # US — Southeast
    "KRIC", "KORF", "KRDU", "KGSO", "KCLT", "KCAE", "KCHS", "KSAV", "KATL",
    "KTLH", "KJAX", "KMCO", "KTPA", "KMIA", "KPBI", "KEYW",
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


def main(refresh=False):
    import httpx
    from timezonefinder import TimezoneFinder

    if refresh or not CACHE.is_file():
        print(f"downloading {ISD_HISTORY_URL} ...")
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_bytes(httpx.get(ISD_HISTORY_URL, timeout=120,
                                    follow_redirects=True).raise_for_status().content)
    with CACHE.open(newline="", encoding="utf-8") as f:
        picked = pick_station_rows(csv.DictReader(f), CURATED_ICAOS)

    missing = sorted(CURATED_ICAOS - set(picked))
    tf = TimezoneFinder()
    records = []
    for icao in sorted(picked):
        row = picked[icao]
        tz = tf.timezone_at(lng=float(row["LON"]), lat=float(row["LAT"]))
        records.append(station_record(row, tz))

    with OUT.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(records)
    print(f"wrote {len(records)} stations to {OUT}")
    if missing:
        print(f"WARNING: {len(missing)} curated ICAOs lack 2001-09 ISD coverage: "
              f"{', '.join(missing)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true")
    sys.exit(main(refresh=ap.parse_args().refresh))
