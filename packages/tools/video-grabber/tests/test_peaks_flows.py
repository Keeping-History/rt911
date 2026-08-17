import logging
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

import video_grabber.peaks.flows as flows
from video_grabber.peaks.flows import PartialDecodeError, check_decode_length, should_compute


def test_skips_rows_that_already_have_peaks():
    assert should_compute({"peaks": [[0, 0]]}, force=False) is False


def test_computes_rows_with_no_peaks():
    assert should_compute({"peaks": None}, force=False) is True


def test_computes_rows_missing_the_key_entirely():
    assert should_compute({}, force=False) is True


def test_force_recomputes_everything():
    assert should_compute({"peaks": [[0, 0]]}, force=True) is True


# --- pcm_for: the ffmpeg call itself. These drive `subprocess.run` rather
# than stubbing `pcm_for` wholesale, because `check=True` and `timeout=` carry
# the whole "one bad file cannot wedge an unattended run, and a failed decode
# is never mistaken for audio" argument and are invisible to every test that
# replaces the function.


def test_the_decode_is_bounded_and_its_exit_status_checked():
    seen = {}

    def fake_run(cmd, **kwargs):
        seen.update(cmd=cmd, kwargs=kwargs)
        return SimpleNamespace(stdout=b"\x00\x00")

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(flows.subprocess, "run", fake_run)
        assert flows.pcm_for(Path("clip.mp3")) == b"\x00\x00"

    assert seen["kwargs"]["check"] is True
    assert seen["kwargs"]["timeout"] == flows._FFMPEG_TIMEOUT_S
    assert seen["cmd"][0] == "ffmpeg"


def test_a_nonzero_exit_raises_instead_of_returning_the_partial_output(monkeypatch):
    """ffmpeg failing mid-decode still leaves bytes on stdout. Without
    check=True those bytes become an envelope for audio that never decoded."""
    real_run = subprocess.run

    def run_failing(cmd, **kwargs):
        return real_run(["sh", "-c", "printf partial; exit 3"], **kwargs)

    monkeypatch.setattr(flows.subprocess, "run", run_failing)
    with pytest.raises(subprocess.CalledProcessError):
        flows.pcm_for(Path("broken.mp3"))


def test_a_hung_decode_is_cut_off_rather_than_blocking_the_run(monkeypatch):
    """The timeout is what keeps one stalled file from wedging an unattended
    run forever; nothing else in the flow can interrupt a blocked read."""
    real_run = subprocess.run

    def run_hanging(cmd, **kwargs):
        return real_run(["sh", "-c", "sleep 5"], **kwargs)

    monkeypatch.setattr(flows, "_FFMPEG_TIMEOUT_S", 0.3)
    monkeypatch.setattr(flows.subprocess, "run", run_hanging)
    with pytest.raises(subprocess.TimeoutExpired):
        flows.pcm_for(Path("stalled.mp3"))


# --- check_decode_length: a short decode must never become a stored envelope.


def _pcm_of(seconds: float) -> bytes:
    return b"\x00\x00" * int(seconds * flows._SAMPLE_RATE_HZ)


def test_a_decode_matching_the_catalogued_duration_is_accepted():
    # 0.4 s long: whole-second truncation in `calc_duration` plus codec
    # padding, i.e. the normal case, not a defect.
    check_decode_length(_pcm_of(60.4), 60)


def test_a_short_decode_is_rejected():
    with pytest.raises(PartialDecodeError):
        check_decode_length(_pcm_of(12), 600)


def test_an_empty_decode_is_rejected_even_with_no_duration_to_check_against():
    """480 [0, 0] pairs are indistinguishable from a genuinely silent
    recording, so this one cannot be waved through as unverifiable."""
    with pytest.raises(PartialDecodeError):
        check_decode_length(b"", None)


def test_a_row_with_no_usable_duration_is_accepted_unverified():
    for missing in (None, 0, -1):
        check_decode_length(_pcm_of(3), missing)


# --- compute_peaks_flow: mocked httpx, subprocess and Wasabi. No network,
# no shelling out — `pcm_for`/`peaks_from_pcm`/`wasabi.download_file` are all
# stubbed, so these exercise only the flow's own control flow: what it writes,
# when it writes, and whether one bad row can stop the run.


class FakeHttpx:
    """Records every PATCH call instead of making one."""

    def __init__(self):
        self.calls = []

    def patch(self, url, json, headers):
        self.calls.append({"url": url, "json": json, "headers": headers})
        return SimpleNamespace(raise_for_status=lambda: None)


# No `calc_duration`, so the decode-length check treats this row as
# unverifiable and the stubbed 1-sample PCM is accepted — these tests are
# about the flow's control flow, not the guard. The guard has its own below.
ROW = {"id": 1, "url": "https://files.911realtime.org/audio/foo.mp3", "peaks": None}


