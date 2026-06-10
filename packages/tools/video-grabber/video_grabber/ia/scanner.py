"""
Recursive IA collection crawler that writes video_jobs rows.

Dedup is DB-level via ON CONFLICT (ia_identifier) DO NOTHING.
"""
import logging
import time
from typing import Optional
import sqlalchemy as sa

from video_grabber.ia.channel_map import normalize_slug

MIN_DURATION_SECONDS = 720  # 12 minutes

_LOG_EVERY = 50  # progress log cadence inside crawl_collection
_default_log = logging.getLogger(__name__)


def is_candidate(item: dict) -> bool:
    """Return True if the item is plausibly a long-form broadcast.

    Many IA collections only expose ``length`` via the per-item metadata
    endpoint, not the advancedsearch results, so an item with no ``length``
    is treated as "unknown duration — let downstream stages verify" rather
    than dropped. We only reject items whose ``length`` is set *and*
    parseably shorter than ``MIN_DURATION_SECONDS``.
    """
    raw = item.get("length")
    if raw is None or str(raw).strip() == "":
        return True
    try:
        duration = float(str(raw).strip())
    except (ValueError, TypeError):
        return True
    return duration >= MIN_DURATION_SECONDS


def upsert_job(db, item: dict, *, collection: str) -> None:
    """Insert a video_jobs row. ON CONFLICT (ia_identifier) DO NOTHING for safe rescans.
    Items from unrecognized networks are inserted with stage='pending_review'."""
    slug = normalize_slug(item)
    stage = "discovered" if slug else "pending_review"

    db.execute(
        sa.text(
            """
            INSERT INTO video_jobs (ia_identifier, collection, stage, ia_metadata)
            VALUES (
                :ia_identifier,
                :collection,
                CAST(:stage AS pipeline_stage),
                CAST(:ia_metadata AS jsonb)
            )
            ON CONFLICT (ia_identifier) DO NOTHING
            """
        ),
        {
            "ia_identifier": item["identifier"],
            "collection": collection,
            "stage": stage,
            "ia_metadata": _json_dumps(item),
        },
    )


def crawl_collection(
    session,
    identifier: str,
    db,
    visited: set[str] | None = None,
    sleep_sec: float = 0.0,
    logger: Optional[logging.Logger] = None,
) -> None:
    """Recursively crawl an IA collection, writing video_jobs for leaf items.

    Emits progress logs every ``_LOG_EVERY`` items so operators can tell a
    rate-limited-but-working scan apart from a hang. The flow passes its
    Prefect ``get_run_logger()`` so progress shows in the Prefect UI; tests
    and direct-invocation get the stdlib module logger.
    """
    log = logger if logger is not None else _default_log
    if visited is None:
        visited = set()
    if identifier in visited:
        return
    visited.add(identifier)

    log.info("crawl_collection: %s — searching", identifier)
    results = session.search_items(
        f"collection:{identifier}",
        fields=[
            "identifier", "mediatype", "title", "description",
            "subject", "creator", "date", "length",
        ],
    )
    seen = inserted = nested = 0
    for item in results:
        if sleep_sec:
            time.sleep(sleep_sec)
        seen += 1
        if item.get("mediatype") == "collection":
            nested += 1
            crawl_collection(session, item["identifier"], db, visited, sleep_sec, logger=log)
        elif is_candidate(item):
            upsert_job(db, item, collection=identifier)
            inserted += 1
        if seen % _LOG_EVERY == 0:
            # Batch commit so rows become visible to other readers during the
            # crawl and survive a worker restart mid-scan.
            db.commit()
            log.info(
                "crawl_collection: %s — seen=%d upserted=%d nested=%d",
                identifier, seen, inserted, nested,
            )
    db.commit()
    log.info(
        "crawl_collection: %s — DONE seen=%d upserted=%d nested=%d",
        identifier, seen, inserted, nested,
    )


def _json_dumps(obj) -> str:
    import json
    return json.dumps(obj, default=str)
