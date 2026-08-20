"""delete_window must tolerate a Directus running CACHE_AUTO_PURGE=false, where
a mutating DELETE does not invalidate the cached aggregate-count its verify loop
reads. Without an explicit cache clear the count stays stale and the loop fails
after DELETE_MAX_PASSES even though the rows are gone (observed in prod)."""

import httpx

from flight_recon.directus import DirectusClient


def _stale_cache_directus():
    """A fake Directus whose aggregate-count is served from a snapshot that only
    refreshes on POST /utils/cache/clear — modelling CACHE_AUTO_PURGE=false."""
    state = {"rows": 5, "cached_count": 5, "deletes": 0, "clears": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method == "GET" and path.startswith("/items/"):
            return httpx.Response(200, json={"data": [{"count": str(state["cached_count"])}]})
        if request.method == "DELETE" and path.startswith("/items/"):
            state["deletes"] += 1
            state["rows"] = 0                       # the DELETE really works…
            return httpx.Response(204)              # …but the cache is NOT purged
        if request.method == "POST" and path == "/utils/cache/clear":
            state["clears"] += 1
            state["cached_count"] = state["rows"]   # clear = cache now truthful
            return httpx.Response(200)
        return httpx.Response(404, json={"errors": [{"message": path}]})

    client = DirectusClient("http://directus.test", "tok")
    client._http = httpx.Client(
        transport=httpx.MockTransport(handler),
        base_url="http://directus.test",
        headers={"Authorization": "Bearer tok"},
    )
    return client, state


def test_delete_window_busts_stale_cache_to_observe_completion(monkeypatch):
    monkeypatch.setattr("flight_recon.directus.time.sleep", lambda *_: None)
    client, state = _stale_cache_directus()
    deleted = client.delete_window("flight_tracks", "2001-09-09", "2001-09-12")
    assert deleted == 5
    assert state["deletes"] >= 1
    # The truthful post-delete count is only visible after a cache clear.
    assert state["clears"] >= 1


def test_delete_window_noop_when_window_empty(monkeypatch):
    monkeypatch.setattr("flight_recon.directus.time.sleep", lambda *_: None)
    client, state = _stale_cache_directus()
    state["rows"] = 0
    state["cached_count"] = 0
    deleted = client.delete_window("flight_tracks", "2001-09-09", "2001-09-12")
    assert deleted == 0
    assert state["deletes"] == 0
