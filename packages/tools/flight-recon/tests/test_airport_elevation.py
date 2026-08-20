import pandas as pd

from flight_recon.airport_elevation import add_elevation, elevation_by_iata


def test_elevation_by_iata_skips_blank_and_missing():
    oa = pd.DataFrame({
        "iata_code": ["DEN", "BOS", "", None],
        "elevation_ft": [5431, 20, 100, 200],
    })
    assert elevation_by_iata(oa) == {"DEN": 5431, "BOS": 20}


def test_add_elevation_fills_zero_for_unknown():
    base = pd.DataFrame({
        "code": ["DEN", "BOS", "XXX"],
        "lat": [39.86, 42.37, 0.0],
        "lon": [-104.67, -71.01, 0.0],
        "utc_offset": [-6, -4, 0],
    })
    out = add_elevation(base, {"DEN": 5431, "BOS": 20})
    by_code = dict(zip(out["code"], out["elevation_ft"]))
    assert by_code == {"DEN": 5431, "BOS": 20, "XXX": 0}
    # Original columns preserved and column order ends with elevation_ft.
    assert list(out.columns) == ["code", "lat", "lon", "utc_offset", "elevation_ft"]
