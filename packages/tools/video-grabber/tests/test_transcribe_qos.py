from types import SimpleNamespace

import pytest

from video_grabber.transcribe import dispatch_worker as dw
from video_grabber.transcribe.qos import darwin_background_qos


def _libc(value, errno=0):
    """Stand in for libc, returning a fixed getpriority result."""
    import ctypes

    def getpriority(which, who):
        ctypes.set_errno(errno)
        return value

    return SimpleNamespace(getpriority=getpriority)


def test_reports_throttled_when_darwin_priority_is_one():
    assert darwin_background_qos(platform="darwin", libc=_libc(1)) is True


def test_reports_healthy_when_darwin_priority_is_zero():
    assert darwin_background_qos(platform="darwin", libc=_libc(0)) is False


def test_not_applicable_off_macos():
    # The cluster runs Linux, where this policy does not exist.
    assert darwin_background_qos(platform="linux", libc=_libc(1)) is None


def test_unanswerable_check_is_none_not_throttled():
    # An errno from the syscall must not read as "throttled" and take a healthy
    # worker down on a platform quirk.
    assert darwin_background_qos(platform="darwin", libc=_libc(0, errno=22)) is None


def test_missing_libc_is_none_not_throttled():
    class Boom:
        def __getattr__(self, _):
            raise AttributeError("no libc")

    assert darwin_background_qos(platform="darwin", libc=Boom()) is None


# ---- the startup gate -------------------------------------------------------


def test_worker_refuses_to_start_when_throttled(monkeypatch, capsys):
    """A throttled worker is worse than no worker: it claims jobs and holds them.

    Under background QoS whisper --vad never returns, so the row sits in
    'transcribing' with a live heartbeat — the supervisor cannot even reclaim it.
    """
    monkeypatch.setattr(dw, "darwin_background_qos", lambda: True)
    monkeypatch.delenv("ALLOW_THROTTLED_WORKER", raising=False)
    with pytest.raises(SystemExit) as exc:
        dw.assert_not_throttled()
    assert exc.value.code != 0
    assert "background QoS" in capsys.readouterr().out


def test_worker_starts_normally_when_not_throttled(monkeypatch):
    monkeypatch.setattr(dw, "darwin_background_qos", lambda: False)
    dw.assert_not_throttled()  # must not raise


def test_worker_starts_when_the_check_does_not_apply(monkeypatch):
    monkeypatch.setattr(dw, "darwin_background_qos", lambda: None)
    dw.assert_not_throttled()  # must not raise


def test_override_allows_a_throttled_worker(monkeypatch):
    monkeypatch.setattr(dw, "darwin_background_qos", lambda: True)
    monkeypatch.setenv("ALLOW_THROTTLED_WORKER", "1")
    dw.assert_not_throttled()  # must not raise
