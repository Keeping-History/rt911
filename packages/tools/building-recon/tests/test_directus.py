import httpx

from building_recon import directus


class FakeDirectus:
    """Minimal Directus: buildings collection with cache-count-after-delete quirk."""

    def __init__(self):
        self.items = []
        self.collection = False
        self.cached_count = 0  # only refreshed by /utils/cache/clear (CACHE_AUTO_PURGE=false)

    def handler(self, req: httpx.Request) -> httpx.Response:
        import json
        p = req.url.path
        if p == "/collections/buildings":
            return httpx.Response(200 if self.collection else 403, json={"data": {}} if self.collection else {})
        if p == "/collections" and req.method == "POST":
            self.collection = True
            return httpx.Response(200, json={"data": {}})
        if p.startswith("/fields/buildings"):
            return httpx.Response(200, json={"data": []})
        if p == "/utils/cache/clear":
            self.cached_count = len(self.items)
            return httpx.Response(200, json={})
        if p == "/items/buildings" and req.method == "DELETE":
            self.items = []
            return httpx.Response(204)
        if p == "/items/buildings" and req.method == "POST":
            body = json.loads(req.content)
            self.items.extend(body if isinstance(body, list) else [body])
            return httpx.Response(200, json={"data": body})
        if p == "/items/buildings" and req.method == "GET":
            # aggregate count reads the STALE cached value
            return httpx.Response(200, json={"data": [{"count": self.cached_count}]})
        return httpx.Response(404, json={})


def make_client(monkeypatch):
    fake = FakeDirectus()
    c = directus.DirectusClient("https://d.test", "tok")
    c._http = httpx.Client(transport=httpx.MockTransport(fake.handler), base_url="https://d.test",
                           headers={"Authorization": "Bearer tok"})
    monkeypatch.setattr("building_recon.directus.time.sleep", lambda *_: None)
    return c, fake


def test_rows_from_building_features_populates_canonical_fields():
    feats = [
        {"ring": [[0, 0], [0, 1], [1, 1]], "height_m": 100.0, "base_elevation_m": 4.0,
         "area": "manhattan", "source": "nyc", "name": "Some Building", "cnstrct_yr": 1972},
    ]
    rows = directus.rows_from_building_features(feats)
    assert len(rows) == 1
    row = rows[0]
    assert row["source"] == "nyc"
    assert row["name"] == "Some Building"
    assert row["cnstrct_yr"] == 1972
    assert row["height_m"] == 100.0
    assert row["base_elevation_m"] == 4.0
    assert row["is_hero"] is False
    assert row["geometry"] == {
        "type": "Polygon",
        "coordinates": [[[0, 0], [0, 1], [1, 1], [0, 0]]],
    }


def test_load_buildings_is_idempotent_and_counts_through_cache(monkeypatch):
    c, fake = make_client(monkeypatch)
    rows = directus.rows_from_features([
        {"geometry": {"type": "Polygon", "coordinates": [[[0, 0], [0, 1], [1, 1], [0, 0]]]},
         "properties": {"height_m": 100.0, "base_elevation_m": 4.0, "area": "manhattan"}},
    ] * 3)  # rows_from_features accepts assembled features; see note
    res = directus.load_buildings(c, rows)
    assert res["inserted"] == 3
    # Re-running replaces, not appends (delete-then-insert): still 3.
    res2 = directus.load_buildings(c, rows)
    assert res2["inserted"] == 3
    assert len(fake.items) == 3
