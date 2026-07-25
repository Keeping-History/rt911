import os
import time
from contextlib import contextmanager
from datetime import datetime

import httpx
import pytest
import respx

from video_grabber.config import Config
from video_grabber.transcript import writer


@contextmanager
def ambient_tz(name: str):
    """Force the process timezone, then restore it.

    TZ + tzset() is process-global state that does not compose with
    monkeypatch's teardown ordering: monkeypatch restores the env var only
    after the test body, so a tzset() inside the test would re-read the
    patched value and leak the wrong timezone into every later test. Save and
    restore explicitly instead.

    time.tzset() is Unix-only; this package targets Linux (CI + the worker
    pod), so that's fine, but it would need a different approach on Windows.
    """
    previous = os.environ.get("TZ")
    os.environ["TZ"] = name
    time.tzset()
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = previous
        time.tzset()


@pytest.fixture
def cfg():
    return Config(directus_url="https://directus.test", directus_api_token="tok")


@respx.mock
def test_replace_segments_deletes_before_inserting(cfg):
    delete = respx.delete("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(204)
    )
    insert = respx.post("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(200, json={"data": []})
    )

    rows = [{"channel": 7, "channel_slug": "wnbc", "medium": "tv",
             "start_date": "2001-09-11T12:00:00", "end_date": "2001-09-11T12:00:30",
             "text": "hello"}]
    written = writer.replace_segments(rows, medium="tv", channel=7, channel_slug="wnbc", cfg=cfg)

    assert written == 1
    assert delete.called, "existing rows must be cleared before reinserting"
    assert insert.called
    # The delete must be scoped to exactly the identity the rows carry, or it
    # matches nothing and every re-run doubles the data.
    assert '"channel": {"_eq": 7}' in delete.calls[0].request.url.params["filter"]
    assert '"medium": {"_eq": "tv"}' in delete.calls[0].request.url.params["filter"]


@respx.mock
def test_replace_segments_strips_nul_bytes(cfg):
    respx.delete("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(204)
    )
    insert = respx.post("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(200, json={"data": []})
    )

    rows = [{"channel": 1, "channel_slug": None, "medium": "tv",
             "start_date": "2001-09-11T12:00:00", "end_date": "2001-09-11T12:00:30",
             "text": "bad\x00byte"}]
    writer.replace_segments(rows, medium="tv", channel=1, channel_slug=None, cfg=cfg)

    body = insert.calls[0].request.read().decode()
    assert "\\u0000" not in body and "\x00" not in body
    assert "badbyte" in body


@respx.mock
def test_replace_segments_batches_by_serialized_size(cfg, monkeypatch):
    monkeypatch.setattr(writer, "_MAX_BATCH_BYTES", 500)
    respx.delete("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(204)
    )
    insert = respx.post("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(200, json={"data": []})
    )

    rows = [{"channel": 1, "channel_slug": None, "medium": "tv",
             "start_date": "2001-09-11T12:00:00", "end_date": "2001-09-11T12:00:30",
             "text": "x" * 100} for _ in range(10)]
    writer.replace_segments(rows, medium="tv", channel=1, channel_slug=None, cfg=cfg)

    assert insert.call_count > 1, "a payload over the cap must be split into batches"


@respx.mock
def test_replace_segments_with_no_rows_still_clears(cfg):
    # A channel whose transcript became empty must not keep its stale rows.
    delete = respx.delete("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(204)
    )
    insert = respx.post("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(200, json={"data": []})
    )

    written = writer.replace_segments([], medium="tv", channel=3, channel_slug=None, cfg=cfg)

    assert written == 0
    assert delete.called
    assert not insert.called


@respx.mock
def test_replace_segments_raises_on_directus_error(cfg):
    respx.delete("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(204)
    )
    respx.post("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(400, text="bad request")
    )

    rows = [{"channel": 1, "channel_slug": None, "medium": "tv",
             "start_date": "2001-09-11T12:00:00", "end_date": "2001-09-11T12:00:30",
             "text": "t"}]
    with pytest.raises(httpx.HTTPStatusError):
        writer.replace_segments(rows, medium="tv", channel=1, channel_slug=None, cfg=cfg)


@respx.mock
def test_list_subtitled_channels_skips_rows_without_subtitles(cfg):
    respx.get("https://directus.test/items/tv_channels").mock(
        return_value=httpx.Response(200, json={"data": [
            {"id": 1, "start_date": "2001-09-09T00:00:00", "subtitles": "https://f/1.srt",
             "content": '{"channel_stream": "wnbc"}'},
            {"id": 2, "start_date": "2001-09-09T00:00:00", "subtitles": None,
             "content": None},
            {"id": 3, "start_date": "2001-09-09T00:00:00", "subtitles": "",
             "content": None},
        ]})
    )

    got = writer.list_subtitled_channels(cfg)

    assert [c["id"] for c in got] == [1]
    assert got[0]["slug"] == "wnbc"
    assert got[0]["start_date"].tzinfo is None, "anchors must be naive UTC"


@pytest.mark.parametrize("tz_name", ["UTC", "America/New_York", "Asia/Kolkata"])
def test_naive_utc_converts_an_aware_timestamp_to_utc_in_any_ambient_tz(tz_name):
    # astimezone(tz=None) converts to system-local time, so it agrees with the
    # correct answer only when the host is UTC. Pinning several ambient
    # timezones is what makes this a regression guard rather than a comment:
    # a revert fails here even though CI itself runs UTC.
    with ambient_tz(tz_name):
        got = writer._naive_utc("2001-09-11T17:46:00+05:00")
    assert got == datetime(2001, 9, 11, 12, 46, 0)
    assert got.tzinfo is None


def test_naive_utc_passes_a_naive_timestamp_through_unchanged():
    got = writer._naive_utc("2001-09-11T12:46:00")
    assert got == datetime(2001, 9, 11, 12, 46, 0)
    assert got.tzinfo is None
