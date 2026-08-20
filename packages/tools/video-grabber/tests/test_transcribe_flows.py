import logging
from pathlib import Path
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
    # The wav is never written, so ffprobe cannot read it; the chunking maths is
    # covered by test_transcribe_chunking.py and test_transcribe_windows_*.
    monkeypatch.setattr(flows, "probe_duration_seconds", lambda p: 12.0)
    # Same reason: there is no real wav on disk for ffmpeg to cut a window from.
    def _fake_slice(src, dest, off, length):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"")
        return dest

    monkeypatch.setattr(flows, "slice_wav", _fake_slice)
    monkeypatch.setattr(
        flows, "wasabi",
        SimpleNamespace(upload_text=lambda text, key, cfg: None, list_keys=lambda *a: []),
    )

    def make_transcriber(fail=None):
        def fake_transcribe(wav, out_base, cfg, **kw):
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


# ---- build-channel-subtitles must fail loudly on a channel-lookup miss ------
#
# The lookup matches tv_channels on the content marker {"channel_stream": slug}.
# CCTV4's marker sat on the stale "cctv3" long after everything else moved to
# "cctv4", so the flow took its early-return and reported COMPLETED while
# writing nothing — a fully transcribed 345-program channel silently had no
# subtitles. A miss is a misconfiguration, not a no-op.


def test_build_channel_subtitles_raises_when_channel_lookup_misses():
    from unittest.mock import MagicMock, patch

    with patch.object(flows, "Config", return_value=MagicMock()), \
         patch.object(flows, "get_tv_channel_start_date", return_value=None):
        with pytest.raises(ValueError, match="no tv_channels row"):
            flows.build_channel_subtitles_flow("cctv4")


class _ScanConn:
    """Minimal Connection stub: scan-transcribe calls .mappings().all()."""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, stmt, params=None):
        return SimpleNamespace(
            mappings=lambda: SimpleNamespace(all=lambda: []),
            rowcount=0,
        )

    def commit(self):
        pass


def test_scan_transcribe_never_enqueues_enhanced_audio(monkeypatch):
    """Transcripts must come from the source recording, never from a render.

    Enhanced audio lives at audio-enhanced/ and mp3_items gains an enhanced_url
    field, so anything deriving transcribe work from Directus rows rather than
    from the audio/ prefix would silently start transcribing processed audio.
    """
    seen = []

    def list_keys(prefix, cfg):
        seen.append(prefix)
        return []

    monkeypatch.setattr(flows, "wasabi", SimpleNamespace(list_keys=list_keys))
    monkeypatch.setattr(flows, "get_db", _ScanConn)
    monkeypatch.setattr(flows, "get_run_logger", lambda: logging.getLogger("test"))
    flows.scan_transcribe_flow.fn()
    assert "audio/" in seen
    assert not any(p.startswith("audio-enhanced") for p in seen)


def test_transcribe_windows_shifts_each_window_onto_the_file_timeline(monkeypatch, tmp_path):
    slices, calls = [], []

    def fake_slice(src, dest, offset_ms, length_ms):
        slices.append((offset_ms, length_ms))
        dest.write_bytes(b"")
        return dest

    def fake(wav, out_base, cfg, *, offset_ms=0, duration_ms=0, vad=False, runner=None):
        # Whisper must see the SEGMENT, never the full recording with -ot/-d:
        # --vad rescans the whole input regardless of the duration flag.
        calls.append((Path(wav).name, offset_ms, duration_ms, vad))
        out_base.parent.mkdir(parents=True, exist_ok=True)
        srt = out_base.with_suffix(".srt")
        srt.write_text("1\n00:00:01,000 --> 00:00:02,000\nword\n")
        return srt

    monkeypatch.setattr(flows, "slice_wav", fake_slice)
    monkeypatch.setattr(flows, "transcribe_wav", fake)
    cfg = SimpleNamespace(chunk_seconds=600, chunk_overlap_seconds=0)
    cues = flows.transcribe_windows(tmp_path / "a.wav", tmp_path, cfg, duration_s=1200.0)

    assert slices == [(0, 600000), (600000, 600000)]
    assert [c[0] for c in calls] == ["w0000.wav", "w0001.wav"]
    # No offset/duration flags: the segment IS the window.
    assert all(off == 0 and dur == 0 for _, off, dur, _ in calls)
    # VAD must be on for every window -- it is the whole point of the change.
    assert all(vad for *_, vad in calls)
    # the second window's 1s cue lands at 601s on the file timeline
    assert any(abs(c.start - 601.0) < 0.01 for c in cues)


