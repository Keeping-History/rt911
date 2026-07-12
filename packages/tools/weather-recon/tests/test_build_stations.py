# tests/test_build_stations.py
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from build_stations import pick_station_rows, station_record  # noqa: E402


def _row(icao, begin, end, usaf="725300", wban="94846", lat="41.995",
         lon="-87.934", elev="200.6", ctry="US", name="CHICAGO O'HARE"):
    return {"USAF": usaf, "WBAN": wban, "STATION NAME": name, "CTRY": ctry,
            "STATE": "IL", "ICAO": icao, "LAT": lat, "LON": lon,
            "ELEV(M)": elev, "BEGIN": begin, "END": end}


def test_pick_keeps_only_rows_covering_the_window():
    rows = [_row("KORD", "19730101", "19991231"),      # ends before window
            _row("KORD", "20000101", "20051231"),      # covers window
            _row("KMSY", "20011001", "20051231")]      # begins after window
    picked = pick_station_rows(rows, {"KORD", "KMSY"})
    assert set(picked) == {"KORD"}
    assert picked["KORD"]["BEGIN"] == "20000101"


def test_pick_prefers_latest_end_when_multiple_rows_cover():
    rows = [_row("KORD", "19730101", "20020101"),
            _row("KORD", "20000101", "20251231")]
    assert pick_station_rows(rows, {"KORD"})["KORD"]["END"] == "20251231"


def test_pick_ignores_icaos_not_in_curated_set():
    assert pick_station_rows([_row("KJFK", "19700101", "20251231")], {"KORD"}) == {}


def test_station_record_shapes_and_types():
    rec = station_record(_row("KORD", "20000101", "20251231"), tz="America/Chicago")
    assert rec == {"station_id": "KORD", "name": "CHICAGO O'HARE",
                   "lat": 41.995, "lon": -87.934, "elevation_m": 200.6,
                   "country": "US", "tz": "America/Chicago", "isd_id": "725300-94846"}


def test_station_record_missing_elevation_becomes_none():
    rec = station_record(_row("KORD", "20000101", "20251231", elev=""),
                         tz="America/Chicago")
    assert rec["elevation_m"] is None
