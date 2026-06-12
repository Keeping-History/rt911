"""
Prefect flow orchestration — six flows, one per pipeline stage.

Work pool type: kubernetes (prefect work-pool create video-pipeline --type kubernetes)
Worker image: prefecthq/prefect:3-python3.12-kubernetes
PREFECT_API_URL: http://prefect-server.video-grabber.svc.cluster.local:4200/api
"""
import json
import os
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import sqlalchemy as sa
from prefect import flow, get_run_logger
from prefect.deployments import run_deployment

from video_grabber.ia.scanner import crawl_collection
from video_grabber.pipeline.downloader import download_item
from video_grabber.pipeline.resolve import resolve_job
from video_grabber.video.encoder import encode_to_hls
from video_grabber.video.gap_filler import generate_gap_fmp4
from video_grabber.storage.wasabi import (
    upload_hls_package, upload_tree, upload_text, read_text, list_keys,
)
from video_grabber.directus.writer import write_media_item, upsert_channel_media_item
from video_grabber.epg.assembler import assemble_range
from video_grabber.epg.scheduler import build_schedule
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
    """Load a video_jobs row joined with its channel and program.

    Returns a SimpleNamespace whose shape matches what the downstream
    pipeline stages expect: the flat ``video_jobs`` columns at the top
    level, plus nested ``.channel`` and ``.program`` objects (the related
    rows reached via the ``channel_id`` / ``program_id`` foreign keys).
    A bare ``SELECT *`` row only carries the FK ids, so accessing
    ``job.channel`` on it raises NoSuchColumnError.

    ``passed_through_review`` is not a stored column; it is derived from
    the audit trail — true iff the job ever transitioned into the
    ``pending_review`` stage. It gates Directus ``approved`` (0 = awaiting
    human sign-off, 1 = auto-approved).
    """
    db = get_db()
    row = db.execute(
        sa.text(
            """
            SELECT
                j.*,
                c.slug             AS channel_slug,
                c.display_name     AS channel_display_name,
                c.timezone         AS channel_timezone,
                p.title            AS program_title,
                p.description      AS program_description,
                p.air_date         AS program_air_date,
                p.duration_seconds AS program_duration_seconds,
                EXISTS (
                    SELECT 1 FROM pipeline_transitions t
                    WHERE t.job_id = j.id
                      AND t.to_stage = 'pending_review'
                ) AS passed_through_review
            FROM video_jobs j
            LEFT JOIN channels c ON c.id = j.channel_id
            LEFT JOIN programs p ON p.id = j.program_id
            WHERE j.id = :id
            """
        ),
        {"id": job_id},
    ).mappings().fetchone()

    if row is None:
        raise ValueError(f"video_jobs row not found: {job_id}")

    m = dict(row)
    channel = SimpleNamespace(
        slug=m.pop("channel_slug"),
        display_name=m.pop("channel_display_name"),
        timezone=m.pop("channel_timezone"),
    )
    program = SimpleNamespace(
        title=m.pop("program_title"),
        description=m.pop("program_description"),
        air_date=m.pop("program_air_date"),
        duration_seconds=m.pop("program_duration_seconds"),
    )
    return SimpleNamespace(channel=channel, program=program, **m)


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

        # Bare video_jobs rows carry no channel/program. Derive and link them
        # from the IA metadata + downloaded media before any stage that needs
        # job.channel.* or job.program.* (upload prefix, Directus media_item).
        job = resolve_job(job, db, media_path=local_path)

        encode_dir = scratch / "encoded"

        transition_job(db, job_id, "encoding", from_stage="downloaded")
        encode_to_hls(local_path, encode_dir, logger=logger)

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


def _load_channel(db, channel_id: str):
    """Load a channel row as the namespace assemble_range / Directus expect."""
    row = db.execute(
        sa.text("SELECT id, slug, display_name, timezone FROM channels WHERE id = :id"),
        {"id": channel_id},
    ).mappings().fetchone()
    if row is None:
        raise ValueError(f"channels row not found: {channel_id}")
    return SimpleNamespace(**dict(row))