def test_transcribe_windows_deletes_each_segment_after_use(monkeypatch, tmp_path):
    """A 6.75h tape is ~41 windows; keeping them would add ~780 MB of scratch."""
    seen = []

    def fake_slice(src, dest, offset_ms, length_ms):
        dest.write_bytes(b"x")
        seen.append(dest)
        return dest

    def fake(wav, out_base, cfg, **kw):
        out_base.parent.mkdir(parents=True, exist_ok=True)
        srt = out_base.with_suffix(".srt")
        srt.write_text("1\n00:00:01,000 --> 00:00:02,000\nword\n")
        return srt

    monkeypatch.setattr(flows, "slice_wav", fake_slice)
    monkeypatch.setattr(flows, "transcribe_wav", fake)
    cfg = SimpleNamespace(chunk_seconds=600, chunk_overlap_seconds=0)
    flows.transcribe_windows(tmp_path / "a.wav", tmp_path, cfg, duration_s=1200.0)
    assert seen and not any(p.exists() for p in seen)


def test_existing_srt_key_prefers_the_mirrored_path():
    stems = {"0812 aa77 taxi"}
    paths = {"subtitles/audio/AA77/0812 aa77 taxi.srt"}
    assert flows.existing_srt_key("audio/AA77/0812 aa77 taxi.mp3", stems, paths) == \
        "subtitles/audio/AA77/0812 aa77 taxi.srt"


def test_existing_srt_key_falls_back_to_the_flat_stem():
    stems = {"0812 aa77 taxi"}
    assert flows.existing_srt_key("audio/AA77/0812 aa77 taxi.mp3", stems, set()) == \
        "subtitles/audio/0812 aa77 taxi.srt"


def test_existing_srt_key_returns_none_when_untranscribed():
    assert flows.existing_srt_key("audio/AA77/never.mp3", set(), set()) is None


def test_subtitle_base_key_mirrors_the_audio_path():
    cfg = SimpleNamespace(subtitles_prefix="subtitles")
    assert flows.subtitle_base_key("mp3", "audio/AA77/0812 aa77 taxi.mp3", cfg) == \
        "subtitles/audio/AA77/0812 aa77 taxi"


def test_subtitle_base_key_disambiguates_colliding_basenames():
    cfg = SimpleNamespace(subtitles_prefix="subtitles")
    a = flows.subtitle_base_key("mp3", "audio/AA11/081015 aa11 fl290.mp3", cfg)
    b = flows.subtitle_base_key("mp3", "audio/faa_atc/clips/aa11/081015 aa11 fl290.mp3", cfg)
    assert a != b


def test_subtitle_base_key_leaves_tv_alone():
    cfg = SimpleNamespace(subtitles_prefix="subtitles")
    assert flows.subtitle_base_key("tv", "TCN_test", cfg) == "subtitles/programs/TCN_test"


def test_read_whisper_text_tolerates_non_utf8_bytes(tmp_path):
    """whisper.cpp writes raw decoder output and does not guarantee UTF-8.

    A single 0xb5 byte mid-file failed a NORAD job outright under the default
    strict decode, losing 6+ hours of transcription. One mojibake character beats
    no transcript.
    """
    p = tmp_path / "out.srt"
    p.write_bytes(b"1\n00:00:01,000 --> 00:00:02,000\nBravo \xb5 112\n")
    text = flows.read_whisper_text(p)
    assert "Bravo" in text and "112" in text
    assert len(flows.parse_srt(text)) == 1


def test_read_whisper_text_is_unchanged_for_clean_utf8(tmp_path):
    p = tmp_path / "out.srt"
    p.write_text("1\n00:00:01,000 --> 00:00:02,000\nAmerican 77\n")
    assert flows.read_whisper_text(p) == p.read_text()


def _mp3_job(job_id):
    return SimpleNamespace(
        id=job_id, kind="mp3",
        source_key="audio/AA77/x.mp3",
        source_url="https://files.911realtime.org/audio/AA77/x.mp3",
    )


def test_transcribe_item_fails_when_no_mp3_items_row_matches(flow_env):
    """A miss means the SRT is in the bucket with nothing pointing at it.

    This warned-and-continued for 575 jobs while every run reported success.
    """
    flow_env.monkeypatch.setattr(flows, "transcribe_wav", flow_env.make_transcriber())
    flow_env.monkeypatch.setattr(flows, "get_transcribe_job", _mp3_job)
    flow_env.monkeypatch.setattr(flows, "patch_mp3_subtitles", lambda *a, **k: False)
    with pytest.raises(RuntimeError, match="matched no mp3_items row"):
        flows.transcribe_item_flow.fn("job-1")
    assert _stages(flow_env.conns)[-1] == "failed"


def test_transcribe_item_succeeds_when_the_row_matches(flow_env):
    flow_env.monkeypatch.setattr(flows, "transcribe_wav", flow_env.make_transcriber())
    flow_env.monkeypatch.setattr(flows, "get_transcribe_job", _mp3_job)
    flow_env.monkeypatch.setattr(flows, "patch_mp3_subtitles", lambda *a, **k: True)
    flows.transcribe_item_flow.fn("job-1")
    assert _stages(flow_env.conns) == ["transcribing", "done"]
