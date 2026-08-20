"""Paging over mp3_items, which several flows do while updating what they page.

The bug this guards: identify-parties reported 755 rows processed and left 119
of them untouched, having done ~119 others twice. LIMIT/OFFSET with no ORDER BY
has no defined order, and an UPDATE moves a row's physical position, so writing
while paging reshuffles the pages still to come.
"""
from types import SimpleNamespace

from video_grabber.catalogue.flows import _PAGE, _page_mp3_items


class FakeClient:
    """Records the params of each request and serves fixed pages."""

    def __init__(self, pages):
        self.pages = pages
        self.calls = []

    def get(self, url, params=None, headers=None):
        self.calls.append(params)
        page = self.pages.pop(0) if self.pages else []
        return SimpleNamespace(
            raise_for_status=lambda: None, json=lambda: {"data": page}
        )


def _cfg():
    # `directus_api_token` is what get_directus_token reads; the shorter name is
    # a different field and leaves the fake unauthenticated.
    return SimpleNamespace(directus_url="http://d", directus_api_token="t")


def test_every_page_is_ordered():
    """Without this, a flow that writes as it reads silently skips rows."""
    client = FakeClient([[{"id": i} for i in range(_PAGE)], [{"id": 9}]])
    list(_page_mp3_items(_cfg(), "id", client=client))
    assert len(client.calls) == 2
    assert all(c["sort"] == "id" for c in client.calls)


def test_offsets_advance_by_a_full_page():
    client = FakeClient([[{"id": i} for i in range(_PAGE)], [{"id": 9}]])
    list(_page_mp3_items(_cfg(), "id", client=client))
    assert [c["offset"] for c in client.calls] == [0, _PAGE]


def test_a_short_page_ends_the_walk():
    client = FakeClient([[{"id": 1}]])
    assert [r["id"] for r in _page_mp3_items(_cfg(), "id", client=client)] == [1]
    assert len(client.calls) == 1
