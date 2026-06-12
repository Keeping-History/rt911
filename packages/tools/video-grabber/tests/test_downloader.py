"""
Tests for resumable download worker.
Uses httpx-mock to simulate IA S3 responses without real network calls.
"""
import pytest
import respx
import httpx
from unittest.mock import MagicMock, patch

from video_grabber.pipeline.downloader import (
    download_item,
    select_best_file,
    get_ia_files,
)


IA_FILES_MP4 = [
    {"name": "broadcast.mp4", "format": "MPEG4", "size": "1073741824"},
    {"name": "broadcast.ogv", "format": "Ogg Video", "size": "800000000"},
    {"name": "broadcast_512kb.mp4", "format": "512Kb MPEG4", "size": "200000000"},
]

IA_FILES_MPG = [
    {"name": "broadcast.mpg", "format": "MPEG2", "size": "2000000000"},
    {"name": "broadcast.ogv", "format": "Ogg Video", "size": "800000000"},
]

IA_FILES_OGV_ONLY = [
    {"name": "broadcast.ogv", "format": "Ogg Video", "size": "800000000"},
]


# --- select_best_file ---

def test_prefer_mp4_over_mpg():
    best = select_best_file(IA_FILES_MP4)
    assert best["name"].endswith(".mp4")
    assert "512kb" not in best["name"].lower()  # prefer full-res mp4


def test_prefer_mpg_over_ogv():
    best = select_best_file(IA_FILES_MPG)
    assert best["name"].endswith(".mpg")


def test_ogv_fallback():
    best = select_best_file(IA_FILES_OGV_ONLY)
    assert best["name"].endswith(".ogv")


def test_no_files_raises():
    with pytest.raises(ValueError, match="no suitable file"):
        select_best_file([])


# --- download_item ---

def make_job(ia_identifier="cnn-sep11-0800"):
    job = MagicMock()
    job.ia_identifier = ia_identifier
    return job


@respx.mock
def test_download_creates_file(tmp_path):
    job = make_job()
    content = b"fake video content " * 1000

    respx.get(
        "https://archive.org/metadata/cnn-sep11-0800/files"
    ).mock(return_value=httpx.Response(200, json={"result": IA_FILES_MP4}))

    respx.get(
        "https://archive.org/download/cnn-sep11-0800/broadcast.mp4"
    ).mock(return_value=httpx.Response(200, content=content))

    with patch("video_grabber.pipeline.downloader.update_bytes_downloaded"):
        result = download_item(job, tmp_path)

    assert result.exists()
    assert result.read_bytes() == content


@respx.mock
def test_download_resume_sends_range_header(tmp_path):
    """If file exists with partial content, resume with Range header."""
    job = make_job()
    partial = b"x" * 512
    dest_dir = tmp_path / job.ia_identifier
    dest_dir.mkdir(parents=True)
    dest_file = dest_dir / "broadcast.mp4"
    dest_file.write_bytes(partial)

    remaining = b"y" * 512

    respx.get(
        "https://archive.org/metadata/cnn-sep11-0800/files"
    ).mock(return_value=httpx.Response(200, json={"result": IA_FILES_MP4}))

    # Should receive a Range request
    def check_range(request):
        assert "range" in request.headers, "Expected Range header for resume"
        assert request.headers["range"] == "bytes=512-"
        return httpx.Response(206, content=remaining)

    respx.get(
        "https://archive.org/download/cnn-sep11-0800/broadcast.mp4"
    ).mock(side_effect=check_range)

    with patch("video_grabber.pipeline.downloader.update_bytes_downloaded"):
        result = download_item(job, tmp_path)

    assert result.read_bytes() == partial + remaining


@respx.mock
def test_download_updates_bytes_downloaded(tmp_path):
    job = make_job()
    content = b"a" * 2 * 1024 * 1024  # 2 MB

    respx.get(
        "https://archive.org/metadata/cnn-sep11-0800/files"
    ).mock(return_value=httpx.Response(200, json={"result": IA_FILES_MP4}))

    respx.get(
        "https://archive.org/download/cnn-sep11-0800/broadcast.mp4"
    ).mock(return_value=httpx.Response(200, content=content))

    with patch(
        "video_grabber.pipeline.downloader.update_bytes_downloaded"
    ) as mock_update:
        download_item(job, tmp_path)

    assert mock_update.called
    # Final call should report full file size
    final_bytes = mock_update.call_args_list[-1][0][1]
    assert final_bytes == len(content)


@respx.mock
def test_download_raises_on_http_error(tmp_path):
    job = make_job()

    respx.get(
        "https://archive.org/metadata/cnn-sep11-0800/files"
    ).mock(return_value=httpx.Response(200, json={"result": IA_FILES_MP4}))

    respx.get(
        "https://archive.org/download/cnn-sep11-0800/broadcast.mp4"
    ).mock(return_value=httpx.Response(503))

    with patch("video_grabber.pipeline.downloader.update_bytes_downloaded"):
        with pytest.raises(httpx.HTTPStatusError):
            download_item(job, tmp_path)


# --- get_ia_files ---

