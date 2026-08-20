# tests/test_build_stations.py
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from build_stations import apply_overrides, pick_station_rows, station_record  # noqa: E402


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


class _StubTimezoneFinder:
    """Avoids a real geo lookup in unit tests; records the coordinates it
    was asked to resolve so tests can assert on them if needed."""

    def __init__(self, tz="America/Denver"):
        self.tz = tz
        self.calls = []

    def timezone_at(self, lng, lat):
        self.calls.append((lng, lat))
        return self.tz


def test_apply_overrides_replaces_isd_id_of_picked_station():
    # KORD was picked via its curated-ICAO row (dead placeholder WBAN), but
    # a different USAF-WBAN row for the same airport actually has data.
    picked_row = _row("KORD", "19730101", "20251231", usaf="725300", wban="99999")
    record = station_record(picked_row, tz="America/Chicago")
    rows = [picked_row, _row("KORD", "20000101", "20251231",
                              usaf="725300", wban="94846")]
    tf = _StubTimezoneFinder()
    missing = set()
    unresolved = apply_overrides([record], rows, missing, tf,
                                  overrides={"KORD": "725300-94846"})

    assert unresolved == set()
    assert missing == set()
    assert record["isd_id"] == "725300-94846"
    # everything else about the picked station is untouched
    assert record["name"] == "CHICAGO O'HARE"
    assert record["lat"] == 41.995
    assert record["tz"] == "America/Chicago"
    assert tf.calls == []            # no geo lookup needed for a replace


def test_apply_overrides_rescues_an_unpicked_station():
    # KMSY wasn't picked at all (its curated-ICAO row has no isd-history
    # entry covering the window), but the override's USAF-WBAN row does.
    override_row = _row("", "20000101", "20251231", usaf="722310", wban="12916",
                        lat="29.993", lon="-90.258", elev="2.7",
                        name="NEW ORLEANS INTL")
    rows = [override_row]
    tf = _StubTimezoneFinder(tz="America/Chicago")
    records = []
    missing = {"KMSY"}
    unresolved = apply_overrides(records, rows, missing, tf,
                                  overrides={"KMSY": "722310-12916"})

    assert unresolved == set()
    assert missing == set()
    assert len(records) == 1
    rec = records[0]
    assert rec["station_id"] == "KMSY"    # curated ICAO, not the row's blank one
    assert rec["name"] == "NEW ORLEANS INTL"
    assert rec["lat"] == 29.993
    assert rec["lon"] == -90.258
    assert rec["elevation_m"] == 2.7
    assert rec["isd_id"] == "722310-12916"
    assert rec["tz"] == "America/Chicago"
    assert tf.calls == [(-90.258, 29.993)]


def test_apply_overrides_reports_unresolved_override():
    # The override id itself isn't in isd-history (typo, or NCEI retired it)
    # -- apply_overrides must say so rather than silently doing nothing.
    tf = _StubTimezoneFinder()
    unresolved = apply_overrides([], [], {"KXXX"}, tf,
                                  overrides={"KXXX": "999999-99999"})
    assert unresolved == {"KXXX"}


def test_apply_overrides_leaves_non_overridden_stations_alone():
    picked_row = _row("KORD", "19730101", "20251231")
    other_row = _row("KMSY", "19730101", "20251231", usaf="722310", wban="12916")
    ord_record = station_record(picked_row, tz="America/Chicago")
    msy_record = station_record(other_row, tz="America/Chicago")
    tf = _StubTimezoneFinder()

    unresolved = apply_overrides([ord_record, msy_record], [picked_row, other_row],
                                 set(), tf, overrides={"KMSY": "722310-12916"})

    assert unresolved == set()
    assert ord_record["isd_id"] == "725300-94846"    # untouched (no KORD override)
    assert msy_record["isd_id"] == "722310-12916"     # no-op: already this id
