"""Unit tests for the Usenet mbox downloader — respx-mocked IA, no network."""
from types import SimpleNamespace

import httpx
import pytest
import respx

from video_grabber.usenet import downloader


def make_job(identifier="usenet-ntl.talk"):
    return SimpleNamespace(id="job-1", ia_identifier=identifier)


IA_FILES = {
    "result": [
        {"name": "ntl.talk_archive.torrent", "size": "100"},
        {"name": "ntl.talk_meta.xml", "size": "50"},
        {"name": "ntl.talk.csv.gz", "size": "200"},          # giganews index, not mbox
        {"name": "ntl.talk.mbox.gz", "size": "4096"},         # the payload
        {"name": "ntl.talk.mbox.zip", "size": "8192"},        # preferred suffix
    ]
}


def test_select_mbox_file_prefers_zip_skips_sidecars():
    best = downloader.select_mbox_file(IA_FILES["result"])
    assert best["name"] == "ntl.talk.mbox.zip"


def test_select_mbox_file_skips_private():
    files = [
        {"name": "g.mbox.zip", "size": "10", "private": "true"},
        {"name": "g.mbox.gz", "size": "10"},
    ]
    assert downloader.select_mbox_file(files)["name"] == "g.mbox.gz"


def test_select_mbox_file_raises_without_mbox():
    with pytest.raises(ValueError):
        downloader.select_mbox_file([{"name": "x.torrent"}, {"name": "y.xml"}])


@respx.mock
def test_download_mbox_writes_file(tmp_path):
    job = make_job()
    content = b"From -1\nSubject: hi\n\nbody\n" * 50
    respx.get("https://archive.org/metadata/usenet-ntl.talk/files").mock(
        return_value=httpx.Response(200, json=IA_FILES)
    )
    respx.get("https://archive.org/download/usenet-ntl.talk/ntl.talk.mbox.zip").mock(
        return_value=httpx.Response(200, content=content)
    )
    dest = downloader.download_mbox(job, tmp_path)
    assert dest.exists()
    assert dest.read_bytes() == content
    assert dest.name == "ntl.talk.mbox.zip"


@respx.mock
def test_download_mbox_short_circuits_when_complete(tmp_path):
    job = make_job()
    # Pre-create a complete file matching the reported size (8192).
    dest = tmp_path / job.ia_identifier / "ntl.talk.mbox.zip"
    dest.parent.mkdir(parents=True)
    dest.write_bytes(b"x" * 8192)

    meta = respx.get("https://archive.org/metadata/usenet-ntl.talk/files").mock(
        return_value=httpx.Response(200, json=IA_FILES)
    )
    dl = respx.get("https://archive.org/download/usenet-ntl.talk/ntl.talk.mbox.zip").mock(
        return_value=httpx.Response(200, content=b"should-not-fetch")
    )
    out = downloader.download_mbox(job, tmp_path)
    assert out == dest
    assert meta.called          # still resolves the file list
    assert not dl.called        # but does not re-download a complete file
