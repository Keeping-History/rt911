import boto3
import pytest
from moto import mock_aws

from video_grabber.config import Config
from video_grabber.storage import wasabi

BUCKET = "test-bucket"


@pytest.fixture
def cfg(monkeypatch):
    monkeypatch.setenv("WASABI_BUCKET", BUCKET)
    monkeypatch.setenv("WASABI_ACCESS_KEY_ID", "test")
    monkeypatch.setenv("WASABI_SECRET_ACCESS_KEY", "test")
    return Config()


@pytest.fixture
def s3():
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket=BUCKET)
        yield client


def test_head_object_returns_none_for_missing(cfg, s3):
    assert wasabi.head_object("audio/nope.mp3", cfg, s3=s3) is None


def test_head_object_returns_metadata(cfg, s3):
    s3.put_object(Bucket=BUCKET, Key="audio/a.mp3", Body=b"x",
                  CacheControl="max-age=31536000")
    head = wasabi.head_object("audio/a.mp3", cfg, s3=s3)
    assert head["CacheControl"] == "max-age=31536000"


def test_copy_object_if_absent_copies_once(cfg, s3):
    s3.put_object(Bucket=BUCKET, Key="audio/a.mp3", Body=b"original")
    assert wasabi.copy_object_if_absent("audio/a.mp3", "audio-original/a.mp3", cfg, s3=s3) is True
    # Overwrite audio/ (simulating normalization), then retry the archive:
    s3.put_object(Bucket=BUCKET, Key="audio/a.mp3", Body=b"normalized")
    assert wasabi.copy_object_if_absent("audio/a.mp3", "audio-original/a.mp3", cfg, s3=s3) is False
    body = s3.get_object(Bucket=BUCKET, Key="audio-original/a.mp3")["Body"].read()
    assert body == b"original"      # first write won


def test_download_file_roundtrip(cfg, s3, tmp_path):
    s3.put_object(Bucket=BUCKET, Key="audio/a.mp3", Body=b"bytes")
    dest = wasabi.download_file("audio/a.mp3", tmp_path / "a.mp3", cfg, s3=s3)
    assert dest.read_bytes() == b"bytes"


def test_upload_mp3_sets_content_type_and_cache_control(cfg, s3, tmp_path):
    f = tmp_path / "a.mp3"
    f.write_bytes(b"mp3")
    wasabi.upload_mp3(f, "audio/a.mp3", cfg, cache_control="max-age=31536000", s3=s3)
    head = s3.head_object(Bucket=BUCKET, Key="audio/a.mp3")
    assert head["ContentType"] == "audio/mpeg"
    assert head["CacheControl"] == "max-age=31536000"
