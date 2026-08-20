"""
Slim Wasabi S3 helper for radar frame mirroring.

Client settings ported from video_grabber/storage/wasabi.py (proven against
this exact bucket): SigV4, path addressing, and when_required checksum mode
(boto3 >= 1.36 injects checksum headers Wasabi rejects).
"""

import os

import boto3
from botocore.config import Config as BotoCoreConfig

BUCKET = os.environ.get("WASABI_BUCKET", "files.911realtime.org")


def make_client():
    key = os.environ.get("WASABI_ACCESS_KEY_ID")
    secret = os.environ.get("WASABI_SECRET_ACCESS_KEY")
    if not key:
        raise RuntimeError("WASABI_ACCESS_KEY_ID is not set in the environment")
    if not secret:
        raise RuntimeError("WASABI_SECRET_ACCESS_KEY is not set in the environment")
    return boto3.client(
        "s3",
        endpoint_url=os.environ.get("WASABI_ENDPOINT_URL",
                                    "https://s3.us-central-1.wasabisys.com"),
        aws_access_key_id=key,
        aws_secret_access_key=secret,
        region_name="us-central-1",
        config=BotoCoreConfig(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
            retries={"max_attempts": 10, "mode": "adaptive"},
        ),
    )


def upload_bytes(s3, key, body, content_type, cache_control):
    s3.put_object(Bucket=BUCKET, Key=key, Body=body,
                  ContentType=content_type, CacheControl=cache_control)


def existing_keys(s3, prefix):
    """All object keys under prefix (paginated), as a set."""
    keys, token = set(), None
    while True:
        kw = {"Bucket": BUCKET, "Prefix": prefix}
        if token:
            kw["ContinuationToken"] = token
        resp = s3.list_objects_v2(**kw)
        keys.update(o["Key"] for o in resp.get("Contents", []))
        if not resp.get("IsTruncated"):
            return keys
        token = resp.get("NextContinuationToken")
