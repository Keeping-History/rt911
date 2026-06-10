"""
Prefect flow orchestration — six flows, one per pipeline stage.

Work pool type: kubernetes (prefect work-pool create video-pipeline --type kubernetes)
Worker image: prefecthq/prefect:3-python3.12-kubernetes
PREFECT_API_URL: http://prefect-server.video-grabber.svc.cluster.local:4200/api
"""
import os
from pathlib import Path

import sqlalchemy as sa
from prefect import flow, get_run_logger

from video_grabber.ia.scanner import crawl_collection
from video_grabber.pipeline.downloader import download_item
from video_grabber.video.encoder import encode_to_hls
from video_grabber.storage.wasabi import upload_hls_package
from video_grabber.directus.writer import write_media_item
from video_grabber.config import Config

try:
    from internetarchive import ArchiveSession
except ImportError:
    ArchiveSession = None  # not required in test environment


_SCRATCH = Path(os.getenv("SCRATCH_DIR", "/tmp/vg-scratch"))


_ASYNCPG_PREFIX = "postgresql+asyncpg://"
_PSYCOPG2_PREFIX = "postgresql+psycopg2://"


def _sync_db_url(url: str) -> str:
    """Force a sync psycopg2 driver. The shared Secret often uses the asyncpg
    scheme (Prefect's own server requires it), which raises MissingGreenlet
    inside sync flow code."""
    if url.startswith(_ASYNCPG_PREFIX):
        return _PSYCOPG2_PREFIX + url[len(_ASYNCPG_PREFIX):]
    return url


def get_db():
    """Return a sync SQLAlchemy connection from DATABASE_URL env var."""
    cfg = Config()
    engine = sa.create_engine(_sync_db_url(cfg.database_url))
    return engine.connect()


def get_job(job_id: str):
    db = get_db()
    result = db.execute(
        sa.text("SELECT * FROM video_jobs WHERE id = :id"),
        {"id": job_id},
    )
    return result.fetchone()


def transition_job(db, job_id: str, to_stage: str, *, from_stage: str = None, error: str = None) -> None:
    """Atomic stage transition: UPDATE video_jobs + INSERT pipeline_transitions audit row."""
    params = {
        "stage": to_stage,
        "job_id": job_id,
        "worker_id": os.getenv("HOSTNAME", "unknown"),
    }
    if error:
        db.execute(
            sa.text(
                "UPDATE video_jobs SET stage = CAST(:stage AS pipeline_stage), "
                "error_message = :error, last_transition_at = now() "
                "WHERE id = :job_id"
            ),
            {**params, "error": error},
        )
    else:
        db.execute(
            sa.text(
                "UPDATE video_jobs SET stage = CAST(:stage AS pipeline_stage), "
                "last_transition_at = now() WHERE id = :job_id"
            ),
            params,
        )

    db.execute(
        sa.text(
            "INSERT INTO pipeline_transitions (job_id, from_stage, to_stage, worker_id) "
            "VALUES (:job_id, CAST(:from_stage AS pipeline_stage), "
            "CAST(:to_stage AS pipeline_stage), :worker_id)"
        ),
        {
            "job_id": job_id,
            "from_stage": from_stage,
            "to_stage": to_stage,
            "worker_id": os.getenv("HOSTNAME", "unknown"),
        },
    )
    db.commit()


@flow(name="scan-collections")
def scan_collections_flow(collections: list[str] = ["sept_11_tv_archive", "911"]):
    logger = get_run_logger()
    cfg = Config()
    sleep_sec = 1.0 / cfg.ia_rate_per_sec if cfg.ia_rate_per_sec > 0 else 0.0
    session = ArchiveSession()
    db = get_db()
    for coll in collections:
        crawl_collection(
            session, coll, db,
            visited=set(),
            sleep_sec=sleep_sec,
            logger=logger,
        )
    logger.info("Scan complete")


@flow(name="process-item")
def process_item_flow(job_id: str):
    """Download → encode → upload for a single video_jobs row."""
    logger = get_run_logger()
    db = get_db()
    job = get_job(job_id)
    cfg = Config()
    scratch = _SCRATCH / job.ia_identifier

    try:
        transition_job(db, job_id, "downloading", from_stage=str(job.stage))
        local_path = download_item(job, scratch)

        transition_job(db, job_id, "downloaded", from_stage="downloading")
        encode_dir = scratch / "encoded"

        transition_job(db, job_id, "encoding", from_stage="downloaded")
        encode_to_hls(local_path, encode_dir)

        transition_job(db, job_id, "encoded", from_stage="encoding")

        transition_job(db, job_id, "uploading", from_stage="encoded")
        wasabi_key = upload_hls_package(job, encode_dir, cfg)

        db.execute(
            sa.text("UPDATE video_jobs SET wasabi_key = :key WHERE id = :id"),
            {"key": wasabi_key, "id": job_id},
        )
        db.commit()

        write_media_item(job, wasabi_key, cfg)
        transition_job(db, job_id, "complete", from_stage="uploading")
        logger.info(f"Completed: {job.ia_identifier}")

    except Exception as exc:
        transition_job(db, job_id, "failed", from_stage=None, error=str(exc))
        raise
