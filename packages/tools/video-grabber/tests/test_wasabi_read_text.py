"""
read_text retries transient Wasabi connection resets.

Wasabi drops connections under concurrent read load, surfacing as
ResponseStreamingError("IncompleteRead(0 bytes read, N more expected)") — the
body read dies before any payload arrives. boto3's own retry layer does not
cover it (the failure is past the point botocore retries), so a single reset
used to kill an entire build-channel-subtitles run that reads one SRT per
program. These tests pin the retry, its bound, and that real errors still fail
fast.
"""
import pytest
from botocore.exceptions import ClientError, ResponseStreamingError
from tenacity import wait_none

from video_grabber.config import Config
from video_grabber.storage import wasabi


@pytest.fixture
def cfg(monkeypatch):
    monkeypatch.setenv("WASABI_BUCKET", "test-bucket")
    monkeypatch.setenv("WASABI_ACCESS_KEY_ID", "test")
    monkeypatch.setenv("WASABI_SECRET_ACCESS_KEY", "test")
    return Config()


class _Body:
    def __init__(self, data: bytes):
        self._data = data

    def read(self) -> bytes:
        return self._data


class _FlakyS3:
    """Raises ``fail_times`` streaming resets, then serves the body."""

    def __init__(self, fail_times: int, exc: Exception | None = None):
        self.fail_times = fail_times
        self.calls = 0
        self._exc = exc or ResponseStreamingError(
            error="('Connection broken: IncompleteRead(0 bytes read, 40 more expected)')"
        )

    def get_object(self, **_kw):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise self._exc
        return {"Body": _Body(b"cue text")}


# Strip the backoff so the retry logic is exercised without the wall-clock wait.
_read_text_nowait = wasabi.read_text.retry_with(wait=wait_none())


def test_read_text_retries_transient_reset_then_succeeds(cfg):
    s3 = _FlakyS3(fail_times=2)
    assert _read_text_nowait("subtitles/programs/x.srt", cfg, s3=s3) == "cue text"
    assert s3.calls == 3  # two resets, then the good read


def test_read_text_gives_up_after_five_attempts(cfg):
    s3 = _FlakyS3(fail_times=99)
    with pytest.raises(ResponseStreamingError):
        _read_text_nowait("subtitles/programs/x.srt", cfg, s3=s3)
    assert s3.calls == 5  # stop_after_attempt(5), then reraise


def test_read_text_does_not_retry_real_errors(cfg):
    """A missing key is a genuine failure — retrying it just wastes time."""
    missing = ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
    s3 = _FlakyS3(fail_times=99, exc=missing)
    with pytest.raises(ClientError):
        _read_text_nowait("subtitles/programs/missing.srt", cfg, s3=s3)
    assert s3.calls == 1
