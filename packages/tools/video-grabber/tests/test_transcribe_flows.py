import logging
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

import video_grabber.transcribe.flows as flows
from video_grabber.transcribe.flows import build_channel_cues

WS = datetime(2001, 9, 11, 0, 0, 0, tzinfo=timezone.utc)

PROG_A = "1\n00:00:01,000 --> 00:00:02,000\nA opening\n"
PROG_B = "1\n00:00:00,500 --> 00:00:01,500\nB opening\n"


def test_build_channel_cues_offsets_each_program_onto_stream_timeline():
    # Program A airs 1h after window_start, program B airs 2h after.
    a_air = datetime(2001, 9, 11, 1, 0, 0, tzinfo=timezone.utc)
    b_air = datetime(2001, 9, 11, 2, 0, 0, tzinfo=timezone.utc)
    cues = build_channel_cues(WS, [(a_air, PROG_A), (b_air, PROG_B)])
    # A opening at 3600+1 = 3601s; B opening at 7200+0.5 = 7200.5s
    assert cues[0].text == "A opening"
    assert abs(cues[0].start - 3601.0) < 1e-6
    assert cues[1].text == "B opening"
    assert abs(cues[1].start - 7200.5) < 1e-6


def test_build_channel_cues_sorts_out_of_order_programs():
    a_air = datetime(2001, 9, 11, 5, 0, 0, tzinfo=timezone.utc)
    b_air = datetime(2001, 9, 11, 1, 0, 0, tzinfo=timezone.utc)
    cues = build_channel_cues(WS, [(a_air, PROG_A), (b_air, PROG_B)])
    assert cues[0].text == "B opening"   # earlier air_date first


# ---- per-transition DB connections -----------------------------------------
#
# rt911-db sets idle_session_timeout=10min on the video_grabber database (leak
# protection), but whisper holds transcribe-item for 15-20 minutes. Any
# connection opened before transcription is dead by the time the flow writes
# stage='done' — so every transition must open its own fresh connection.


class FakeConn:
    """Stands in for sqlalchemy Connection; `dead` mimics the server having
    closed the socket (idle_session_timeout)."""

    def __init__(self, registry):
        self.dead = False
        self.executed = []
        self.commits = 0
        self.closed = False
        registry.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.closed = True
        return False

    def _check(self):
        if self.dead:
            raise RuntimeError("server closed the connection unexpectedly")

    def execute(self, stmt, params=None):
        self._check()
        self.executed.append((str(stmt), params or {}))

    def commit(self):
        self._check()
        self.commits += 1


def _stages(conns):
    return [p["stage"] for c in conns for (_, p) in c.executed if "stage" in p]


def test_transition_transcribe_job_opens_and_closes_its_own_connection(monkeypatch):
    conns = []
    monkeypatch.setattr(flows, "get_db", lambda: FakeConn(conns))
    flows.transition_transcribe_job("j1", "done", srt_key="k")
    assert len(conns) == 1
    assert _stages(conns) == ["done"]
    assert conns[0].commits == 1
    assert conns[0].closed


@pytest.fixture
def flow_env(monkeypatch, tmp_path):
    """Run transcribe_item_flow.fn with every external dependency stubbed and
    a registry of every DB connection ever opened."""
    conns = []
    monkeypatch.setattr(flows, "_SCRATCH", tmp_path / "scratch")
    monkeypatch.setattr(flows, "get_db", lambda: FakeConn(conns))
    monkeypatch.setattr(flows, "get_run_logger", lambda: logging.getLogger("test"))
    monkeypatch.setattr(
        flows, "get_transcribe_job",
        lambda job_id: SimpleNamespace(
            id=job_id, kind="tv", source_key="TCN_test", source_url="http://x/audio.m3u8",
        ),
    )
    monkeypatch.setattr(flows, "extract_audio", lambda url, dst: dst)
    monkeypatch.setattr(
        flows, "wasabi",
        SimpleNamespace(upload_text=lambda text, key, cfg: None, list_keys=lambda *a: []),
    )

    def make_transcriber(fail=None):
        def fake_transcribe(wav, out_base, cfg):
            # idle_session_timeout fires mid-transcription: every connection
            # opened before this point is now dead.
            for c in conns:
                c.dead = True
            if fail is not None:
                raise fail
            out_base.parent.mkdir(parents=True, exist_ok=True)
            srt = out_base.with_suffix(".srt")
            srt.write_text("1\n00:00:01,000 --> 00:00:02,000\nhello\n")
            return srt
        return fake_transcribe

    return SimpleNamespace(conns=conns, monkeypatch=monkeypatch, make_transcriber=make_transcriber)


def test_transcribe_item_marks_done_after_connections_die_mid_transcription(flow_env):
    flow_env.monkeypatch.setattr(flows, "transcribe_wav", flow_env.make_transcriber())
    flows.transcribe_item_flow.fn("job-1")
    assert _stages(flow_env.conns) == ["transcribing", "done"]


def test_transcribe_item_marks_failed_on_fresh_connection(flow_env):
    boom = RuntimeError("whisper exploded")
    flow_env.monkeypatch.setattr(flows, "transcribe_wav", flow_env.make_transcriber(fail=boom))
    with pytest.raises(RuntimeError, match="whisper exploded"):
        flows.transcribe_item_flow.fn("job-1")
    stages = _stages(flow_env.conns)
    assert stages[0] == "transcribing"
    assert stages[-1] == "failed"
    failed_params = [
        p for c in flow_env.conns for (_, p) in c.executed if p.get("stage") == "failed"
    ]
    assert "whisper exploded" in failed_params[0]["error"]


def test_build_channel_cues_mixed_tzinfo_naive_window_start_aware_air_date():
    """Production combination: naive window_start (Postgres timestamptz col) +
    aware air_date (timestamptz col). Must not raise TypeError."""
    # naive window_start — what psycopg2 returns for timestamp WITHOUT time zone
    naive_ws = datetime(2001, 9, 11, 0, 0, 0)  # no tzinfo
    # aware air_date — what psycopg2 returns for timestamptz
    aware_air = datetime(2001, 9, 11, 1, 0, 0, tzinfo=timezone.utc)
    srt = "1\n00:00:01,000 --> 00:00:02,000\nMixed tz cue\n"
    cues = build_channel_cues(naive_ws, [(aware_air, srt)])
    # air_date is 1h after window_start; cue at 1s → 3600 + 1 = 3601s
    assert len(cues) == 1
    assert cues[0].text == "Mixed tz cue"
    assert abs(cues[0].start - 3601.0) < 1e-6
