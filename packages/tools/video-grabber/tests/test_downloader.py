"""
Tests for resumable download worker.
Uses httpx-mock to simulate IA S3 responses without real network calls.
"""
import pytest
import respx
import httpx
from pathlib import Path
from unittest.mock import MagicMock, patch, call

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
