"""Tests for IASearch — no real network requests (respx intercepts httpx)."""
import httpx
import pytest
import respx

from video_grabber.ia.search import IASearch, _PAGE_SIZE, _SEARCH_URL


def _resp(docs, num_found=None):
    return httpx.Response(
        200,
        json={"response": {"numFound": num_found or len(docs), "start": 0, "docs": docs}},
    )


@respx.mock
def test_search_items_yields_docs():
    docs = [{"identifier": "item-1"}, {"identifier": "item-2"}]
    respx.get(_SEARCH_URL).mock(return_value=_resp(docs))
    assert list(IASearch(page_sleep=0).search_items("collection:test")) == docs


@respx.mock
def test_search_items_empty_yields_nothing():
    respx.get(_SEARCH_URL).mock(return_value=_resp([]))
    assert list(IASearch(page_sleep=0).search_items("collection:empty")) == []


@respx.mock
def test_search_items_sends_fields_as_comma_list():
    route = respx.get(_SEARCH_URL).mock(return_value=_resp([]))
    list(IASearch(page_sleep=0).search_items("collection:x", fields=["identifier", "title"]))
    assert "identifier%2Ctitle" in str(route.calls[0].request.url) or \
           "identifier,title" in str(route.calls[0].request.url)


@respx.mock
def test_search_items_paginates_until_short_page():
    page1 = [{"identifier": f"item-{i}"} for i in range(_PAGE_SIZE)]
    page2 = [{"identifier": "item-last"}]
    call_count = 0

    def handler(request):
        nonlocal call_count
        call_count += 1
        return _resp(page1 if call_count == 1 else page2)

    respx.get(_SEARCH_URL).mock(side_effect=handler)
    results = list(IASearch(page_sleep=0).search_items("collection:big"))

    assert len(results) == _PAGE_SIZE + 1
    assert call_count == 2


@respx.mock
def test_search_items_stops_after_exactly_page_size_items():
    """A full page with no further items: must not make a third request."""
    full_page = [{"identifier": f"i-{n}"} for n in range(_PAGE_SIZE)]
    empty = []
    call_count = 0

    def handler(request):
        nonlocal call_count
        call_count += 1
        return _resp(full_page if call_count == 1 else empty)

    respx.get(_SEARCH_URL).mock(side_effect=handler)
    results = list(IASearch(page_sleep=0).search_items("collection:exact"))

    assert len(results) == _PAGE_SIZE
    assert call_count == 2


@respx.mock
def test_search_items_raises_on_http_error():
    respx.get(_SEARCH_URL).mock(return_value=httpx.Response(503))
    with pytest.raises(httpx.HTTPStatusError):
        list(IASearch(page_sleep=0).search_items("collection:x"))


@respx.mock
def test_context_manager_closes_owned_client():
    respx.get(_SEARCH_URL).mock(return_value=_resp([]))
    with IASearch(page_sleep=0) as s:
        list(s.search_items("collection:x"))
    assert s._client.is_closed


@respx.mock
def test_context_manager_does_not_close_injected_client():
    respx.get(_SEARCH_URL).mock(return_value=_resp([]))
    client = httpx.Client()
    with IASearch(client=client, page_sleep=0) as s:
        list(s.search_items("collection:x"))
    assert not client.is_closed
    client.close()
