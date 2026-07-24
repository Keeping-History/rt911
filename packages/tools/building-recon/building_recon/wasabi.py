"""
Wasabi S3 uploader for the building-footprint reconstruction pipeline.

Mirrors video-grabber's `storage/wasabi.py` client config but kept lean
(bare `os.environ`, no Config dataclass) to match flight-recon's minimal
style — this package uploads a single assembled GeoJSON snapshot, not a
multi-file HLS package, so there's no tree/parallel-transfer machinery here.

Key client behaviors (see video-grabber's wasabi.py for the fuller story):
- boto3 >= 1.36 checksum regression fix: request_checksum_calculation /
  response_checksum_validation = "when_required" (Wasabi rejects the
  checksum headers boto3 injects by default).
- addressing_style="path" avoids virtual-hosted DNS issues with Wasabi.
"""
import os

import boto3
from botocore.config import Config as BotoCoreConfig

_PUBLIC_BASE = "https://files.911realtime.org"


def make_client():
    return boto3.client(
        "s3",
        endpoint_url=os.environ.get(
            "WASABI_ENDPOINT_URL", "https://s3.us-central-1.wasabisys.com"
        ),
        aws_access_key_id=os.environ["WASABI_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["WASABI_SECRET_ACCESS_KEY"],
        region_name="us-central-1",
        config=BotoCoreConfig(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            # boto3 >= 1.36.0 injects checksum headers that Wasabi rejects.
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
        ),
    )


def upload_text(
    key: str, text: str, content_type: str, cache_control: str = "public, max-age=300"
) -> str:
    """Upload `text` to `<bucket>/<key>` and return its public URL."""
    bucket = os.environ.get("WASABI_BUCKET", "files.911realtime.org")
    client = make_client()
    client.put_object(
        Bucket=bucket,
        Key=key,
        Body=text.encode("utf-8"),
        ContentType=content_type,
        CacheControl=cache_control,
    )
    return f"{_PUBLIC_BASE}/{key}"
