"""Tests for persisting derived tags as a many-to-many.

Mocks HTTP calls — no real Directus instance required.
"""
import httpx
import respx

from video_grabber.config import Config
from video_grabber.parties.tag_store import (
    ensure_tags,
    load_vocabulary,
    replace_item_tags,
    sync_item_tags,
)

BASE = "http://directus:8055"


def make_cfg():
    cfg = Config()
    cfg.directus_url = BASE
    cfg.directus_api_token = "static-token-xyz"
    return cfg


@respx.mock
def test_load_vocabulary_maps_tag_text_to_id():
    respx.get(f"{BASE}/items/mp3_tags").mock(return_value=httpx.Response(200, json={
        "data": [{"id": 3, "tag": "topic:wtc-impact"}, {"id": 8, "tag": "agency:faa"}],
    }))
    assert load_vocabulary(make_cfg()) == {"topic:wtc-impact": 3, "agency:faa": 8}


@respx.mock
def test_ensure_tags_creates_only_the_unknown_ones():
    """A tag already in the vocabulary must not be inserted a second time.

    This is the whole point of the restructure: 8192 taggings drew on 1131
    distinct tags, so re-inserting a known tag per tagging is what produced the
    duplication in the first place.
    """
    created = {}

    def record(request):
        created["body"] = request.content
        return httpx.Response(200, json={"data": [{"id": 99, "tag": "topic:new-one"}]})

    route = respx.post(f"{BASE}/items/mp3_tags").mock(side_effect=record)

    vocab = {"agency:faa": 8}
    records = [
        {"tag": "agency:faa", "namespace": "agency", "value": "faa"},
        {"tag": "topic:new-one", "namespace": "topic", "value": "new-one"},
    ]
    ids = ensure_tags(make_cfg(), records, vocab)

    assert ids == [8, 99]
    assert route.call_count == 1
    # Only the unknown tag is posted, and the vocabulary is updated in place so
    # the next item carrying it costs no insert at all.
    assert b"topic:new-one" in created["body"]
    assert b"agency:faa" not in created["body"]
    assert vocab["topic:new-one"] == 99


@respx.mock
def test_ensure_tags_makes_no_request_when_every_tag_is_known():
    route = respx.post(f"{BASE}/items/mp3_tags")
    vocab = {"agency:faa": 8}
    ids = ensure_tags(
        make_cfg(), [{"tag": "agency:faa", "namespace": "agency", "value": "faa"}], vocab
    )
    assert ids == [8]
    assert route.call_count == 0


@respx.mock
def test_replace_item_tags_deletes_the_previous_rows_then_inserts():
    """Rebuilding must retract, not accumulate.

    A tag the model no longer supports has to lose its junction row; without the
    delete, re-running would only ever add, entrenching old mistakes.
    """
    respx.get(f"{BASE}/items/mp3_items_tags").mock(
        return_value=httpx.Response(200, json={"data": [{"id": 11}, {"id": 12}]})
    )
    deleted, posted = {}, {}
    respx.delete(f"{BASE}/items/mp3_items_tags").mock(
        side_effect=lambda r: (deleted.setdefault("body", r.content),
                               httpx.Response(200, json={"data": []}))[1]
    )
    respx.post(f"{BASE}/items/mp3_items_tags").mock(
        side_effect=lambda r: (posted.setdefault("body", r.content),
                               httpx.Response(200, json={"data": []}))[1]
    )

    replace_item_tags(make_cfg(), 7, [3, 8])

    assert b"11" in deleted["body"] and b"12" in deleted["body"]
    assert b'"mp3_items_id":7' in posted["body"].replace(b" ", b"")
    assert b'"mp3_tags_id":3' in posted["body"].replace(b" ", b"")


@respx.mock
def test_replace_item_tags_skips_the_delete_when_there_is_nothing_to_remove():
    respx.get(f"{BASE}/items/mp3_items_tags").mock(
        return_value=httpx.Response(200, json={"data": []})
    )
    delete_route = respx.delete(f"{BASE}/items/mp3_items_tags")
    respx.post(f"{BASE}/items/mp3_items_tags").mock(
        return_value=httpx.Response(200, json={"data": []})
    )

    replace_item_tags(make_cfg(), 7, [3])
    assert delete_route.call_count == 0


@respx.mock
def test_replace_item_tags_clears_an_item_whose_tags_all_went_away():
    """An item that derives no tags must end up with none, not keep its old ones."""
    respx.get(f"{BASE}/items/mp3_items_tags").mock(
        return_value=httpx.Response(200, json={"data": [{"id": 11}]})
    )
    respx.delete(f"{BASE}/items/mp3_items_tags").mock(
        return_value=httpx.Response(200, json={"data": []})
    )
    post_route = respx.post(f"{BASE}/items/mp3_items_tags")

    replace_item_tags(make_cfg(), 7, [])
    assert post_route.call_count == 0


@respx.mock
def test_sync_item_tags_returns_the_tag_count():
    respx.post(f"{BASE}/items/mp3_tags").mock(
        return_value=httpx.Response(200, json={"data": [{"id": 99, "tag": "topic:x"}]})
    )
    respx.get(f"{BASE}/items/mp3_items_tags").mock(
        return_value=httpx.Response(200, json={"data": []})
    )
    respx.post(f"{BASE}/items/mp3_items_tags").mock(
        return_value=httpx.Response(200, json={"data": []})
    )
    vocab = {"agency:faa": 8}
    n = sync_item_tags(make_cfg(), 7, [
        {"tag": "agency:faa", "namespace": "agency", "value": "faa"},
        {"tag": "topic:x", "namespace": "topic", "value": "x"},
    ], vocab)
    assert n == 2
