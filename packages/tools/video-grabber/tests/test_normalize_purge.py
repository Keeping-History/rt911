import logging

import respx
from httpx import Response

from video_grabber.config import Config
from video_grabber.normalize.purge import purge_urls


def _cfg(monkeypatch):
    monkeypatch.setenv("CF_API_TOKEN", "tok")
    monkeypatch.setenv("CF_ZONE_ID", "zone1")
    return Config()


@respx.mock
def test_purge_posts_urls(monkeypatch):
    cfg = _cfg(monkeypatch)
    route = respx.post("https://api.cloudflare.com/client/v4/zones/zone1/purge_cache").mock(
        return_value=Response(200, json={"success": True})
    )
    assert purge_urls(["https://files.911realtime.org/audio/a.mp3"], cfg,
                      logging.getLogger("t")) is True
    body = route.calls[0].request.content
    assert b"audio/a.mp3" in body
    assert route.calls[0].request.headers["authorization"] == "Bearer tok"


@respx.mock
def test_purge_failure_is_swallowed(monkeypatch, caplog):
    cfg = _cfg(monkeypatch)
    respx.post("https://api.cloudflare.com/client/v4/zones/zone1/purge_cache").mock(
        return_value=Response(500, json={"success": False})
    )
    with caplog.at_level(logging.WARNING):
        assert purge_urls(["https://x/a.mp3"], cfg, logging.getLogger("t")) is False
    assert "purge" in caplog.text.lower()


@respx.mock
def test_purge_200_non_json_body_is_swallowed(monkeypatch, caplog):
    cfg = _cfg(monkeypatch)
    respx.post("https://api.cloudflare.com/client/v4/zones/zone1/purge_cache").mock(
        return_value=Response(200, text="<html>gateway</html>")
    )
    with caplog.at_level(logging.WARNING):
        assert purge_urls(["https://x/a.mp3"], cfg, logging.getLogger("t")) is False
    assert "purge" in caplog.text.lower()


def test_purge_without_credentials_warns_and_skips(monkeypatch, caplog):
    monkeypatch.delenv("CF_API_TOKEN", raising=False)
    monkeypatch.delenv("CF_ZONE_ID", raising=False)
    with caplog.at_level(logging.WARNING):
        assert purge_urls(["https://x/a.mp3"], Config(), logging.getLogger("t")) is False
