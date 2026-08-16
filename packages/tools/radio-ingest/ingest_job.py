#!/usr/bin/env python3
"""Radio station ingest: upload staged MP3s to Wasabi, upsert sources and
mp3_items rows in Directus. Runs in-cluster (video-grabber image) with
credentials from the pod environment; never prints secret values.

Idempotent: uploads skip when the object exists with the same size; mp3_items
are keyed by exact url (the same dedupe the catalogue backfill flow uses).
Directus requests are strictly serialized (api concurrency returns mixed
bodies — see project memory).
"""
import json
import os
import sys
from urllib.parse import quote

import boto3
import httpx

MANIFEST = "/ingest/ingest_manifest.json"
STAGING = "/staging"
WASABI_BASE = "https://files.911realtime.org"

TZ_LABEL = {"KFI": "PDT"}  # everything else is EDT

DIRECTUS_URL = os.environ["DIRECTUS_URL"].rstrip("/")
TOKEN = os.environ["DIRECTUS_API_TOKEN"]
BUCKET = os.environ["WASABI_BUCKET"]

s3 = boto3.client(
    "s3",
    endpoint_url=os.environ.get("WASABI_ENDPOINT_URL", "https://s3.us-central-1.wasabisys.com"),
    aws_access_key_id=os.environ["WASABI_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["WASABI_SECRET_ACCESS_KEY"],
)
client = httpx.Client(
    headers={"Authorization": f"Bearer {TOKEN}"},
    timeout=httpx.Timeout(60.0, read=120.0),
)


def directus(method, path, **kw):
    r = client.request(method, f"{DIRECTUS_URL}{path}", **kw)
    r.raise_for_status()
    return r.json().get("data")


def ensure_uploaded(key, local):
    size = os.path.getsize(local)
    try:
        head = s3.head_object(Bucket=BUCKET, Key=key)
        if head["ContentLength"] == size:
            print(f"  upload: exists ({size} bytes), skipping")
            return
        print(f"  upload: size mismatch (remote {head['ContentLength']} != {size}), re-uploading")
    except s3.exceptions.ClientError:
        pass
    s3.upload_file(local, BUCKET, key, ExtraArgs={"ContentType": "audio/mpeg"})
    print(f"  upload: done ({size} bytes)")


def ensure_source(slug, cache={}):
    if slug in cache:
        return cache[slug]
    rows = directus("GET", "/items/sources", params={
        "filter[slug][_eq]": slug, "fields": "id,slug,type", "limit": 1,
    })
    if rows:
        sid = rows[0]["id"]
        if rows[0].get("type") != "audio":
            directus("PATCH", f"/items/sources/{sid}", json={"type": "audio"})
            print(f"  source {slug}: id={sid} (set type=audio)")
        else:
            print(f"  source {slug}: id={sid}")
    else:
        row = directus("POST", "/items/sources", json={
            "slug": slug, "name": slug, "type": "audio",
        })
        sid = row["id"]
        print(f"  source {slug}: created id={sid}")
    cache[slug] = sid
    return sid


def ensure_item(entry, source_id):
    url = f"{WASABI_BASE}/{quote(entry['bucket_key'])}"
    existing = directus("GET", "/items/mp3_items", params={
        "filter[url][_eq]": url, "fields": "id", "limit": 1,
    })
    if existing:
        print(f"  mp3_items: exists id={existing[0]['id']}, skipping")
        return existing[0]["id"], False
    row = directus("POST", "/items/mp3_items", json={
        "title": entry["title"],
        "full_title": entry["full_title"],
        "source": source_id,
        "start_date": entry["start_date"],
        "end_date": entry["end_date"],
        "calc_duration": entry["calc_duration"],
        "timezone": entry.get("timezone") or TZ_LABEL.get(entry["source_slug"], "EDT"),
        "url": url,
        "format": "mp3",
        "approved": 1,
    })
    print(f"  mp3_items: created id={row['id']} start={entry['start_date']}Z")
    return row["id"], True


def main():
    entries = json.load(open(MANIFEST))
    print(f"{len(entries)} entries")
    created = 0
    for e in entries:
        print(f"[{e['source_slug']}] {e['file']}")
        local = os.path.join(STAGING, e["file"])
        if not os.path.exists(local):
            print("  MISSING from staging, aborting", file=sys.stderr)
            sys.exit(1)
        ensure_uploaded(e["bucket_key"], local)
        sid = ensure_source(e["source_slug"])
        _, was_created = ensure_item(e, sid)
        created += was_created
    print(f"complete: {created} rows created, {len(entries) - created} already present")


if __name__ == "__main__":
    main()
