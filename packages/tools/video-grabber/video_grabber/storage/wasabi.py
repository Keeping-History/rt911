"""
Wasabi S3 uploader for HLS packages.

Key behaviors:
- boto3 ≥ 1.36 checksum regression fix: request_checksum_calculation="when_required"
- addressing_style="path" avoids virtual-hosted DNS issues with Wasabi
- Parallel uploads via TransferConfig(max_concurrency=10)
- Cache-Control: max-age=5 for playlists; max-age=31536000 for immutable segments
"""
import boto3
from boto3.s3.transfer import TransferConfig
from botocore.config import Config as BotoCoreConfig
from pathlib import Path

from video_grabber.config import Config

_CONTENT_TYPES: dict[str, tuple[str, str]] = {
    ".m3u8": ("application/vnd.apple.mpegurl", "max-age=5"),
    ".mp4": ("video/mp4", "max-age=31536000"),   # init.mp4
    ".m4s": ("video/iso.segment", "max-age=31536000"),
    ".json": ("application/json", "max-age=5"),  # EPG guide; changes as content lands
    # Subtitle files. max-age=300 (5 min) because the per-channel SRT/VTT is
    # regenerated in-place as more programs finish (like .m3u8 playlists), so we
    # need a short TTL to avoid stale captions. Per-program/per-MP3 files are
    # immutable in practice but share the same suffix, so we accept the minor
    # over-revalidation rather than splitting the mapping.
    ".vtt": ("text/vtt", "max-age=300"),
    ".srt": ("application/x-subrip", "max-age=300"),
    ".jpg": ("image/jpeg", "max-age=30"),   # channel thumbnails; refreshed every ~30 s
}

_TRANSFER_CONFIG = TransferConfig(
    multipart_threshold=100 * 1024 * 1024,
    multipart_chunksize=50 * 1024 * 1024,
    max_concurrency=10,
)


def _make_s3_client(cfg: Config):
    return boto3.client(
        "s3",
        endpoint_url=cfg.wasabi_endpoint,
        aws_access_key_id=cfg.wasabi_key,
        aws_secret_access_key=cfg.wasabi_secret,
        region_name="us-central-1",
        config=BotoCoreConfig(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            # boto3 ≥ 1.36.0 injects checksum headers that Wasabi rejects
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
            retries={"max_attempts": 10, "mode": "adaptive"},
        ),
    )


def upload_tree(local_dir: Path, key_prefix: str, cfg: Config, *, s3=None) -> None:
    """Upload every file under ``local_dir`` to ``<bucket>/<key_prefix>/...``,
    preserving relative paths and applying per-suffix content-type/cache-control."""
    s3 = s3 or _make_s3_client(cfg)
    for path in sorted(local_dir.rglob("*")):
        if not path.is_file():
            continue
        key = f"{key_prefix}/{path.relative_to(local_dir)}"
        content_type, cache_control = _CONTENT_TYPES.get(
            path.suffix, ("application/octet-stream", "max-age=31536000")
        )
        s3.upload_file(
            str(path),
            cfg.wasabi_bucket,
            key,
            Config=_TRANSFER_CONFIG,
            ExtraArgs={"ContentType": content_type, "CacheControl": cache_control},
        )


def upload_text(content: str, key: str, cfg: Config, *, s3=None) -> None:
    """Upload a string (e.g. an assembled .m3u8) to ``<bucket>/<key>``."""
    s3 = s3 or _make_s3_client(cfg)
    content_type, cache_control = _CONTENT_TYPES.get(
        Path(key).suffix, ("application/octet-stream", "max-age=5")
    )
    s3.put_object(
        Bucket=cfg.wasabi_bucket,
        Key=key,
        Body=content.encode("utf-8"),
        ContentType=content_type,
        CacheControl=cache_control,
    )


def read_text(key: str, cfg: Config, *, s3=None) -> str:
    """Read an object's body as a UTF-8 string."""
    s3 = s3 or _make_s3_client(cfg)
    obj = s3.get_object(Bucket=cfg.wasabi_bucket, Key=key)
    return obj["Body"].read().decode("utf-8")


def list_keys(prefix: str, cfg: Config, *, s3=None) -> list[str]:
    """Return all object keys under ``prefix`` (paginated)."""
    s3 = s3 or _make_s3_client(cfg)
    keys: list[str] = []
    token = None
    while True:
        kw = {"Bucket": cfg.wasabi_bucket, "Prefix": prefix}
        if token:
            kw["ContinuationToken"] = token
        resp = s3.list_objects_v2(**kw)
        keys.extend(o["Key"] for o in resp.get("Contents", []))
        if not resp.get("IsTruncated"):
            return keys
        token = resp["NextContinuationToken"]


def upload_hls_package(job, encoded_dir: Path, cfg: Config) -> str:
    """Upload all files in encoded_dir to Wasabi. Returns the master.m3u8 key."""
    prefix = (
        f"hls/{job.channel.slug}"
        f"/{job.program.air_date.strftime('%Y%m%d')}"
        f"/{job.ia_identifier}"
    )
    upload_tree(encoded_dir, prefix, cfg)
    return f"{prefix}/master.m3u8"
