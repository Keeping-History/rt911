import logging
from datetime import datetime

import pytest

from video_grabber.config import Config
from video_grabber.transcript import flows


SRT = """1
00:00:00,000 --> 00:00:02,000
the north tower

2
00:00:02,000 --> 00:00:04,000
has been hit
"""


@pytest.fixture
def cfg():
    return Config(directus_url="https://directus.test", directus_api_token="tok")


def test_builds_absolute_timestamps_from_the_channel_anchor(cfg, monkeypatch):
    monkeypatch.setattr(flows, "get_run_logger", lambda: logging.getLogger("test"))
    monkeypatch.setattr(flows.writer, "list_subtitled_channels", lambda c, **k: [
        {"id": 7, "slug": "wnbc", "start_date": datetime(2001, 9, 11, 12, 0, 0),
         "subtitles": "https://f/wnbc.srt"}
    ])
    monkeypatch.setattr(flows.writer, "list_subtitled_mp3_items", lambda c, **k: [])
    monkeypatch.setattr(flows.writer, "fetch_srt", lambda url, **k: SRT)

    captured = {}

    def fake_replace(rows, **kwargs):
        captured["rows"] = rows
        captured["kwargs"] = kwargs
        return len(rows)

    monkeypatch.setattr(flows.writer, "replace_segments", fake_replace)

    result = flows.build_transcript_segments_flow.fn(medium="tv", cfg=cfg)

    assert result["channels"] == 1
    assert result["segments"] == 1
    # Cue offsets are relative to the file; the row must be absolute 2001 time.
    assert captured["rows"][0]["start_date"] == "2001-09-11T12:00:00"
    assert captured["rows"][0]["end_date"] == "2001-09-11T12:00:04"
    assert captured["rows"][0]["text"] == "the north tower has been hit"
    assert captured["kwargs"]["channel"] == 7
    assert captured["kwargs"]["medium"] == "tv"
    # The radio test pins that the row's channel_slug matches the delete
    # scope; the TV side of that same invariant is the row's channel id.
    assert captured["rows"][0]["channel"] == 7


def test_radio_anchors_on_the_mp3_items_start_date(cfg, monkeypatch):
    monkeypatch.setattr(flows, "get_run_logger", lambda: logging.getLogger("test"))
    monkeypatch.setattr(flows.writer, "list_subtitled_channels", lambda c, **k: [])
    monkeypatch.setattr(flows.writer, "list_subtitled_mp3_items", lambda c, **k: [
        {"id": 42, "slug": None, "start_date": datetime(2001, 9, 11, 13, 30, 0),
         "subtitles": "https://f/42.srt"}
    ])
    monkeypatch.setattr(flows.writer, "fetch_srt", lambda url, **k: SRT)

    captured = {}
    monkeypatch.setattr(flows.writer, "replace_segments",
                        lambda rows, **kw: captured.update(rows=rows, kwargs=kw) or len(rows))

    result = flows.build_transcript_segments_flow.fn(medium="radio", cfg=cfg)

    assert result["mp3_items"] == 1
    assert captured["rows"][0]["start_date"] == "2001-09-11T13:30:00"
    assert captured["kwargs"]["medium"] == "radio"
    assert captured["kwargs"]["channel"] is None
    # Radio's delete scope IS channel_slug (no tv_channels row to key off), so
    # this is the one place the write/delete identity invariant is pinned for
    # the radio path: what the rows carry must equal what the delete matches.
    assert captured["kwargs"]["channel_slug"] == "mp3:42"
    assert captured["rows"][0]["channel_slug"] == "mp3:42"


def test_raises_when_no_subtitled_sources_are_found(cfg, monkeypatch):
    # A silently-empty successful run is the CCTV4 failure mode: everything
    # reports green while the derived artifact is missing.
    monkeypatch.setattr(flows, "get_run_logger", lambda: logging.getLogger("test"))
    monkeypatch.setattr(flows.writer, "list_subtitled_channels", lambda c, **k: [])
    monkeypatch.setattr(flows.writer, "list_subtitled_mp3_items", lambda c, **k: [])

    with pytest.raises(RuntimeError, match="no subtitled"):
        flows.build_transcript_segments_flow.fn(medium="all", cfg=cfg)


def test_one_failing_source_does_not_abort_the_rest(cfg, monkeypatch):
    monkeypatch.setattr(flows, "get_run_logger", lambda: logging.getLogger("test"))
    monkeypatch.setattr(flows.writer, "list_subtitled_channels", lambda c, **k: [
        {"id": 1, "slug": "a", "start_date": datetime(2001, 9, 11, 12, 0, 0),
         "subtitles": "https://f/a.srt"},
        {"id": 2, "slug": "b", "start_date": datetime(2001, 9, 11, 12, 0, 0),
         "subtitles": "https://f/b.srt"},
    ])
    monkeypatch.setattr(flows.writer, "list_subtitled_mp3_items", lambda c, **k: [])

    def flaky_fetch(url, **k):
        if url.endswith("a.srt"):
            raise RuntimeError("wasabi hiccup")
        return SRT

    monkeypatch.setattr(flows.writer, "fetch_srt", flaky_fetch)
    monkeypatch.setattr(flows.writer, "replace_segments", lambda rows, **kw: len(rows))

    result = flows.build_transcript_segments_flow.fn(medium="tv", cfg=cfg)

    assert result["channels"] == 1
    assert result["failed"] == 1


def test_raises_when_every_source_fails(cfg, monkeypatch):
    # Sources were found (so the zero-sources guard doesn't fire), but every
    # one of them raised during ingest — e.g. a bad token or Directus down.
    # A green "0 channels, 0 segments, N failed" result is the same
    # silently-empty-success failure mode the zero-sources guard exists for,
    # just relocated to the write step.
    monkeypatch.setattr(flows, "get_run_logger", lambda: logging.getLogger("test"))
    monkeypatch.setattr(flows.writer, "list_subtitled_channels", lambda c, **k: [
        {"id": 1, "slug": "a", "start_date": datetime(2001, 9, 11, 12, 0, 0),
         "subtitles": "https://f/a.srt"},
        {"id": 2, "slug": "b", "start_date": datetime(2001, 9, 11, 12, 0, 0),
         "subtitles": "https://f/b.srt"},
    ])
    monkeypatch.setattr(flows.writer, "list_subtitled_mp3_items", lambda c, **k: [])

    def always_fails(url, **k):
        raise RuntimeError("directus down")

    monkeypatch.setattr(flows.writer, "fetch_srt", always_fails)

    with pytest.raises(RuntimeError, match="every source failed"):
        flows.build_transcript_segments_flow.fn(medium="tv", cfg=cfg)