@pytest.fixture
def flow_env(monkeypatch):
    """Stub every side-effecting collaborator `compute_peaks_flow` calls."""
    monkeypatch.setattr(flows, "get_run_logger", lambda: logging.getLogger("test"))
    monkeypatch.setattr(flows, "wasabi", SimpleNamespace(download_file=lambda *a, **k: None))
    monkeypatch.setattr(flows, "pcm_for", lambda path: b"\x00\x00")
    monkeypatch.setattr(flows, "peaks_from_pcm", lambda pcm, buckets: [[1, 2]] * buckets)
    monkeypatch.setattr(flows, "_auth_headers", lambda cfg: {})
    fake_httpx = FakeHttpx()
    monkeypatch.setattr(flows, "httpx", fake_httpx)
    return fake_httpx


def test_dry_run_issues_zero_writes(monkeypatch, flow_env):
    monkeypatch.setattr(flows, "_page_mp3_items", lambda cfg, fields: iter([ROW]))
    flows.compute_peaks_flow.fn(dry_run=True)
    assert flow_env.calls == []


def test_patch_body_contains_only_the_peaks_key(monkeypatch, flow_env):
    """A row PATCH must never be able to clobber any other column."""
    monkeypatch.setattr(flows, "_page_mp3_items", lambda cfg, fields: iter([ROW]))
    flows.compute_peaks_flow.fn(dry_run=False)
    assert len(flow_env.calls) == 1
    assert set(flow_env.calls[0]["json"].keys()) == {"peaks"}
    assert flow_env.calls[0]["json"]["peaks"] == [[1, 2]] * flows.PEAK_BUCKETS


def test_a_failing_row_is_counted_and_the_run_continues(monkeypatch, flow_env):
    """The property the per-row try/except exists for: one bad recording
    (download error, corrupt file, whatever) must not end the run."""
    bad = {"id": 1, "url": "https://files.911realtime.org/audio/bad.mp3", "peaks": None}
    good = {"id": 2, "url": "https://files.911realtime.org/audio/good.mp3", "peaks": None}

    def flaky_download(key, dest, cfg):
        if "bad" in key:
            raise RuntimeError("boom")

    monkeypatch.setattr(flows, "_page_mp3_items", lambda cfg, fields: iter([bad, good]))
    monkeypatch.setattr(flows, "wasabi", SimpleNamespace(download_file=flaky_download))

    flows.compute_peaks_flow.fn(dry_run=False)

    # Only the surviving row gets written; the failed one is skipped, not
    # raised, and the loop reaches the row after it.
    assert len(flow_env.calls) == 1
    assert flow_env.calls[0]["url"].endswith("/items/mp3_items/2")


def test_the_row_projection_carries_the_duration_the_guard_needs(monkeypatch, flow_env):
    """`check_decode_length` reads `calc_duration` off the row. Drop it from
    the projection and every row silently becomes unverifiable."""
    seen = []

    def spy_page(cfg, fields):
        seen.append(fields)
        return iter([])

    monkeypatch.setattr(flows, "_page_mp3_items", spy_page)
    flows.compute_peaks_flow.fn()
    assert "calc_duration" in seen[0].split(",")


def test_a_partial_decode_is_counted_as_failed_and_writes_nothing(monkeypatch, flow_env):
    """The failure this guard exists for: ffmpeg exits 0 on a truncated MP3
    after emitting a short prefix, and storing that prefix's envelope against
    the row's full extent is permanent — `should_compute` never revisits a
    non-null `peaks`."""
    row = {"id": 9, "url": "https://files.911realtime.org/audio/truncated.mp3",
           "peaks": None, "calc_duration": 600}
    monkeypatch.setattr(flows, "_page_mp3_items", lambda cfg, fields: iter([row]))
    monkeypatch.setattr(flows, "pcm_for", lambda path: _pcm_of(12))

    flows.compute_peaks_flow.fn(dry_run=False)

    assert flow_env.calls == []


def test_a_full_decode_of_the_same_shape_is_still_written(monkeypatch, flow_env):
    """Control for the test above: the guard must not simply reject everything
    with a `calc_duration`."""
    row = {"id": 9, "url": "https://files.911realtime.org/audio/whole.mp3",
           "peaks": None, "calc_duration": 600}
    monkeypatch.setattr(flows, "_page_mp3_items", lambda cfg, fields: iter([row]))
    monkeypatch.setattr(flows, "pcm_for", lambda path: _pcm_of(600.4))

    flows.compute_peaks_flow.fn(dry_run=False)

    assert len(flow_env.calls) == 1
    assert flow_env.calls[0]["url"].endswith("/items/mp3_items/9")
