import boto3
import httpx
from moto import mock_aws


@mock_aws
def test_upload_text_puts_object_and_returns_public_url(monkeypatch):
    monkeypatch.setenv("WASABI_ENDPOINT_URL", "https://s3.us-central-1.wasabisys.com")
    monkeypatch.setenv("WASABI_BUCKET", "files.911realtime.org")
    monkeypatch.setenv("WASABI_ACCESS_KEY_ID", "k")
    monkeypatch.setenv("WASABI_SECRET_ACCESS_KEY", "s")
    # moto only recognizes non-AWS S3 endpoints (Wasabi is S3-compatible, not
    # AWS) when told about them explicitly.
    monkeypatch.setenv("MOTO_S3_CUSTOM_ENDPOINTS", "https://s3.us-central-1.wasabisys.com")
    # Pre-create the bucket in moto. us-central-1 isn't us-east-1, so S3
    # (and moto) require an explicit LocationConstraint on CreateBucket.
    boto3.client("s3", region_name="us-central-1").create_bucket(
        Bucket="files.911realtime.org",
        CreateBucketConfiguration={"LocationConstraint": "us-central-1"},
    )
    from building_recon import wasabi
    url = wasabi.upload_text("maps/buildings-2001.geojson", '{"ok":true}', "application/json")
    assert url == "https://files.911realtime.org/maps/buildings-2001.geojson"
    body = boto3.client("s3", region_name="us-central-1").get_object(
        Bucket="files.911realtime.org", Key="maps/buildings-2001.geojson")["Body"].read()
    assert body == b'{"ok":true}'


def test_purge_urls_is_best_effort(monkeypatch):
    from building_recon import purge
    monkeypatch.delenv("CF_API_TOKEN", raising=False)
    purge.purge_urls(["https://files.911realtime.org/maps/buildings-2001.geojson"])  # no creds -> no-op, no raise
    calls = {"n": 0}

    def handler(req):
        calls["n"] += 1
        return httpx.Response(200, json={"success": True})

    monkeypatch.setenv("CF_API_TOKEN", "t")
    monkeypatch.setenv("CF_ZONE_ID", "z")
    purge.purge_urls(["https://x"], client=httpx.Client(transport=httpx.MockTransport(handler)))
    assert calls["n"] == 1
