"""Load and validate the curated station reference CSV (data/stations.csv)."""

import csv

COLUMNS = ["station_id", "name", "lat", "lon", "elevation_m", "country", "tz", "isd_id"]
COUNTRIES = {"US", "CA", "MX"}


def load_stations(path):
    """Parse stations.csv into typed dicts; raise ValueError on any bad row."""
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames != COLUMNS:
            raise ValueError(f"{path}: expected columns {COLUMNS}, got {reader.fieldnames}")
        rows, seen = [], set()
        for i, raw in enumerate(reader, start=2):
            where = f"{path}:{i} ({raw.get('station_id')!r})"
            sid = (raw["station_id"] or "").strip()
            if not sid:
                raise ValueError(f"{where}: empty station_id")
            if sid in seen:
                raise ValueError(f"{where}: duplicate station_id")
            seen.add(sid)
            lat, lon = float(raw["lat"]), float(raw["lon"])
            if not -90 <= lat <= 90:
                raise ValueError(f"{where}: lat {lat} out of range")
            if not -180 <= lon <= 180:
                raise ValueError(f"{where}: lon {lon} out of range")
            if raw["country"] not in COUNTRIES:
                raise ValueError(f"{where}: country {raw['country']!r} not in {COUNTRIES}")
            for req in ("name", "tz", "isd_id"):
                if not (raw[req] or "").strip():
                    raise ValueError(f"{where}: empty {req}")
            elev = (raw["elevation_m"] or "").strip()
            rows.append({"station_id": sid, "name": raw["name"].strip(),
                         "lat": lat, "lon": lon,
                         "elevation_m": float(elev) if elev else None,
                         "country": raw["country"], "tz": raw["tz"].strip(),
                         "isd_id": raw["isd_id"].strip()})
    if not rows:
        raise ValueError(f"{path}: no station rows")
    return rows
