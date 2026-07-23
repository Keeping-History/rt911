import json
import os

import httpx

from building_recon import sources

DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")

def _load(name):
    with open(os.path.join(DATA, name)) as fh:
        return json.load(fh)

def test_parse_nyc_maps_fields_and_filters_to_aoi():
    out = sources.parse_nyc(_load("sample_nyc_footprints.json"))
    assert out, "expected at least one in-AOI building"
    b = out[0]
    assert b["area"] == "manhattan" and b["source"] == "nyc"
    assert b["height_ft"] is not None and b["cnstrct_yr"] is not None
    assert isinstance(b["ring"][0][0], float)  # lng
    # A feature centered outside the manhattan AOI must be dropped.
    assert all(sources.aoi.point_in_aoi(x["ring"][0][0], x["ring"][0][1], "manhattan") for x in out)

def test_parse_dc_and_arlington_shape():
    dc = sources.parse_dc(_load("sample_dc_footprints.json"))
    arl = sources.parse_arlington(_load("sample_arlington_footprints.json"))
    for coll, area, src in ((dc, "pentagon", "dc"), (arl, "pentagon", "arlington")):
        assert coll and all(b["area"] == area and b["source"] == src for b in coll)
        assert all("ring" in b for b in coll)

def test_fetch_source_uses_injected_client_and_parses():
    payload = _load("sample_nyc_footprints.json")
    def handler(req):
        return httpx.Response(200, json=payload)
    client = httpx.Client(transport=httpx.MockTransport(handler), base_url="https://example.test")
    out = sources.fetch_source.fn("nyc", client=client)  # .fn calls the task body directly
    assert out and out[0]["source"] == "nyc"
