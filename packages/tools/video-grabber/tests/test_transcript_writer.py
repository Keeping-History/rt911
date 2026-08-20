import json
import os
import time
from contextlib import contextmanager
from datetime import datetime

import httpx
import pytest
import respx

from video_grabber.config import Config
from video_grabber.transcript import writer


def _mock_zero_count():
    """The post-delete verification GET, mocked to report the scope is empty."""
    return respx.get("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(200, json={"data": [{"count": 0}]})
    )


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
    _mock_zero_count()
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
    # matches nothing and every re-run doubles the data. Directus scopes
    # DELETE /items/:collection from the request BODY, not the query string —
    # a query-param `filter` is silently ignored (or 400s), so asserting on
    # the body is what actually proves the scope reaches the server.
    body = json.loads(delete.calls[0].request.read())
    assert body["query"]["filter"] == {"medium": {"_eq": "tv"}, "channel": {"_eq": 7}}
    assert body["query"]["limit"] == -1


@respx.mock
def test_replace_segments_strips_nul_bytes(cfg):
    respx.delete("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(204)
    )
    _mock_zero_count()
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
    _mock_zero_count()
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
    _mock_zero_count()
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
    _mock_zero_count()
    respx.post("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(400, text="bad request")
    )

    rows = [{"channel": 1, "channel_slug": None, "medium": "tv",
             "start_date": "2001-09-11T12:00:00", "end_date": "2001-09-11T12:00:30",
             "text": "t"}]
    with pytest.raises(httpx.HTTPStatusError):
        writer.replace_segments(rows, medium="tv", channel=1, channel_slug=None, cfg=cfg)


@respx.mock
def test_replace_segments_scopes_the_radio_delete_by_channel_slug(cfg):
    # Radio has no tv_channels row, so its delete scope is channel_slug rather
    # than channel — every other replace_segments test passes an int channel,
    # so this branch has never executed in a test before.
    delete = respx.delete("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(204)
    )
    _mock_zero_count()
    respx.post("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(200, json={"data": []})
    )

    rows = [{"channel": None, "channel_slug": "mp3:42", "medium": "radio",
             "start_date": "2001-09-11T12:00:00", "end_date": "2001-09-11T12:00:30",
             "text": "hello"}]
    writer.replace_segments(rows, medium="radio", channel=None, channel_slug="mp3:42", cfg=cfg)

    body = json.loads(delete.calls[0].request.read())
    assert body["query"]["filter"] == {
        "medium": {"_eq": "radio"}, "channel_slug": {"_eq": "mp3:42"}
    }


@respx.mock
def test_replace_segments_raises_when_delete_leaves_rows_behind(cfg):
    # A server-side cap on the bulk delete (QUERY_LIMIT_MAX) can leave a
    # remainder even with limit=-1 requested. Inserting on top of that would
    # duplicate data, so the post-delete count check must raise instead.
    respx.delete("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(204)
    )
    respx.get("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(200, json={"data": [{"count": 3}]})
    )
    insert = respx.post("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(200, json={"data": []})
    )

    rows = [{"channel": 1, "channel_slug": None, "medium": "tv",
             "start_date": "2001-09-11T12:00:00", "end_date": "2001-09-11T12:00:30",
             "text": "t"}]
    with pytest.raises(RuntimeError, match="delete left 3 rows"):
        writer.replace_segments(rows, medium="tv", channel=1, channel_slug=None, cfg=cfg)

    assert not insert.called, "must not insert on top of a partial delete"


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


@respx.mock
def test_list_subtitled_mp3_items_filters_to_broadcast_sources(cfg):
    """NEADS/NORAD tapes must never reach tier 2.

    They are operational military comms: no civilian could hear them on 9/11,
    so including them would hand a buddy knowledge the tier design exists to
    withhold. The filter goes to Directus so the tapes are never fetched.
    """
    route = respx.get("https://directus.test/items/mp3_items").mock(
        return_value=httpx.Response(200, json={"data": [
            {"id": 144, "start_date": "2001-09-11T12:45:00", "subtitles": "https://f/144.srt"},
        ]})
    )

    got = writer.list_subtitled_mp3_items(cfg)

    assert [i["id"] for i in got] == [144]
    sent = json.loads(route.calls[0].request.url.params["filter"])
    assert sent == {"source": {"name": {"_in": ["WINS", "WCBS"]}}}


@respx.mock
def test_list_subtitled_mp3_items_honours_a_configured_source_list(cfg, monkeypatch):
    monkeypatch.setenv("TRANSCRIPT_RADIO_SOURCES", "WINS")
    from video_grabber.config import Config

    route = respx.get("https://directus.test/items/mp3_items").mock(
        return_value=httpx.Response(200, json={"data": []})
    )
    writer.list_subtitled_mp3_items(
        Config(directus_url="https://directus.test", directus_api_token="tok")
    )
    sent = json.loads(route.calls[0].request.url.params["filter"])
    assert sent == {"source": {"name": {"_in": ["WINS"]}}}


