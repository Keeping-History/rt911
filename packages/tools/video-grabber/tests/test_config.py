import os
import pytest
from video_grabber.config import Config


def test_defaults_have_correct_types():
    cfg = Config()
    assert isinstance(cfg.database_url, str)
    assert isinstance(cfg.wasabi_endpoint, str)
    assert isinstance(cfg.wasabi_bucket, str)
    assert isinstance(cfg.wasabi_key, str)
    assert isinstance(cfg.wasabi_secret, str)
    assert isinstance(cfg.directus_url, str)
    assert isinstance(cfg.directus_email, str)
    assert isinstance(cfg.directus_password, str)
    assert isinstance(cfg.directus_api_token, str)
    assert isinstance(cfg.ia_rate_per_sec, int)
    assert isinstance(cfg.min_duration_seconds, int)


def test_default_values():
    cfg = Config()
    assert cfg.wasabi_endpoint == "https://s3.us-central-1.wasabisys.com"
    assert cfg.wasabi_bucket == "files.911realtime.org"
    assert cfg.directus_url == "http://localhost:8055"
    assert cfg.ia_rate_per_sec == 2
    assert cfg.min_duration_seconds == 720


def test_env_vars_override_defaults(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://test:test@localhost/test")
    monkeypatch.setenv("WASABI_ENDPOINT_URL", "https://custom.wasabi.com")
    monkeypatch.setenv("WASABI_BUCKET", "custom-bucket")
    monkeypatch.setenv("WASABI_ACCESS_KEY_ID", "AKID123")
    monkeypatch.setenv("WASABI_SECRET_ACCESS_KEY", "secret456")
    monkeypatch.setenv("DIRECTUS_URL", "http://directus:8055")
    monkeypatch.setenv("ADMIN_EMAIL", "admin@example.com")
    monkeypatch.setenv("ADMIN_PASSWORD", "password123")
    monkeypatch.setenv("DIRECTUS_API_TOKEN", "static-token-xyz")
    monkeypatch.setenv("IA_RATE_PER_SEC", "5")
    monkeypatch.setenv("MIN_DURATION_SECONDS", "300")

    cfg = Config()
    assert cfg.database_url == "postgresql://test:test@localhost/test"
    assert cfg.wasabi_endpoint == "https://custom.wasabi.com"
    assert cfg.wasabi_bucket == "custom-bucket"
    assert cfg.wasabi_key == "AKID123"
    assert cfg.wasabi_secret == "secret456"
    assert cfg.directus_url == "http://directus:8055"
    assert cfg.directus_email == "admin@example.com"
    assert cfg.directus_password == "password123"
    assert cfg.directus_api_token == "static-token-xyz"
    assert cfg.ia_rate_per_sec == 5
    assert cfg.min_duration_seconds == 300


def test_ia_rate_per_sec_is_int(monkeypatch):
    monkeypatch.setenv("IA_RATE_PER_SEC", "3")
    cfg = Config()
    assert cfg.ia_rate_per_sec == 3
    assert type(cfg.ia_rate_per_sec) is int


def test_min_duration_seconds_is_int(monkeypatch):
    monkeypatch.setenv("MIN_DURATION_SECONDS", "600")
    cfg = Config()
    assert cfg.min_duration_seconds == 600
    assert type(cfg.min_duration_seconds) is int
