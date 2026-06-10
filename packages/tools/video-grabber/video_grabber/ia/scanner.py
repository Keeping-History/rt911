"""
Recursive IA collection crawler that writes video_jobs rows.

Rate limiting is enforced externally by the Prefect flow (IA_RATE_PER_SEC).
Dedup is DB-level via ON CONFLICT (ia_identifier) DO NOTHING.
"""
import sqlalchemy as sa

from video_grabber.ia.channel_map import normalize_slug

MIN_DURATION_SECONDS = 720  # 12 minutes


def is_candidate(item: dict) -> bool:
    """Return True if the item meets minimum duration. Network check is permissive —
    unknown-network items go to pending_review rather than being dropped."""
    raw = item.get("length") or ""
    try:
        duration = float(str(raw).strip())
    except (ValueError, TypeError):
        return False
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
            VALUES (:ia_identifier, :collection, CAST(:stage AS pipeline_stage), :ia_metadata::jsonb)
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
) -> None:
    """Recursively crawl an IA collection, writing video_jobs for leaf items."""
    if visited is None:
        visited = set()
    if identifier in visited:
        return
    visited.add(identifier)

    results = session.search_items(
        f"collection:{identifier}",
        fields=[
            "identifier", "mediatype", "title", "description",
            "subject", "creator", "date", "length",
        ],
    )
    for item in results:
        if item.get("mediatype") == "collection":
            crawl_collection(session, item["identifier"], db, visited)
        elif is_candidate(item):
            upsert_job(db, item, collection=identifier)


def _json_dumps(obj) -> str:
    import json
    return json.dumps(obj, default=str)
