"""Extract a JPEG still from an HLS segment and upload to Wasabi.

``capture_frame`` runs ffmpeg as a subprocess: it downloads the segment
URL directly (ffmpeg handles HTTP), extracts the first video frame, scales
to 160×120, and writes a JPEG. No intermediate download step is needed.

``generate_offline_jpeg`` produces a 160×120 solid-blue JPEG using ffmpeg's
lavfi ``color`` source, matching the gap-filler's blue (0x0000f5).

``ensure_offline_placeholder`` is idempotent: it checks whether
``thumbnails/offline.jpg`` already exists in Wasabi before generating and
uploading — so re-running the flow never overwrites it unnecessarily.
"""
import subprocess
import tempfile
from pathlib import Path

import httpx

from video_grabber.config import Config
from video_grabber.storage.wasabi import _make_s3_client


def capture_frame(segment_url: str, init_url: str | None = None) -> bytes | None:
    """Return the first frame of ``segment_url`` as 160×120 JPEG bytes, or None on error.

    When ``init_url`` is provided (fMP4 / CMAF streams) both the initialization
    segment and the media fragment are downloaded and concatenated before being
    piped to ffmpeg via stdin, because ``.m4s`` fragments cannot be decoded
    without the codec headers in the init segment.
    """
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "thumb.jpg"
        if init_url:
            try:
                combined = httpx.get(init_url, timeout=10).content + httpx.get(segment_url, timeout=10).content
            except Exception:
                return None
            result = subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error",
                 "-i", "pipe:0",
                 "-vframes", "1", "-vf", "scale=160:120", "-q:v", "5",
                 str(out)],
                input=combined,
                capture_output=True,
                timeout=30,
            )
        else:
            result = subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error",
                 "-i", segment_url,
                 "-vframes", "1", "-vf", "scale=160:120", "-q:v", "5",
                 str(out)],
                capture_output=True,
                timeout=30,
            )
        if result.returncode != 0 or not out.exists():
            return None
        return out.read_bytes()


def generate_offline_jpeg() -> bytes:
    """Return a 160×120 JPEG of solid blue (0x0000f5), matching the gap-filler."""
    result = subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "lavfi", "-i", "color=c=0x0000f5:size=160x120:rate=1",
            "-vframes", "1",
            "-q:v", "5",
            "-f", "image2",
            "pipe:1",
        ],
        capture_output=True,
        timeout=15,
    )
    if result.returncode != 0 or not result.stdout:
        raise RuntimeError(f"offline JPEG generation failed: {result.stderr!r}")
    return result.stdout


def upload_thumbnail(slug: str, jpeg_bytes: bytes, cfg: Config, *, s3=None) -> None:
    """Upload ``jpeg_bytes`` to ``thumbnails/{slug}.jpg`` with a 30-second TTL."""
    s3 = s3 or _make_s3_client(cfg)
    s3.put_object(
        Bucket=cfg.wasabi_bucket,
        Key=f"thumbnails/{slug}.jpg",
        Body=jpeg_bytes,
        ContentType="image/jpeg",
        CacheControl="max-age=30",
    )


def ensure_offline_placeholder(cfg: Config, *, s3=None) -> None:
    """Upload ``thumbnails/offline.jpg`` if it does not already exist.

    Idempotent: skips if the object is already present so repeated flow
    runs never re-generate or overwrite the immutable placeholder.
    """
    s3 = s3 or _make_s3_client(cfg)
    try:
        s3.head_object(Bucket=cfg.wasabi_bucket, Key="thumbnails/offline.jpg")
        return  # already present
    except s3.exceptions.ClientError:
        pass
    jpeg = generate_offline_jpeg()
    s3.put_object(
        Bucket=cfg.wasabi_bucket,
        Key="thumbnails/offline.jpg",
        Body=jpeg,
        ContentType="image/jpeg",
        CacheControl="max-age=31536000",
    )
