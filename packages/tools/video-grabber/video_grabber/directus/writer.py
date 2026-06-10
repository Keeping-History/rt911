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


def write_media_item(job, wasabi_url: str, cfg: Config) -> None:
    """Write completed pipeline item to Directus media_items table. Idempotent."""
    token = get_directus_token(cfg)
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    # Idempotency check
    resp = httpx.get(
        f"{cfg.directus_url}/items/media_items",
        params={"filter[content][ia_identifier][_eq]": job.ia_identifier},
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
        "content": json.dumps({"ia_identifier": job.ia_identifier}),
    }

    resp = httpx.post(
        f"{cfg.directus_url}/items/media_items",
        content=json.dumps(payload),
        headers=headers,
    )
    resp.raise_for_status()


def _resolve_source_id(slug: str, headers: dict, cfg: Config) -> int | None:
    resp = httpx.get(
        f"{cfg.directus_url}/items/sources",
        params={"filter[slug][_eq]": slug},
        headers=headers,
    )
    resp.raise_for_status()
    data = resp.json().get("data", [])
    return data[0]["id"] if data else None
