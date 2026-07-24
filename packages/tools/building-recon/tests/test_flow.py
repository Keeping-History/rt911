from building_recon import flow


def test_assemble_from_sources_merges_and_restores_wtc():
    raws = {"nyc": [{"ring": [[-74.0, 40.71], [-74.0, 40.711], [-73.999, 40.711]],
                     "height_ft": 300.0, "cnstrct_yr": 1980, "area": "manhattan", "source": "nyc"}],
            "arlington": []}
    fc, feats, summary = flow.assemble_from_sources(raws)
    assert summary["by_source"]["wtc-curated"] >= 7      # WTC always restored
    assert any(f["properties"]["height_m"] == 417 for f in fc["features"])


def test_flow_orchestrates_without_touching_network(monkeypatch):
    monkeypatch.setattr(flow, "fetch_source", lambda name=None: [])
    captured = {}
    monkeypatch.setattr(flow.directus, "load_buildings",
                         lambda c, rows: captured.update(rows=len(rows)) or {"inserted": len(rows)})
    monkeypatch.setattr(flow, "_directus_client", lambda url: object())
    monkeypatch.setattr(flow.wasabi, "upload_text", lambda k, t, ct: f"https://files.911realtime.org/{k}")
    monkeypatch.setattr(flow.purge, "purge_urls", lambda urls: None)
    out = flow.reconstruct_buildings(sources=["nyc", "arlington"])
    # Even with zero source features, the WTC restoration yields the towers.
    assert out["summary"]["by_source"]["wtc-curated"] >= 7
    assert out["url"].endswith("maps/buildings-2001.geojson")
    assert captured["rows"] == out["summary"]["total"]
