"""Version resolution and the optional pin (issue #379).

The point of this module is that an executor can always answer "what commit am I
running?" — so the tests care most about the cases where it cannot: no env, no
git, a pin that does not match.
"""
import subprocess

from video_grabber import version as V


def test_env_wins_because_the_container_has_no_git(monkeypatch):
    monkeypatch.setenv("CODE_VERSION", "abc123")
    assert V.code_version() == "abc123"


def test_falls_back_to_git_when_no_env(monkeypatch):
    monkeypatch.delenv("CODE_VERSION", raising=False)
    monkeypatch.setattr(V, "_from_git", lambda: "deadbeef")
    assert V.code_version() == "deadbeef"


def test_unknown_rather_than_raising_when_nothing_can_answer(monkeypatch):
    # A stamping mechanism that can crash a worker is worse than the drift it
    # reports, so every failure path lands on "unknown".
    monkeypatch.delenv("CODE_VERSION", raising=False)
    monkeypatch.setattr(V, "_from_git", lambda: None)
    assert V.code_version() == V.UNKNOWN


def test_git_failures_do_not_propagate(monkeypatch):
    monkeypatch.delenv("CODE_VERSION", raising=False)

    def boom(*a, **kw):
        raise OSError("no git on this box")

    monkeypatch.setattr(subprocess, "run", boom)
    assert V._from_git() is None
    assert V.code_version() == V.UNKNOWN


def test_blank_env_is_not_a_version(monkeypatch):
    monkeypatch.setenv("CODE_VERSION", "   ")
    monkeypatch.setattr(V, "_from_git", lambda: "fromgit")
    assert V.code_version() == "fromgit"


def test_no_pin_means_no_mismatch(monkeypatch):
    monkeypatch.delenv("EXPECTED_CODE_VERSION", raising=False)
    monkeypatch.setenv("CODE_VERSION", "abc123")
    assert V.version_mismatch() is None


def test_pin_matches_on_short_sha_prefix(monkeypatch):
    monkeypatch.setenv("CODE_VERSION", "abc123def4567890")
    monkeypatch.setenv("EXPECTED_CODE_VERSION", "abc123d")
    assert V.version_mismatch() is None


def test_pin_reports_the_actual_version_on_mismatch(monkeypatch):
    monkeypatch.setenv("CODE_VERSION", "1111111")
    monkeypatch.setenv("EXPECTED_CODE_VERSION", "2222222")
    said = V.version_mismatch()
    assert said is not None
    assert "1111111" in said and "2222222" in said


def test_unknown_fails_a_pin(monkeypatch):
    # "I cannot tell you what I am running" is precisely the state #379 was, so
    # it must not satisfy a check whose purpose is to catch that state.
    monkeypatch.delenv("CODE_VERSION", raising=False)
    monkeypatch.setattr(V, "_from_git", lambda: None)
    monkeypatch.setenv("EXPECTED_CODE_VERSION", "abc123")
    assert V.version_mismatch() is not None
