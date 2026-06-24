"""
Directus media_items writer.

- Uses static API token (Authorization: Bearer) — safe across concurrent workers.
- Idempotent: checks for existing item by ia_identifier before inserting.
- start_date is naive UTC string (no Z, no offset) matching Directus dateTime convention.
- approved=1 for clean completions, approved=0 for items from pending_review.
"""
import json
from datetime import timedelta

import httpx

from video_grabber.config import Config

_WASABI_BASE = "https://files.911realtime.org"


def get_directus_token(cfg: Config) -> str:
    return cfg.directus_api_token


def _content_json(ia_identifier: str) -> str:
    """Serialized media_items.content blob. Single source of truth so the
    idempotency filter and the stored payload are byte-identical."""
    return json.dumps({"ia_identifier": ia_identifier})


def write_media_item(job, wasabi_url: str, cfg: Config) -> None:
    """Write completed pipeline item to Directus media_items table. Idempotent."""
    token = get_directus_token(cfg)
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    # Idempotency check. `content` is a plain text column holding a JSON
    # string, not a structured JSON field, so it cannot be traversed as
    # filter[content][ia_identifier] (Directus 403s on the missing field).
    # Match the exact serialized blob instead.
    resp = httpx.get(
        f"{cfg.directus_url}/items/media_items",
        params={"filter[content][_eq]": _content_json(job.ia_identifier)},
        headers=headers,
    )
    resp.raise_for_status()
    if resp.json().get("data"):
        return

    source_id = _resolve_source_id(job.channel.slug, headers, cfg)

    start_dt = job.program.air_date
    end_dt = start_dt + timedelta(seconds=job.program.duration_seconds)

    # Directus dateTime field requires naive UTC (no Z, no offset)
    start_str = start_dt.strftime("%Y-%m-%dT%H:%M:%S")
    end_str = end_dt.strftime("%Y-%m-%dT%H:%M:%S")

    payload = {
        "title": job.program.title[:255],
        "full_title": job.program.title,
        "source": source_id,
        "start_date": start_str,
        "end_date": end_str,
        "calc_duration": job.program.duration_seconds,
        "timezone": job.channel.timezone,
        "url": f"{_WASABI_BASE}/{wasabi_url}",
        "format": "m3u8",
        "approved": 0 if job.passed_through_review else 1,
        "content": _content_json(job.ia_identifier),
    }

    resp = httpx.post(
        f"{cfg.directus_url}/items/media_items",
        content=json.dumps(payload),
        headers=headers,
    )
    resp.raise_for_status()


def upsert_channel_media_item(
    channel, master_url: str, window_start, window_end, cfg: Config
) -> None:
    """Upsert the single continuous-stream row for a channel into ``tv_channels``.

    The stitched per-channel HLS streams live in their own ``tv_channels`` table
    (same shape as ``media_items``) — that is the table the streamer's main video
    channel reads. Idempotent on the playlist ``url``
    (``playlists/<slug>/master.m3u8``), which is fixed and unique per channel — so
    there is exactly one row per channel and re-runs PATCH it in place as more
    content is acquired. ``url`` is a normal indexed field; we key on it rather
    than ``content`` because ``content`` is stored as an opaque JSON *string* that
    can only be matched as a whole blob. The ``content.channel_stream`` marker is
    still written for downstream consumers, just not queried.

    ``start_date``/``end_date`` span the whole assembled window and
    ``calc_duration`` is its length in seconds — the channel stream is continuous
    across that span (gaps are blue-filled), so it is "active" for the entire
    window, not just an instant.
    """
    token = get_directus_token(cfg)
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    url = f"{_WASABI_BASE}/{master_url}"
    payload = {
        "title": channel.display_name,
        "full_title": channel.display_name,
        "source": _resolve_source_id(channel.slug, headers, cfg),
        "start_date": window_start.strftime("%Y-%m-%dT%H:%M:%S"),
        "end_date": window_end.strftime("%Y-%m-%dT%H:%M:%S"),
        "calc_duration": int((window_end - window_start).total_seconds()),
        "timezone": channel.timezone,
        "url": url,
        "format": "m3u8",
        "approved": 1,
        "content": json.dumps({"channel_stream": channel.slug}),
    }

    resp = httpx.get(
        f"{cfg.directus_url}/items/tv_channels",
        params={"filter[url][_eq]": url, "fields": "id"},
        headers=headers,
    )
    resp.raise_for_status()
    existing = resp.json().get("data")

    if existing:
        item_id = existing[0]["id"]
        resp = httpx.patch(
            f"{cfg.directus_url}/items/tv_channels/{item_id}",
            content=json.dumps(payload),
            headers=headers,
        )
    else:
        resp = httpx.post(
            f"{cfg.directus_url}/items/tv_channels",
            content=json.dumps(payload),
            headers=headers,
        )
    resp.raise_for_status()


def _resolve_source_id(slug: str, headers: dict, cfg: Config) -> int | None:
    # sources.slug is stored upper-cased (call signs / network codes, e.g.
    # "WETA", "CNN"), but channel slugs are lower-cased ("weta", "cnn").
    # Match case-insensitively so the lookup actually resolves.
    resp = httpx.get(
        f"{cfg.directus_url}/items/sources",
        params={"filter[slug][_eq]": slug.upper()},
        headers=headers,
    )
    resp.raise_for_status()
    data = resp.json().get("data", [])
    return data[0]["id"] if data else None
