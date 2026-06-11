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


def upload_hls_package(job, encoded_dir: Path, cfg: Config) -> str:
    """Upload all files in encoded_dir to Wasabi. Returns the master.m3u8 key."""
    prefix = (
        f"hls/{job.channel.slug}"
        f"/{job.program.air_date.strftime('%Y%m%d')}"
        f"/{job.ia_identifier}"
    )
    upload_tree(encoded_dir, prefix, cfg)
    return f"{prefix}/master.m3u8"
