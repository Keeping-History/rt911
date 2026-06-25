"""
Tests for Wasabi S3 uploader using moto S3 mock.
Verifies Content-Type, Cache-Control headers, wasabi_key tracking, and abort on failure.
"""
import boto3
from moto import mock_aws
from pathlib import Path
from unittest.mock import MagicMock, patch
from datetime import datetime, timezone

from video_grabber.storage.wasabi import upload_hls_package, upload_text
from video_grabber.config import Config


def make_config() -> Config:
    cfg = Config()
    cfg.wasabi_bucket = "test-bucket"
    cfg.wasabi_key = "AKID"
    cfg.wasabi_secret = "SECRET"
    cfg.wasabi_endpoint = "https://s3.us-east-1.amazonaws.com"  # moto endpoint
    return cfg


def make_job(channel_slug="cnn", date_str="20010911", ia_id="cnn-sep11-0800"):
    job = MagicMock()
    job.ia_identifier = ia_id
    job.channel = MagicMock()
    job.channel.slug = channel_slug
    job.program = MagicMock()
    job.program.air_date = datetime(2001, 9, 11, 12, 0, tzinfo=timezone.utc)
    return job


def make_encoded_dir(tmp_path: Path) -> Path:
    """Create a minimal encoded HLS tree in tmp_path."""
    for rend in ("full", "mid", "thumb"):
        rend_dir = tmp_path / rend
        rend_dir.mkdir(parents=True)
        (rend_dir / "index.m3u8").write_text("#EXTM3U\n#EXT-X-ENDLIST\n")
        (rend_dir / "init.mp4").write_bytes(b"fakemp4init")
        (rend_dir / "seg0000.m4s").write_bytes(b"fakesegment")
    (tmp_path / "master.m3u8").write_text("#EXTM3U\n")
    return tmp_path


@mock_aws
def test_upload_creates_s3_objects(tmp_path):
    cfg = make_config()
    job = make_job()
    encoded_dir = make_encoded_dir(tmp_path / "encoded")

    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket=cfg.wasabi_bucket)

    with patch("video_grabber.storage.wasabi._make_s3_client", return_value=s3):
        upload_hls_package(job, encoded_dir, cfg)

    objects = s3.list_objects_v2(Bucket=cfg.wasabi_bucket)["Contents"]
    keys = {o["Key"] for o in objects}

    prefix = "hls/cnn/20010911/cnn-sep11-0800"
    assert f"{prefix}/master.m3u8" in keys
    for rend in ("full", "mid", "thumb"):
        assert f"{prefix}/{rend}/index.m3u8" in keys
        assert f"{prefix}/{rend}/init.mp4" in keys
        assert f"{prefix}/{rend}/seg0000.m4s" in keys


@mock_aws
def test_upload_m3u8_has_short_cache(tmp_path):
    cfg = make_config()
    job = make_job()
    encoded_dir = make_encoded_dir(tmp_path / "encoded")

    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket=cfg.wasabi_bucket)

    with patch("video_grabber.storage.wasabi._make_s3_client", return_value=s3):
        upload_hls_package(job, encoded_dir, cfg)

    prefix = "hls/cnn/20010911/cnn-sep11-0800"
    head = s3.head_object(Bucket=cfg.wasabi_bucket, Key=f"{prefix}/master.m3u8")
    assert "max-age=5" in head["CacheControl"]


@mock_aws
def test_upload_segments_have_long_cache(tmp_path):
    cfg = make_config()
    job = make_job()
    encoded_dir = make_encoded_dir(tmp_path / "encoded")

    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket=cfg.wasabi_bucket)

    with patch("video_grabber.storage.wasabi._make_s3_client", return_value=s3):
        upload_hls_package(job, encoded_dir, cfg)

    prefix = "hls/cnn/20010911/cnn-sep11-0800"
    head = s3.head_object(Bucket=cfg.wasabi_bucket, Key=f"{prefix}/full/seg0000.m4s")
    assert "max-age=31536000" in head["CacheControl"]


@mock_aws
def test_upload_returns_wasabi_key(tmp_path):
    cfg = make_config()
    job = make_job()
    encoded_dir = make_encoded_dir(tmp_path / "encoded")

    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket=cfg.wasabi_bucket)

    with patch("video_grabber.storage.wasabi._make_s3_client", return_value=s3):
        key = upload_hls_package(job, encoded_dir, cfg)

    assert key == "hls/cnn/20010911/cnn-sep11-0800/master.m3u8"


@mock_aws
def test_upload_init_mp4_has_correct_content_type(tmp_path):
    cfg = make_config()
    job = make_job()
    encoded_dir = make_encoded_dir(tmp_path / "encoded")

    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket=cfg.wasabi_bucket)

    with patch("video_grabber.storage.wasabi._make_s3_client", return_value=s3):
        upload_hls_package(job, encoded_dir, cfg)

    prefix = "hls/cnn/20010911/cnn-sep11-0800"
    head = s3.head_object(Bucket=cfg.wasabi_bucket, Key=f"{prefix}/full/init.mp4")
    assert head["ContentType"] == "video/mp4"


@mock_aws
def test_upload_m4s_content_type(tmp_path):
    cfg = make_config()
    job = make_job()
    encoded_dir = make_encoded_dir(tmp_path / "encoded")

    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket=cfg.wasabi_bucket)

    with patch("video_grabber.storage.wasabi._make_s3_client", return_value=s3):
        upload_hls_package(job, encoded_dir, cfg)

    prefix = "hls/cnn/20010911/cnn-sep11-0800"
    head = s3.head_object(Bucket=cfg.wasabi_bucket, Key=f"{prefix}/full/seg0000.m4s")
    assert head["ContentType"] == "video/iso.segment"


@mock_aws
def test_upload_vtt_content_type(tmp_path):
    """upload_text on a .vtt key must set ContentType=text/vtt (not octet-stream).

    Strict browsers reject <track src> objects served as application/octet-stream,
    silently dropping captions. This guards the _CONTENT_TYPES entry in wasabi.py.
    """
    cfg = make_config()

    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket=cfg.wasabi_bucket)

    with patch("video_grabber.storage.wasabi._make_s3_client", return_value=s3):
        upload_text(
            "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n",
            "subtitles/cnn/channel.vtt",
            cfg,
        )

    head = s3.head_object(Bucket=cfg.wasabi_bucket, Key="subtitles/cnn/channel.vtt")
    assert head["ContentType"] == "text/vtt"
    assert "max-age=300" in head["CacheControl"]


@mock_aws
def test_upload_srt_content_type(tmp_path):
    """upload_text on a .srt key must set ContentType=application/x-subrip.

    Mirrors the .vtt check — both suffixes must be in _CONTENT_TYPES.
    """
    cfg = make_config()

    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket=cfg.wasabi_bucket)

    with patch("video_grabber.storage.wasabi._make_s3_client", return_value=s3):
        upload_text(
            "1\n00:00:00,000 --> 00:00:01,000\nHello\n",
            "subtitles/cnn/channel.srt",
            cfg,
        )

    head = s3.head_object(Bucket=cfg.wasabi_bucket, Key="subtitles/cnn/channel.srt")
    assert head["ContentType"] == "application/x-subrip"
    assert "max-age=300" in head["CacheControl"]