@respx.mock
def test_get_ia_files_returns_list():
    respx.get(
        "https://archive.org/metadata/test-id-001/files"
    ).mock(return_value=httpx.Response(200, json={"result": IA_FILES_MP4}))

    files = get_ia_files("test-id-001")
    assert len(files) == 3
    assert files[0]["name"] == "broadcast.mp4"


@respx.mock
def test_get_ia_files_retries_on_transient_timeout():
    """Regression: process-item emerald-leopard failed because IA returned
    httpx.ReadTimeout on the metadata call. get_ia_files now retries with
    exponential backoff; only persistent failures propagate."""
    route = respx.get("https://archive.org/metadata/timeout-id/files")
    route.side_effect = [
        httpx.ReadTimeout("simulated transient"),
        httpx.ReadTimeout("simulated transient"),
        httpx.Response(200, json={"result": IA_FILES_MP4}),
    ]

    # Patch tenacity's sleep so the test doesn't actually wait.
    with patch("tenacity.nap.time.sleep"):
        files = get_ia_files("timeout-id")

    assert len(files) == 3
    assert route.call_count == 3


@respx.mock
def test_get_ia_files_gives_up_after_persistent_timeouts():
    route = respx.get("https://archive.org/metadata/dead-id/files")
    route.side_effect = httpx.ReadTimeout("simulated persistent")

    with patch("tenacity.nap.time.sleep"):
        with pytest.raises(httpx.ReadTimeout):
            get_ia_files("dead-id")

    # 4 attempts per stop_after_attempt(4) — the final raise reraises the last error.
    assert route.call_count == 4


# --- Wasabi-first source reuse ---

from botocore.exceptions import ClientError  # noqa: E402
from video_grabber.pipeline.downloader import find_wasabi_source  # noqa: E402


def make_cfg():
    cfg = MagicMock()
    cfg.wasabi_bucket = "files.911realtime.org"
    return cfg


def test_find_wasabi_source_matches_on_size():
    s3 = MagicMock()
    s3.head_object.return_value = {"ContentLength": 1073741824}
    key = find_wasabi_source(
        "cnn-sep11-0800", {"name": "broadcast.mp4", "size": "1073741824"},
        make_cfg(), s3=s3,
    )
    assert key == "download/cnn-sep11-0800/broadcast.mp4"


def test_find_wasabi_source_none_on_size_mismatch():
    s3 = MagicMock()
    s3.head_object.return_value = {"ContentLength": 999}
    assert find_wasabi_source(
        "x", {"name": "x.mp4", "size": "1073741824"}, make_cfg(), s3=s3
    ) is None


def test_find_wasabi_source_none_when_missing():
    s3 = MagicMock()
    s3.head_object.side_effect = ClientError(
        {"Error": {"Code": "404"}}, "HeadObject"
    )
    assert find_wasabi_source(
        "x", {"name": "x.mp4", "size": "100"}, make_cfg(), s3=s3
    ) is None


def test_find_wasabi_source_none_without_size():
    s3 = MagicMock()
    assert find_wasabi_source("x", {"name": "x.mp4"}, make_cfg(), s3=s3) is None
    s3.head_object.assert_not_called()  # no size -> don't even look


@respx.mock
def test_download_reuses_wasabi_when_present(tmp_path):
    """With a size-verified Wasabi copy, pull from S3 and never touch the IA file
    endpoint (no respx route for it — a fall-through would raise)."""
    job = make_job()
    respx.get("https://archive.org/metadata/cnn-sep11-0800/files").mock(
        return_value=httpx.Response(200, json={"result": IA_FILES_MP4})
    )
    s3 = MagicMock()
    s3.head_object.return_value = {"ContentLength": 1073741824}
    s3.download_file.side_effect = lambda b, k, p: __import__("pathlib").Path(p).write_bytes(b"wasabi")

    with patch("video_grabber.pipeline.downloader._make_s3_client", return_value=s3), \
         patch("video_grabber.pipeline.downloader.update_bytes_downloaded"):
        result = download_item(job, tmp_path, make_cfg())

    assert result.read_bytes() == b"wasabi"
    assert s3.download_file.call_args.args[1] == "download/cnn-sep11-0800/broadcast.mp4"


@respx.mock
def test_download_falls_back_to_ia_when_size_mismatch(tmp_path):
    job = make_job()
    content = b"from-ia" * 100
    respx.get("https://archive.org/metadata/cnn-sep11-0800/files").mock(
        return_value=httpx.Response(200, json={"result": IA_FILES_MP4})
    )
    respx.get("https://archive.org/download/cnn-sep11-0800/broadcast.mp4").mock(
        return_value=httpx.Response(200, content=content)
    )
    s3 = MagicMock()
    s3.head_object.return_value = {"ContentLength": 12345}  # mismatch -> ignore copy

    with patch("video_grabber.pipeline.downloader._make_s3_client", return_value=s3), \
         patch("video_grabber.pipeline.downloader.update_bytes_downloaded"):
        result = download_item(job, tmp_path, make_cfg())

    assert result.read_bytes() == content
    s3.download_file.assert_not_called()