@flow(name="build-channel")
def build_channel_flow(channel_id: str, window_start: str, window_end: str):
    """Stitch a channel's programs into one continuous HLS stream over a window.

    schedule → assemble → publish. Run after process-item has uploaded the
    channel's program segments; re-run any time to fold in newly-completed
    programs (every step is idempotent). ``window_start`` / ``window_end`` are
    ISO-8601 UTC strings, e.g. "2001-09-09T00:00:00+00:00".
    """
    logger = get_run_logger()
    db = get_db()
    cfg = Config()
    ws = datetime.fromisoformat(window_start)
    we = datetime.fromisoformat(window_end)
    channel = _load_channel(db, channel_id)

    n_slots = build_schedule(channel_id, ws, we, db)
    logger.info("build-channel %s: %d slots scheduled", channel.slug, n_slots)

    playlists, epg_channel = assemble_range(channel, ws, we, db)

    # Channel-level blue gap package (date-independent); cheap to regenerate.
    gap_dir = _SCRATCH / f"_gap_{channel.slug}"
    generate_gap_fmp4(gap_dir)
    upload_tree(gap_dir, f"hls/{channel.slug}/_gap", cfg)

    # HLS playlists under playlists/<slug>/ (the EPG JSON guide lives in epg/).
    base = f"playlists/{channel.slug}"
    for name in ("master", "full", "mid", "thumb"):
        upload_text(playlists[name], f"{base}/{name}.m3u8", cfg)

    # EPG guide: per-channel JSON + the combined EPGChannel[] the frontend reads.
    upload_text(json.dumps(epg_channel), f"epg/{channel.slug}.json", cfg)
    _rebuild_epg_guide(cfg)

    master_url = f"{base}/master.m3u8"
    upsert_channel_media_item(channel, master_url, ws, cfg)
    logger.info("build-channel %s: published %s + EPG guide", channel.slug, master_url)


def _rebuild_epg_guide(cfg: Config) -> None:
    """Assemble per-channel ``epg/<slug>.json`` files into ``epg/guide.json``,
    the single ``EPGChannel[]`` array the EPG frontend consumes. Sorted by name
    for stable ordering. Re-run on every channel build so the guide reflects all
    channels published so far.
    """
    channels = []
    for key in sorted(list_keys("epg/", cfg)):
        if not key.endswith(".json") or key == "epg/guide.json":
            continue
        channels.append(json.loads(read_text(key, cfg)))
    channels.sort(key=lambda c: c.get("name", ""))
    upload_text(json.dumps(channels), "epg/guide.json", cfg)


@flow(name="dispatch-discovered")
def dispatch_discovered_flow(max_runs: int = 100) -> None:
    """Drain the ``stage='discovered'`` queue by triggering process-item runs.

    Each dispatch is a blocking ``run_deployment`` call — the next job only
    starts once the current one finishes (or fails). That keeps the queue
    depth at zero and surfaces failures immediately to the operator instead
    of letting hundreds of broken runs pile up.

    ``max_runs`` bounds a single dispatcher invocation so the flow itself
    has a definite end; trigger it again to drain more. Default 100 is
    enough for a typical batch but small enough that an operator who spots
    a bug can stop, fix, and rerun.
    """
    logger = get_run_logger()
    db = get_db()
    processed = 0
    while processed < max_runs:
        row = db.execute(
            sa.text(
                "SELECT id FROM video_jobs "
                "WHERE stage = 'discovered' "
                "ORDER BY created_at LIMIT 1"
            )
        ).first()
        if row is None:
            logger.info("dispatch-discovered: queue empty after %d runs", processed)
            return
        job_id = str(row.id)
        logger.info("dispatch-discovered: dispatching process-item job_id=%s", job_id)
        # Blocks until the process-item run reaches a terminal state.
        run_deployment(
            name="process-item/process-item",
            parameters={"job_id": job_id},
        )
        processed += 1
    logger.info("dispatch-discovered: hit max_runs=%d cap", max_runs)
