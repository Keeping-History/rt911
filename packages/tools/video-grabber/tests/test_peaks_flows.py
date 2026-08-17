import logging
from types import SimpleNamespace

import pytest

import video_grabber.peaks.flows as flows
from video_grabber.peaks.flows import should_compute


def test_skips_rows_that_already_have_peaks():
    assert should_compute({"peaks": [[0, 0]]}, force=False) is False


def test_computes_rows_with_no_peaks():
    assert should_compute({"peaks": None}, force=False) is True


def test_computes_rows_missing_the_key_entirely():
    assert should_compute({}, force=False) is True


def test_force_recomputes_everything():
    assert should_compute({"peaks": [[0, 0]]}, force=True) is True


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
