import build_2001 as b


def test_load_wtc_complex_has_towers():
    wtc = b.load_wtc_complex()
    names = {f["name"] for f in wtc}
    assert any("North" in n for n in names)
    assert any("South" in n for n in names)
    north = next(f for f in wtc if "North" in f["name"])
    assert north["height_m"] == 417
    assert north["area"] == "manhattan"
    assert north["source"] == "wtc-curated"


def test_build_feature_collection_matches_frontend_contract():
    feats = [
        {"ring": [[-74.01, 40.71], [-74.01, 40.711], [-74.009, 40.711]],
         "height_m": 120.0, "base_elevation_m": 4.0, "area": "manhattan", "source": "nyc", "name": None},
    ]
    fc = b.build_feature_collection(feats)
    assert fc["type"] == "FeatureCollection"
    f = fc["features"][0]
    assert f["type"] == "Feature"
    assert f["geometry"]["type"] == "Polygon"
    ring = f["geometry"]["coordinates"][0]
    assert ring[0] == ring[-1]          # closed ring
    props = f["properties"]
    assert props["height_m"] == 120.0 and props["height_m"] > 0
    assert props["base_elevation_m"] == 4.0
    assert props["area"] == "manhattan"
    # Contract: only the three keys the frontend reads.
    assert set(props) == {"height_m", "base_elevation_m", "area"}


def test_assemble_appends_wtc_and_counts():
    raws = [{"ring": [[-74.0,40.71],[-74.0,40.711],[-73.999,40.711]],
             "height_ft": 300.0, "cnstrct_yr": 1980, "area": "manhattan", "source": "nyc"}]
    fc, summary = b.assemble(raws, b.load_wtc_complex())
    towers = [f for f in fc["features"] if f["properties"]["height_m"] in (417, 415)]
    assert len(towers) == 2                       # WTC restored
    assert summary["by_source"]["wtc-curated"] >= 7
    assert summary["total"] == len(fc["features"])
    assert all(f["properties"]["height_m"] > 0 for f in fc["features"])
