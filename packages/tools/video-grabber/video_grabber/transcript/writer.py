"""Directus I/O for chat_transcript_segments.

chat_transcript_segments is a Directus collection, so it is written over the
REST API rather than this package's Alembic-managed schema — the same split as
tv_channels, mp3_items, and usenet_items.
"""

import json
from datetime import datetime, timezone

import httpx

from video_grabber.config import Config

_COLLECTION = "chat_transcript_segments"

# Directus 413s past roughly 1MB, so batches are sized by serialized bytes
# rather than row count — a long transcript segment is far bigger than a short one.
_MAX_BATCH_BYTES = 900_000

# The default 5s read timeout fails on large server-side bulk operations.
_TIMEOUT = httpx.Timeout(connect=30.0, read=600.0, write=120.0, pool=30.0)


def _headers(cfg: Config) -> dict:
    return {"Authorization": f"Bearer {cfg.directus_api_token}"}


def _naive_utc(value: str) -> datetime:
    """Parse a Directus timestamp to naive UTC.

    Directus returns `timestamp` columns naive and `timestamptz` aware; mixing
    the two raises on subtraction, which is a tested bug class in this package.
    """
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is not None:
        # Convert to a fixed UTC offset before stripping tzinfo. astimezone(tz=None)
        # would convert to the *system local* timezone instead, which only happens
        # to equal UTC when the process's TZ is set to UTC — the exact ambient
        # dependency this helper exists to defuse.
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _slug_from_content(content) -> str | None:
    """Read the channel_stream marker out of the opaque `content` JSON string."""
    if not content:
        return None
    try:
        return json.loads(content).get("channel_stream")
    except (ValueError, AttributeError):
        return None


def list_subtitled_channels(cfg: Config, *, client=httpx) -> list[dict]:
    r = client.get(
        f"{cfg.directus_url}/items/tv_channels",
        params={"fields": "id,start_date,subtitles,content", "limit": -1},
        headers=_headers(cfg),
        timeout=_TIMEOUT,
    )
    r.raise_for_status()
    out = []
    for row in r.json()["data"]:
        if not row.get("subtitles"):
            continue
        out.append(
            {
                "id": row["id"],
                "slug": _slug_from_content(row.get("content")),
                "start_date": _naive_utc(row["start_date"]),
                "subtitles": row["subtitles"],
            }
        )
    return out


def list_subtitled_mp3_items(cfg: Config, *, client=httpx) -> list[dict]:
    r = client.get(
        f"{cfg.directus_url}/items/mp3_items",
        params={"fields": "id,start_date,subtitles", "limit": -1},
        headers=_headers(cfg),
        timeout=_TIMEOUT,
    )
    r.raise_for_status()
    out = []
    for row in r.json()["data"]:
        if not row.get("subtitles"):
            continue
        out.append(
            {
                "id": row["id"],
                "slug": None,
                "start_date": _naive_utc(row["start_date"]),
                "subtitles": row["subtitles"],
            }
        )
    return out


def fetch_srt(url: str, *, client=httpx) -> str:
    r = client.get(url, timeout=_TIMEOUT)
    r.raise_for_status()
    return r.text


def _clean(value):
    """Strip NUL bytes — Postgres text columns reject them and 400 the batch."""
    if isinstance(value, str):
        return value.replace("\x00", "")
    return value


def _size_batches(payloads: list[dict]):
    batch: list[dict] = []
    size = 2  # the enclosing [] brackets
    for p in payloads:
        psize = len(json.dumps(p)) + 1  # + comma
        if batch and size + psize > _MAX_BATCH_BYTES:
            yield batch
            batch, size = [], 2
        batch.append(p)
        size += psize
    if batch:
        yield batch


def replace_segments(
    rows: list[dict],
    *,
    medium: str,
    channel: int | None,
    channel_slug: str | None,
    cfg: Config,
    client=httpx,
) -> int:
    """Delete this source's existing segments, then insert the fresh set.

    Regenerate-and-replace rather than per-row upsert: it is far faster and
    trivially idempotent, matching how usenet groups and channel subtitles are
    already rebuilt. The delete runs even when there are no rows, so a source
    whose transcript became empty does not keep stale segments.
    """
    where = {"medium": {"_eq": medium}}
    if channel is not None:
        where["channel"] = {"_eq": channel}
    elif channel_slug is not None:
        where["channel_slug"] = {"_eq": channel_slug}
    else:
        raise ValueError("replace_segments needs a channel id or a channel_slug to scope the delete")

    d = client.request(
        "DELETE",
        f"{cfg.directus_url}/items/{_COLLECTION}",
        content=json.dumps({"query": {"filter": where, "limit": -1}}),
        headers={**_headers(cfg), "Content-Type": "application/json"},
        timeout=_TIMEOUT,
    )
    d.raise_for_status()

    # Directus's bulk delete can be capped server-side (QUERY_LIMIT_MAX), so
    # "limit": -1 above is not a guarantee it ran in one pass. Verify the scope
    # is actually empty before inserting — an insert on top of a partial delete
    # is the exact duplicate-data outcome this module exists to prevent.
    remaining = client.get(
        f"{cfg.directus_url}/items/{_COLLECTION}",
        params={"aggregate[count]": "*", "filter": json.dumps(where)},
        headers=_headers(cfg),
        timeout=_TIMEOUT,
    )
    remaining.raise_for_status()
    left = int(remaining.json()["data"][0]["count"])
    if left:
        raise RuntimeError(
            f"delete left {left} rows matching {where}; refusing to insert and duplicate"
        )

    cleaned = [{k: _clean(v) for k, v in row.items()} for row in rows]
    written = 0
    for batch in _size_batches(cleaned):
        r = client.post(
            f"{cfg.directus_url}/items/{_COLLECTION}",
            json=batch,
            headers=_headers(cfg),
            timeout=_TIMEOUT,
        )
        r.raise_for_status()
        written += len(batch)
    return written
