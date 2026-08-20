"""Persist derived tags as a many-to-many, mirroring the readme_* collections.

Three collections, the shape Directus expects of an m2m and the one
`readme_articles` already uses here:

    mp3_tags        vocabulary   one row per distinct tag
    mp3_items_tags  junction     (mp3_items_id, mp3_tags_id)
    mp3_items.tags  alias        list-m2m over the junction

The previous shape wrote one `mp3_tags` row per *tagging* with the tag text
inlined — 8192 rows repeating 1131 distinct tags, plus a `start_date` copied
from the parent item on every row. Nothing could rename a tag, and the text was
stored ~7x over. Time filtering never needed the copy either: it goes through
`mp3_items.start_date`, which is where the index belongs.

Vocabulary rows are created but never deleted here. A tag the model retracts
loses its junction rows and so disappears from every search, but the row itself
is cheap and may be referenced again on the next run; garbage-collecting it
would also throw away any `color`/`sort` a curator had set on it.
"""
from __future__ import annotations

import logging

import httpx

from video_grabber.config import Config
from video_grabber.directus.writer import _auth_headers

logger = logging.getLogger(__name__)

_TIMEOUT = 60.0


def load_vocabulary(cfg: Config) -> dict[str, int]:
    """Every known tag as `{tag: id}`.

    Read once per flow run rather than per row: the vocabulary is ~1100 rows
    against ~800 items, so a lookup per item would spend most of its requests
    re-reading the same table.
    """
    r = httpx.get(
        f"{cfg.directus_url}/items/mp3_tags",
        params={"fields": "id,tag", "limit": "-1"},
        headers=_auth_headers(cfg), timeout=_TIMEOUT,
    )
    r.raise_for_status()
    return {row["tag"]: row["id"] for row in r.json()["data"] if row.get("tag")}


def ensure_tags(cfg: Config, records: list[dict], vocab: dict[str, int]) -> list[int]:
    """Ids for `records`, creating any vocabulary row that does not exist yet.

    `vocab` is updated in place, so a tag first seen on one item costs one
    insert for the whole run rather than one per item that carries it.
    """
    missing = [r for r in records if r["tag"] not in vocab]
    if missing:
        resp = httpx.post(
            f"{cfg.directus_url}/items/mp3_tags",
            json=missing, headers=_auth_headers(cfg), timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        for row in resp.json()["data"]:
            vocab[row["tag"]] = row["id"]
    return [vocab[r["tag"]] for r in records]


def replace_item_tags(cfg: Config, item_id: int, tag_ids: list[int]) -> None:
    """Make the item's junction rows exactly `tag_ids`.

    Delete-then-insert rather than a diff: the derived set is rebuilt from
    scratch on every run anyway (see `build_tags`), so computing a minimal patch
    would be more code for the same end state. Existing rows are read and
    deleted by id rather than by filter because a filtered DELETE that silently
    matches nothing and one that silently matches everything look identical in
    the response.
    """
    headers = _auth_headers(cfg)
    base = f"{cfg.directus_url}/items/mp3_items_tags"

    existing = httpx.get(
        base,
        params={"fields": "id", "limit": "-1",
                "filter[mp3_items_id][_eq]": str(item_id)},
        headers=headers, timeout=_TIMEOUT,
    )
    existing.raise_for_status()
    stale = [row["id"] for row in existing.json()["data"]]
    if stale:
        resp = httpx.request(
            "DELETE", base, json=stale, headers=headers, timeout=_TIMEOUT,
        )
        resp.raise_for_status()

    if tag_ids:
        resp = httpx.post(
            base,
            json=[{"mp3_items_id": item_id, "mp3_tags_id": t} for t in tag_ids],
            headers=headers, timeout=_TIMEOUT,
        )
        resp.raise_for_status()


def sync_item_tags(
    cfg: Config, item_id: int, records: list[dict], vocab: dict[str, int]
) -> int:
    """Point one item at exactly `records`. Returns how many tags it now carries."""
    tag_ids = ensure_tags(cfg, records, vocab)
    replace_item_tags(cfg, item_id, tag_ids)
    return len(tag_ids)
