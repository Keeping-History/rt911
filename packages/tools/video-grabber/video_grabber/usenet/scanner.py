"""
Internet Archive scanner for Usenet newsgroup archives.

Enumerates the configured IA collections (usenethistorical, giganews) and writes
one usenet_jobs row per newsgroup item. Like the video scanner, dedup is DB-level
via ON CONFLICT (ia_identifier) DO NOTHING, so rescans are safe and idempotent.

The scan records identifier + collection + a guessed mbox format; exact file
selection is deferred to the download stage (two-stage resolution), exactly as the
video pipeline defers it — resolving filenames here would cost an extra metadata
HTTP call per item across ~26k items. See plans/usenet-archive-ingestion.md.
"""
import json
import logging
import time
from typing import Optional

import sqlalchemy as sa

_LOG_EVERY = 100
_default_log = logging.getLogger(__name__)

# Per-collection payload format (validated against the live API 2026-06-17):
# usenethistorical ships <group>.mbox.zip, giganews ships <group>.mbox.gz. Both are
# decompressed transparently by mbox_parser. Unknown collections fall through to a
# "*mbox*" glob at download time.
_COLLECTION_FORMAT = {
    "usenethistorical": "zip",
    "giganews": "gz",
}


def guess_mbox_format(item: dict, collection: str) -> str:
    """Best-effort mbox payload format for an item: 'zip', 'gz', or 'unknown'.

    Prefers a hint from the item's advertised formats; falls back to the known
    per-collection default. The downloader globs '*mbox*' regardless, so this is
    only a record for diagnostics and parser-path selection.
    """
    fmts = item.get("format")
    blob = " ".join(fmts).lower() if isinstance(fmts, list) else str(fmts or "").lower()
    if "mbox.zip" in blob or blob.endswith(".zip") or "zip" == blob:
        return "zip"
    if "mbox.gz" in blob or "gzip" in blob or blob.endswith(".gz"):
        return "gz"
    return _COLLECTION_FORMAT.get(collection, "unknown")


def upsert_job(db, item: dict, *, collection: str) -> None:
    """Insert a usenet_jobs row at stage='discovered'. Idempotent on ia_identifier."""
    db.execute(
        sa.text(
            """
            INSERT INTO usenet_jobs (ia_identifier, collection, stage, mbox_format, ia_metadata)
            VALUES (
                :ia_identifier,
                :collection,
                CAST(:stage AS usenet_stage),
                :mbox_format,
                CAST(:ia_metadata AS jsonb)
            )
            ON CONFLICT (ia_identifier) DO NOTHING
            """
        ),
        {
            "ia_identifier": item["identifier"],
            "collection": collection,
            "stage": "discovered",
            "mbox_format": guess_mbox_format(item, collection),
            "ia_metadata": json.dumps(item, default=str),
        },
    )


def scan_collection(
    session,
    identifier: str,
    db,
    visited: set[str] | None = None,
    sleep_sec: float = 0.0,
    logger: Optional[logging.Logger] = None,
) -> int:
    """Enumerate one IA collection into usenet_jobs. Returns the count upserted.

    Nested collections are recursed (mirrors the video scanner); leaf items become
    jobs. Commits in batches so rows are visible to other readers during a long scan
    and survive a worker restart mid-crawl.
    """
    log = logger if logger is not None else _default_log
    if visited is None:
        visited = set()
    if identifier in visited:
        return 0
    visited.add(identifier)

    if sleep_sec:
        time.sleep(sleep_sec)
    log.info("usenet scan: %s — searching", identifier)
    # Fully drain the IA search cursor *before* any per-item DB write. The scraping
    # cursor expires if it is held open across slow per-item upserts (each commit,
    # on a loaded shared worker) — which silently truncated large collections:
    # giganews (25,328 items) stopped at ~400. Materializing the result list first
    # keeps the cursor short-lived, then the slow upserts run against memory. The
    # old per-item sleep made it worse (slower loop, longer-held cursor) and is
    # dropped; sleep_sec now throttles between *searches* instead.
    items = list(session.search_items(
        f"collection:{identifier}",
        fields=["identifier", "mediatype", "title", "format", "collection"],
    ))
    log.info("usenet scan: %s — %d items found, upserting", identifier, len(items))
    seen = inserted = nested = 0
    for item in items:
        seen += 1
        if item.get("mediatype") == "collection":
            nested += 1
            inserted += scan_collection(session, item["identifier"], db, visited, sleep_sec, logger=log)
        else:
            upsert_job(db, item, collection=identifier)
            inserted += 1
        if seen % _LOG_EVERY == 0:
            db.commit()
            log.info("usenet scan: %s — seen=%d upserted=%d nested=%d", identifier, seen, inserted, nested)
    db.commit()
    log.info("usenet scan: %s — DONE seen=%d upserted=%d nested=%d", identifier, seen, inserted, nested)
    return inserted


def scan_collections(
    session,
    collections: list[str],
    db,
    sleep_sec: float = 0.0,
    logger: Optional[logging.Logger] = None,
) -> int:
    """Scan every configured collection, sharing one visited-set so an item that
    appears under multiple collections is enumerated once. Returns total upserted."""
    visited: set[str] = set()
    total = 0
    for c in collections:
        total += scan_collection(session, c, db, visited, sleep_sec, logger=logger)
    return total
