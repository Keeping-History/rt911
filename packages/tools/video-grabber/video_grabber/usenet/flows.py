"""
Prefect flows for the Usenet ingestion pipeline.

Mirrors the video pipeline's scan → dispatch → process shape, over usenet_jobs:

- scan-usenet         enumerate IA collections into usenet_jobs (stage=discovered)
- dispatch-usenet     atomically claim discovered/failed jobs, run process-usenet-item
- process-usenet-item download → thread + parse → write to Directus

DB helpers are kept local (not imported from pipeline.flows) so this module doesn't
drag in the video pipeline's boto/ffmpeg dependencies.
"""
import os
import shutil
from pathlib import Path
from types import SimpleNamespace

import sqlalchemy as sa
from prefect import flow, get_run_logger
from prefect.deployments import run_deployment

from video_grabber.config import Config
from video_grabber.usenet.downloader import download_mbox
from video_grabber.usenet.processor import process_archive
from video_grabber.usenet.scanner import scan_collections
from video_grabber.usenet.writer import write_group

try:
    from internetarchive import ArchiveSession
except ImportError:
    ArchiveSession = None  # not required in test environment

_SCRATCH = Path(os.getenv("SCRATCH_DIR", "/tmp/vg-scratch"))

_ASYNCPG_PREFIX = "postgresql+asyncpg://"
_PSYCOPG2_PREFIX = "postgresql+psycopg2://"


def _sync_db_url(url: str) -> str:
    if url.startswith(_ASYNCPG_PREFIX):
        return _PSYCOPG2_PREFIX + url[len(_ASYNCPG_PREFIX):]
    return url


def get_db():
    cfg = Config()
    engine = sa.create_engine(_sync_db_url(cfg.database_url))
    return engine.connect()


def get_usenet_job(job_id: str):
    """Load a usenet_jobs row as a SimpleNamespace of its columns."""
    db = get_db()
    row = db.execute(
        sa.text("SELECT * FROM usenet_jobs WHERE id = :id"), {"id": job_id}
    ).mappings().fetchone()
    if row is None:
        raise ValueError(f"usenet_jobs row not found: {job_id}")
    return SimpleNamespace(**dict(row))


def transition_usenet_job(db, job_id: str, to_stage: str, *, error: str = None, message_count: int = None) -> None:
    """Set a usenet_jobs row's stage (+ optional error / message_count). Commits."""
    sets = ["stage = CAST(:stage AS usenet_stage)", "last_transition_at = now()"]
    params = {"stage": to_stage, "job_id": job_id}
    if error is not None:
        sets.append("error_message = :error")
        params["error"] = error
    else:
        sets.append("error_message = NULL")  # clear a stale error on a clean transition
    if message_count is not None:
        sets.append("message_count = :mc")
        params["mc"] = message_count
    db.execute(sa.text(f"UPDATE usenet_jobs SET {', '.join(sets)} WHERE id = :job_id"), params)
    db.commit()


@flow(name="scan-usenet")
def scan_usenet_flow(collections: list[str] | None = None) -> None:
    logger = get_run_logger()
    cfg = Config()
    collections = collections or cfg.usenet_collection_list()
    sleep_sec = 1.0 / cfg.ia_rate_per_sec if cfg.ia_rate_per_sec > 0 else 0.0
    session = ArchiveSession()
    db = get_db()
    total = scan_collections(session, collections, db, sleep_sec=sleep_sec, logger=logger)
    logger.info("scan-usenet: complete, %d items enumerated", total)


@flow(name="process-usenet-item", retries=2, retry_delay_seconds=60)
def process_usenet_item_flow(job_id: str) -> None:
    """Download, thread, parse, and ingest one newsgroup archive.

    Idempotent at every stage: download resumes, the writer replaces a group's
    rows. On failure the job is left in 'failed' (kept for diagnosis) and re-raised
    so the flow-level retry and the dispatcher's failed-requeue can reattempt it.
    """
    logger = get_run_logger()
    cfg = Config()
    db = get_db()
    job = get_usenet_job(job_id)
    scratch = _SCRATCH / "usenet" / job.ia_identifier
    try:
        transition_usenet_job(db, job_id, "downloading")
        mbox_path = download_mbox(job, scratch / "dl", logger=logger)
        transition_usenet_job(db, job_id, "downloaded")

        transition_usenet_job(db, job_id, "processing")
        fallback_group = job.ia_identifier.removeprefix("usenet-")
        groups = process_archive(mbox_path, cfg.usenet_before, scratch / "work", fallback_group, logger=logger)

        total = 0
        for newsgroup, records in groups.items():
            _, n = write_group(newsgroup, records, cfg)
            total += n
        transition_usenet_job(db, job_id, "processed", message_count=total)
        logger.info("process-usenet-item: %s ingested %d messages in %d groups",
                    job.ia_identifier, total, len(groups))
    except Exception as exc:  # noqa: BLE001 — record failure, then re-raise for retry
        transition_usenet_job(db, job_id, "failed", error=str(exc)[:2000])
        raise
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


@flow(name="dispatch-usenet")
def dispatch_usenet_flow(max_runs: int = 100, max_retries: int = 3) -> None:
    """Drain usenet_jobs by atomically claiming a job and blocking on its process run.

    Same atomic-claim pattern as the video dispatcher: an UPDATE over
    SELECT ... FOR UPDATE SKIP LOCKED flips a single job to 'downloading' before any
    other dispatcher sees it, so concurrent dispatchers never double-pick. Fresh
    'discovered' work is claimed before retryable 'failed' jobs; claiming a failed
    job spends one retry, bounding the loop at max_retries.
    """
    logger = get_run_logger()
    db = get_db()
    processed = 0
    while processed < max_runs:
        row = db.execute(
            sa.text(
                """
                UPDATE usenet_jobs SET
                    stage = 'downloading',
                    retry_count = retry_count
                        + CASE WHEN stage = 'failed' THEN 1 ELSE 0 END,
                    last_transition_at = now()
                WHERE id = (
                    SELECT id FROM usenet_jobs
                    WHERE stage = 'discovered'
                       OR (stage = 'failed' AND retry_count < :max_retries)
                    ORDER BY (stage = 'failed'), created_at
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                )
                RETURNING id
                """
            ),
            {"max_retries": max_retries},
        ).first()
        db.commit()
        if row is None:
            logger.info("dispatch-usenet: queue empty after %d runs", processed)
            return
        job_id = str(row.id)
        logger.info("dispatch-usenet: claimed + dispatching job_id=%s", job_id)
        run_deployment(name="process-usenet-item/process-usenet-item", parameters={"job_id": job_id})
        processed += 1
    logger.info("dispatch-usenet: hit max_runs=%d cap", max_runs)
