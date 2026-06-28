"""
Thin client for the Internet Archive Advanced Search API.

Replaces the `internetarchive` package: provides the same
search_items(query, fields) duck type used by the scanner modules.
"""
import logging
import time
from collections.abc import Iterator

import httpx

_LOG = logging.getLogger(__name__)
_SEARCH_URL = "https://archive.org/advancedsearch.php"
_PAGE_SIZE = 10_000


class IASearch:
    """Queries the IA Advanced Search API with transparent pagination.

    Drop-in for the removed internetarchive.ArchiveSession: callers only
    use search_items(query, fields). Implements the context-manager protocol
    so the underlying HTTP connection pool is closed cleanly on exit.
    """

    def __init__(
        self,
        client: httpx.Client | None = None,
        page_sleep: float = 0.5,
    ) -> None:
        self._owns_client = client is None
        self._client = client or httpx.Client(
            headers={"User-Agent": "rt911-video-grabber/1.0"},
            timeout=60.0,
        )
        self._page_sleep = page_sleep

    def __enter__(self) -> "IASearch":
        return self

    def __exit__(self, *_) -> None:
        if self._owns_client:
            self._client.close()

    def search_items(
        self,
        query: str,
        fields: list[str] | None = None,
    ) -> Iterator[dict]:
        """Yield one dict per matching IA item, fetching pages as needed."""
        params: dict[str, object] = {
            "q": query,
            "output": "json",
            "rows": _PAGE_SIZE,
        }
        if fields:
            params["fl"] = ",".join(fields)

        page = 1
        while True:
            resp = self._client.get(_SEARCH_URL, params={**params, "page": page})
            resp.raise_for_status()
            docs = resp.json().get("response", {}).get("docs", [])
            yield from docs
            if len(docs) < _PAGE_SIZE:
                break
            page += 1
            if self._page_sleep:
                time.sleep(self._page_sleep)
