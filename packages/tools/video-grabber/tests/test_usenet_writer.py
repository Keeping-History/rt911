"""Unit tests for the Usenet Directus writer — respx-mocked Directus."""
import json

import httpx
import respx

from video_grabber.config import Config
from video_grabber.usenet import writer


def make_cfg():
    cfg = Config()
    cfg.directus_url = "http://directus:8055"
    cfg.directus_api_token = "tok"
    return cfg


def test_naive_utc_strips_offset():
    assert writer._naive_utc("2000-11-25T23:34:13+00:00") == "2000-11-25T23:34:13"
    # a non-UTC offset is converted to UTC before dropping the offset
    assert writer._naive_utc("2000-11-25T18:34:13-05:00") == "2000-11-25T23:34:13"
    assert writer._naive_utc(None) is None


def test_clean_strips_nul_bytes():
    # Postgres text can't store NUL; a single one 400s the whole bulk insert.
    assert writer._clean("a\x00b") == "ab"
    assert writer._clean("\x00\x00") is None
    assert writer.message_payload({"body": "x\x00y", "start_date": "2001-01-01T00:00:00+00:00"}, 1)["body"] == "xy"


def test_message_payload_maps_and_cleans():
    rec = {
        "start_date": "2001-09-11T13:30:00+00:00",
        "subject": " Re: hi " + "x" * 300,
        "author": "Cronos <c@x>",
        "message_id": "<a@x>",
        "references": "<r@x>",
        "in_reply_to": "",
        "thread_id": "<root@x>",
        "parent_id": "<r@x>",
        "body": "hello",
        "date_source": "Date",
    }
    p = writer.message_payload(rec, 7)
    assert p["source"] == 7
    assert p["start_date"] == "2001-09-11T13:30:00"
    assert len(p["subject"]) == 255           # truncated
    assert p["in_reply_to"] is None           # empty → None
    assert p["thread_id"] == "<root@x>"
    assert p["approved"] == 1


@respx.mock
def test_upsert_source_reuses_existing():
    cfg = make_cfg()
    respx.get("http://directus:8055/items/sources").mock(
        return_value=httpx.Response(200, json={"data": [{"id": 42}]})
    )
    assert writer.upsert_source("ntl.talk", cfg) == 42


@respx.mock
def test_upsert_source_creates_when_absent():
    cfg = make_cfg()
    respx.get("http://directus:8055/items/sources").mock(
        return_value=httpx.Response(200, json={"data": []})
    )
    captured = {}

    def cap(request):
        captured.update(json.loads(request.content))
        return httpx.Response(200, json={"data": {"id": 99}})

    respx.post("http://directus:8055/items/sources").mock(side_effect=cap)
    assert writer.upsert_source("ntl.talk", cfg) == 99
    assert captured == {"name": "ntl.talk", "slug": "ntl.talk", "type": "usenet"}


@respx.mock
def test_write_group_replaces_and_bulk_inserts():
    cfg = make_cfg()
    respx.get("http://directus:8055/items/sources").mock(
        return_value=httpx.Response(200, json={"data": [{"id": 5}]})
    )
    delete_route = respx.delete("http://directus:8055/items/usenet_items").mock(
        return_value=httpx.Response(204)
    )
    posts = []

    def cap_post(request):
        posts.append(json.loads(request.content))
        return httpx.Response(200, json={"data": []})

    respx.post("http://directus:8055/items/usenet_items").mock(side_effect=cap_post)
    count_patch = {}

    def cap_patch(request):
        count_patch.update(json.loads(request.content))
        return httpx.Response(200, json={"data": {}})

    respx.patch("http://directus:8055/items/sources/5").mock(side_effect=cap_patch)

    records = [{"message_id": f"<{i}@x>", "start_date": "2001-09-11T00:00:00+00:00"} for i in range(600)]
    source_id, count = writer.write_group("ntl.talk", records, cfg)

    assert source_id == 5
    assert count == 600
    assert delete_route.called                 # group cleared before insert
    assert len(posts) == 2                      # 600 rows → two 500-chunked batches
    assert len(posts[0]) == 500 and len(posts[1]) == 100
    assert all(row["source"] == 5 for row in posts[0])
    assert count_patch == {"message_count": 600}  # precomputed count stored on source
