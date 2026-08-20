import pytest

from weather_recon import wasabi


def test_make_client_fails_fast_without_creds(monkeypatch):
    monkeypatch.delenv("WASABI_ACCESS_KEY_ID", raising=False)
    monkeypatch.delenv("WASABI_SECRET_ACCESS_KEY", raising=False)
    with pytest.raises(RuntimeError, match="WASABI_ACCESS_KEY_ID"):
        wasabi.make_client()


def test_make_client_config(monkeypatch):
    monkeypatch.setenv("WASABI_ACCESS_KEY_ID", "k")
    monkeypatch.setenv("WASABI_SECRET_ACCESS_KEY", "s")
    client = wasabi.make_client()
    # Wasabi compat knobs ported from video_grabber.storage.wasabi (verified
    # against a live bucket there): path addressing + when_required checksums.
    cfg = client._client_config
    assert cfg.s3["addressing_style"] == "path"
    assert cfg.request_checksum_calculation == "when_required"
    assert client.meta.endpoint_url == "https://s3.us-central-1.wasabisys.com"


def test_upload_bytes_passes_metadata(monkeypatch):
    calls = []

    class FakeS3:
        def put_object(self, **kw):
            calls.append(kw)

    wasabi.upload_bytes(FakeS3(), "weather/radar/x.png", b"png", "image/png",
                        "max-age=31536000")
    assert calls == [{"Bucket": wasabi.BUCKET, "Key": "weather/radar/x.png",
                      "Body": b"png", "ContentType": "image/png",
                      "CacheControl": "max-age=31536000"}]


def test_existing_keys_paginates():
    class FakeS3:
        def __init__(self):
            self.pages = [
                {"Contents": [{"Key": "weather/radar/a.png"}],
                 "IsTruncated": True, "NextContinuationToken": "t"},
                {"Contents": [{"Key": "weather/radar/b.png"}], "IsTruncated": False},
            ]

        def list_objects_v2(self, **kw):
            return self.pages.pop(0)

    assert wasabi.existing_keys(FakeS3(), "weather/radar/") == {
        "weather/radar/a.png", "weather/radar/b.png"}
