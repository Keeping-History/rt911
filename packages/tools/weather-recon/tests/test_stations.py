import pytest

from weather_recon.stations import load_stations

HEADER = "station_id,name,lat,lon,elevation_m,country,tz,isd_id\n"
GOOD = 'KORD,CHICAGO OHARE,41.995,-87.934,200.6,US,America/Chicago,725300-94846\n'


def _write(tmp_path, body):
    p = tmp_path / "stations.csv"
    p.write_text(HEADER + body, encoding="utf-8")
    return p


def test_loads_and_types_a_valid_row(tmp_path):
    rows = load_stations(_write(tmp_path, GOOD))
    assert rows == [{"station_id": "KORD", "name": "CHICAGO OHARE", "lat": 41.995,
                     "lon": -87.934, "elevation_m": 200.6, "country": "US",
                     "tz": "America/Chicago", "isd_id": "725300-94846",
                     "wfo": "", "nws_zone": ""}]


def test_empty_elevation_is_none(tmp_path):
    rows = load_stations(_write(
        tmp_path, 'CYYZ,TORONTO PEARSON,43.68,-79.63,,CA,America/Toronto,712650-99999\n'))
    assert rows[0]["elevation_m"] is None


@pytest.mark.parametrize("bad,msg", [
    ('KORD,X,91.0,-87.9,1,US,America/Chicago,1-2\n', "lat"),
    ('KORD,X,41.9,-187.9,1,US,America/Chicago,1-2\n', "lon"),
    ('KORD,X,41.9,-87.9,1,FR,Europe/Paris,1-2\n', "country"),
    ('KORD,X,41.9,-87.9,1,US,,1-2\n', "tz"),
    ('KORD,X,41.9,-87.9,1,US,America/Chicago,\n', "isd_id"),
    (GOOD + GOOD, "duplicate"),
])
def test_rejects_invalid_rows(tmp_path, bad, msg):
    with pytest.raises(ValueError, match=msg):
        load_stations(_write(tmp_path, bad))


def test_rejects_missing_columns(tmp_path):
    p = tmp_path / "stations.csv"
    p.write_text("station_id,name\nKORD,X\n", encoding="utf-8")
    with pytest.raises(ValueError, match="column"):
        load_stations(p)


def test_committed_csv_is_valid():
    from pathlib import Path
    rows = load_stations(Path(__file__).resolve().parents[1] / "data" / "stations.csv")
    assert len(rows) >= 150
    assert {r["country"] for r in rows} == {"US", "CA", "MX"}


HEADER10 = ("station_id,name,lat,lon,elevation_m,country,tz,isd_id,wfo,nws_zone\n")
GOOD10 = ('KORD,CHICAGO OHARE,41.995,-87.934,200.6,US,America/Chicago,'
          '725300-94846,LOT,ILZ013\n')


def test_loads_ten_column_row(tmp_path):
    p = tmp_path / "stations.csv"
    p.write_text(HEADER10 + GOOD10, encoding="utf-8")
    rows = load_stations(p)
    assert rows[0]["wfo"] == "LOT" and rows[0]["nws_zone"] == "ILZ013"


def test_ten_column_allows_empty_wfo_zone_for_ca_mx(tmp_path):
    p = tmp_path / "stations.csv"
    p.write_text(HEADER10 + 'CYYZ,TORONTO,43.68,-79.63,,CA,America/Toronto,'
                            '712650-99999,,\n', encoding="utf-8")
    rows = load_stations(p)
    assert rows[0]["wfo"] == "" and rows[0]["nws_zone"] == ""


def test_eight_column_header_still_accepted(tmp_path):
    p = tmp_path / "stations.csv"
    p.write_text(HEADER + GOOD, encoding="utf-8")
    rows = load_stations(p)
    assert rows[0]["wfo"] == "" and rows[0]["nws_zone"] == ""
