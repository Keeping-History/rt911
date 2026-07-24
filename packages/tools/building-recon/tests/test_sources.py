import json
import os

import httpx

from building_recon import sources

DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")


def _load(name):
    with open(os.path.join(DATA, name)) as fh:
        return json.load(fh)


def test_parse_nyc_maps_fields_and_filters_to_aoi():
    # NYC returns MultiPolygon geometry with height_roof/construction_year/
    # ground_elevation (all feet where dimensional).
    out = sources.parse_nyc(_load("sample_nyc_footprints.json"))
    assert out, "expected at least one in-AOI building"
    b = out[0]
    assert b["area"] == "manhattan" and b["source"] == "nyc"
    assert b["height_ft"] is not None and b["cnstrct_yr"] is not None
    assert b["base_elevation_m"] > 0  # ground_elevation (ft) -> m
    assert isinstance(b["ring"][0][0], float)  # lng
    # Only in-AOI features survive (the -73.95 feature is dropped).
    assert all(sources.aoi.point_in_aoi(x["ring"][0][0], x["ring"][0][1], "manhattan") for x in out)
    assert len(out) == 1


def test_parse_arlington_shape_and_feet():
    # Arlington 'Building Heights': Polygon geometry, height + ground elevation
    # in feet, no construction year.
    arl = sources.parse_arlington(_load("sample_arlington_footprints.json"))
    assert arl and all(b["area"] == "pentagon" and b["source"] == "arlington" for b in arl)
    b = arl[0]
    assert b["height_ft"] is not None
    assert b["base_elevation_m"] > 0
    assert b["cnstrct_yr"] is None
    assert "ring" in b


def test_fetch_source_uses_injected_client_and_parses():
    payload = _load("sample_nyc_footprints.json")

    def handler(req):
        return httpx.Response(200, json=payload)

    client = httpx.Client(transport=httpx.MockTransport(handler), base_url="https://example.test")
    out = sources.fetch_source.fn("nyc", client=client)  # .fn calls the task body directly
    assert out and out[0]["source"] == "nyc"
