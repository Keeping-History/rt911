import build_2001 as b
from building_recon.aoi import AOIS, area_for_point, point_in_aoi


def test_aois_cover_both_zones():
    assert set(AOIS) == {"manhattan", "pentagon"}
    # WTC site is in the manhattan AOI; the Pentagon is in the pentagon AOI.
    assert area_for_point(-74.0134, 40.7127) == "manhattan"
    assert area_for_point(-77.0563, 38.8710) == "pentagon"
    assert area_for_point(0, 0) is None
    assert point_in_aoi(-74.0134, 40.7127, "manhattan") is True


def test_to_height_m_prefers_meters_then_feet():
    assert b.to_height_m({"height_m": 100.0}) == 100.0
    assert abs(b.to_height_m({"height_ft": 100.0}) - 30.48) < 1e-9
    assert b.to_height_m({}) is None


def test_keep_for_2001_drops_post_2001_keeps_unknown():
    assert b.keep_for_2001({"cnstrct_yr": 1970}) is True
    assert b.keep_for_2001({"cnstrct_yr": 2001}) is True
    assert b.keep_for_2001({"cnstrct_yr": 2014}) is False   # One WTC
    assert b.keep_for_2001({"cnstrct_yr": None}) is True    # unknown -> kept
    assert b.keep_for_2001({}) is True


def test_normalize_filters_and_converts():
    raws = [
        {"ring": [[0,0],[0,1],[1,1]], "height_ft": 400.0, "cnstrct_yr": 1972, "area": "manhattan", "source": "nyc"},
        {"ring": [[0,0],[0,1],[1,1]], "height_ft": 900.0, "cnstrct_yr": 2014, "area": "manhattan", "source": "nyc"},  # dropped: post-2001
        {"ring": [[0,0],[0,1],[1,1]], "height_ft": 0.0,   "cnstrct_yr": 1960, "area": "manhattan", "source": "nyc"},  # dropped: no height
    ]
    out = b.normalize(raws)
    assert len(out) == 1
    assert abs(out[0]["height_m"] - 121.92) < 1e-6
    assert out[0]["base_elevation_m"] == 0.0
    assert out[0]["area"] == "manhattan"
