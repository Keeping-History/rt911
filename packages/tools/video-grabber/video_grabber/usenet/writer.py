"""
Directus writer for Usenet messages.

- Upserts a `sources` row (`type="usenet"`) per newsgroup, returning its id.
- Writes `usenet_items` for the group with a **replace** strategy: delete the
  group's existing rows, then bulk-insert in chunks. That is idempotent (a reprocess
  overwrites cleanly) and far faster than per-message upserts for large groups; the
  dedup key (`source`, `message_id`) is satisfied because the threader's
  kill-duplicates already removed duplicate message_ids within the group.
- `start_date` is naive UTC (strip mbox_parser's `+00:00`) per Directus convention.

See plans/usenet-archive-ingestion.md Stage 4 for the field mapping.
"""
import json
from datetime import datetime, timezone

import httpx

from video_grabber.config import Config

_USENET_SOURCE_TYPE = "usenet"
_BULK_CHUNK = 500


def _headers(cfg: Config) -> dict:
    return {
        "Authorization": f"Bearer {cfg.directus_api_token}",
        "Content-Type": "application/json",
    }


def _naive_utc(value) -> str | None:
    """Normalise an aware-UTC datetime or ISO string to a naive UTC Directus string.

    mbox_parser emits RFC3339 with a `+00:00` offset; Directus `dateTime` columns
    store naive UTC, so the offset must be dropped (not just truncated) after
    converting to UTC.
    """
    if value is None:
        return None
    dt = value if isinstance(value, datetime) else datetime.fromisoformat(value)
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


def _clean(s, limit=None):
    """Empty/whitespace → None; optionally truncate. Keeps NULLs out of text columns."""
    if not s:
        return None
    s = s.strip()
    if not s:
        return None
    return s[:limit] if limit else s


def message_payload(record: dict, source_id: int) -> dict:
    """Map a threaded mbox_parser record to a usenet_items row."""
    return {
        "source": source_id,
        "start_date": _naive_utc(record.get("start_date")),
        "subject": _clean(record.get("subject"), 255),
        "author": _clean(record.get("author")),
        "message_id": _clean(record.get("message_id")),
        "references": _clean(record.get("references")),
        "in_reply_to": _clean(record.get("in_reply_to")),
        "thread_id": _clean(record.get("thread_id")),
        "parent_id": _clean(record.get("parent_id")),
        "body": _clean(record.get("body")),
        "date_source": _clean(record.get("date_source")),
        "approved": 1,
    }


def upsert_source(newsgroup: str, cfg: Config, *, client=httpx) -> int | None:
    """Return the id of the `sources` row for the newsgroup, creating it if absent.

    Idempotent on `slug` (unique). Newsgroup names are dotted/lowercase and won't
    collide with the upper-cased video call-sign slugs.
    """
    headers = _headers(cfg)
    resp = client.get(
        f"{cfg.directus_url}/items/sources",
        params={"filter[slug][_eq]": newsgroup, "fields": "id"},
        headers=headers,
    )
    resp.raise_for_status()
    data = resp.json().get("data", [])
    if data:
        return data[0]["id"]

    resp = client.post(
        f"{cfg.directus_url}/items/sources",
        content=json.dumps({"name": newsgroup, "slug": newsgroup, "type": _USENET_SOURCE_TYPE}),
        headers=headers,
    )
    resp.raise_for_status()
    return resp.json().get("data", {}).get("id")


def delete_group_messages(source_id: int, cfg: Config, *, client=httpx) -> None:
    """Delete every usenet_items row for a source (Directus delete-by-query)."""
    headers = _headers(cfg)
    resp = client.request(
        "DELETE",
        f"{cfg.directus_url}/items/usenet_items",
        content=json.dumps({"query": {"filter": {"source": {"_eq": source_id}}}}),
        headers=headers,
    )
    # 204 No Content when rows matched; 200/no-op when none. Treat 404 as empty.
    if resp.status_code not in (200, 204, 404):
        resp.raise_for_status()


def write_group(newsgroup: str, records: list[dict], cfg: Config, *, client=httpx) -> tuple[int | None, int]:
    """Upsert the group source and replace its messages. Returns (source_id, count)."""
    headers = _headers(cfg)
    source_id = upsert_source(newsgroup, cfg, client=client)
    delete_group_messages(source_id, cfg, client=client)

    payloads = [message_payload(r, source_id) for r in records]
    for i in range(0, len(payloads), _BULK_CHUNK):
        resp = client.post(
            f"{cfg.directus_url}/items/usenet_items",
            content=json.dumps(payloads[i:i + _BULK_CHUNK]),
            headers=headers,
        )
        resp.raise_for_status()

    # Store the precomputed group size on the source row (the corpus is historical,
    # so this count is stable) — the streamer surfaces it in the browse list.
    if source_id is not None:
        resp = client.patch(
            f"{cfg.directus_url}/items/sources/{source_id}",
            content=json.dumps({"message_count": len(payloads)}),
            headers=headers,
        )
        resp.raise_for_status()
    return source_id, len(payloads)