@pytest.mark.parametrize("value", ["", "   ", ",", " , ,"])
@respx.mock
def test_list_subtitled_mp3_items_refuses_an_empty_source_list(monkeypatch, value):
    """An unreadable allowlist must fail closed, not fetch everything.

    The dangerous version of this bug is silent: an unfiltered query returns
    the NORAD tapes, the backfill writes them, and nothing looks wrong. So the
    assertion that matters is that no request is made at all -- raising after
    the fetch would still be a leak if a caller swallowed the error.
    """
    monkeypatch.setenv("TRANSCRIPT_RADIO_SOURCES", value)
    from video_grabber.config import Config

    route = respx.get("https://directus.test/items/mp3_items").mock(
        return_value=httpx.Response(200, json={"data": []})
    )

    with pytest.raises(ValueError, match="TRANSCRIPT_RADIO_SOURCES"):
        writer.list_subtitled_mp3_items(
            Config(directus_url="https://directus.test", directus_api_token="tok")
        )
    assert not route.called


@respx.mock
def test_replace_minutes_targets_the_minutes_collection(cfg):
    """Every request must go to chat_transcript_minutes, not the segments table.

    _replace_scoped is shared by both writers and takes the collection as an
    argument. A leftover reference to the segments constant in any of its three
    calls (delete, post-delete verify, insert) would silently write condensed
    minute rows into the raw-segment table and wipe the wrong scope on the way —
    both tables carry channel/medium, so nothing would error.
    """
    delete = respx.delete("https://directus.test/items/chat_transcript_minutes").mock(
        return_value=httpx.Response(200)
    )
    verify = respx.get("https://directus.test/items/chat_transcript_minutes").mock(
        return_value=httpx.Response(200, json={"data": [{"count": 0}]})
    )
    insert = respx.post("https://directus.test/items/chat_transcript_minutes").mock(
        return_value=httpx.Response(200, json={"data": []})
    )
    # Any call landing on the segments collection is the bug this test exists for.
    segments_route = respx.route(
        url__startswith="https://directus.test/items/chat_transcript_segments"
    ).mock(return_value=httpx.Response(500))

    written = writer.replace_minutes(
        [{"channel": 7, "channel_slug": "wnbc", "medium": "tv",
          "minute": "2001-09-11T12:40:00", "summary": "on the air", "segment_count": 2}],
        medium="tv", channel=7, channel_slug="wnbc", cfg=cfg,
    )

    assert written == 1
    assert delete.called and verify.called and insert.called
    assert not segments_route.called


def test_replace_minutes_refuses_without_a_scope(cfg):
    # Same guard replace_segments has: an unscoped delete would clear every
    # source's minutes, and the following insert would leave only this one's.
    with pytest.raises(ValueError, match="channel id or a channel_slug"):
        writer.replace_minutes([], medium="tv", channel=None, channel_slug=None, cfg=cfg)


@respx.mock
def test_replace_minutes_scopes_the_delete_to_the_window(cfg):
    """An incremental run must not delete minutes outside the window it wrote.

    replace_segments deletes everything for a source because it rebuilds a whole
    SRT. Summarisation is windowed and paid-for, so source-only scoping would let
    a 14:00-15:00 run silently wipe the 13:00-14:00 rows -- delete succeeds,
    insert succeeds, row count drops, nothing errors.
    """
    captured = {}

    def capture_delete(request):
        captured["filter"] = json.loads(request.content)["query"]["filter"]
        return httpx.Response(200)

    respx.delete("https://directus.test/items/chat_transcript_minutes").mock(side_effect=capture_delete)
    respx.get("https://directus.test/items/chat_transcript_minutes").mock(
        return_value=httpx.Response(200, json={"data": [{"count": 0}]}))
    respx.post("https://directus.test/items/chat_transcript_minutes").mock(
        return_value=httpx.Response(200, json={"data": []}))

    writer.replace_minutes(
        [{"channel": 7, "channel_slug": "wnbc", "medium": "tv",
          "minute": "2001-09-11T14:00:00", "summary": "x", "segment_count": 1}],
        medium="tv", channel=7, channel_slug="wnbc", cfg=cfg,
        minute_gte="2001-09-11T14:00:00", minute_lt="2001-09-11T15:00:00",
    )

    assert captured["filter"]["channel"] == {"_eq": 7}
    assert captured["filter"]["minute"] == {
        "_gte": "2001-09-11T14:00:00", "_lt": "2001-09-11T15:00:00"}


@respx.mock
def test_replace_minutes_without_a_window_still_clears_the_source(cfg):
    # A full rebuild is a legitimate call; only omit the window when that is
    # genuinely the intent.
    captured = {}

    def capture_delete(request):
        captured["filter"] = json.loads(request.content)["query"]["filter"]
        return httpx.Response(200)

    respx.delete("https://directus.test/items/chat_transcript_minutes").mock(side_effect=capture_delete)
    respx.get("https://directus.test/items/chat_transcript_minutes").mock(
        return_value=httpx.Response(200, json={"data": [{"count": 0}]}))
    respx.post("https://directus.test/items/chat_transcript_minutes").mock(
        return_value=httpx.Response(200, json={"data": []}))

    writer.replace_minutes([], medium="tv", channel=7, channel_slug="wnbc", cfg=cfg)
    assert "minute" not in captured["filter"]
