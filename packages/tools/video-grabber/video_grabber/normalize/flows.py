"""Prefect flows for the audio loudness-normalization pipeline.

Mirrors the transcribe pipeline's scan → dispatch → per-item shape over
normalize_jobs:

- scan-normalize             enumerate audio/*.mp3 into pending rows
- dispatch-analyze-normalize drain pending (+ failed-in-analysis) via blocking runs
- analyze-normalize-item     ffprobe + raw loudnorm measurement → analyzed|skipped
- dispatch-normalize         drain analyzed (+ failed-in-normalize). MANUAL ONLY —
                             the analyze→normalize gap is the operator review gate;
                             never give this deployment a schedule.
- normalize-item             archive-first in-place normalization (see below)

Failed rows are disambiguated by input_i: NULL → failed in analysis,
NOT NULL → failed in normalization. See plans/2026-07-19-audio-normalize-design.md.
"""
import os
import shutil
from pathlib import Path
from types import SimpleNamespace

import sqlalchemy as sa
from prefect import flow, get_run_logger
from prefect.deployments import run_deployment

import video_grabber.normalize.ffmpeg as nf
from video_grabber.config import Config
from video_grabber.directus.writer import _WASABI_BASE
from video_grabber.normalize.analysis import archive_key_for, needs_normalization
from video_grabber.normalize.purge import purge_urls
from video_grabber.storage import wasabi

_SCRATCH = Path(os.getenv("SCRATCH_DIR", "/tmp/vg-scratch"))
_ASYNCPG_PREFIX = "postgresql+asyncpg://"
_PSYCOPG2_PREFIX = "postgresql+psycopg2://"
_DEFAULT_CACHE_CONTROL = "max-age=31536000"
# A row untouched this long in an in-flight stage has no live worker. Well above
# the slowest observed item (~3 min for an hour-long mp3 analysis, more for a
# normalize render) because there is no heartbeat to distinguish slow from dead.
_STALE_MINUTES = 30


def _sync_db_url(url: str) -> str:
    if url.startswith(_ASYNCPG_PREFIX):
        return _PSYCOPG2_PREFIX + url[len(_ASYNCPG_PREFIX):]
    return url


_engine: sa.Engine | None = None


def _get_engine() -> sa.Engine:
    """One process-wide Engine with NullPool.

    Creating an Engine per call (the idiom the other pipelines use) leaks a
    pooled connection per call: closing the Connection returns it to that
    throwaway Engine's pool rather than to the server, so it lingers until GC
    or rt911-db's idle_session_timeout (10 min) reaps it. At the shipped
    width of 2 that stays under the ceiling; running the analyze pass wider
    exhausted max_connections=100 and started failing jobs with
    "sorry, too many clients already".

    NullPool closes each connection on release, so connection count tracks
    concurrent work instead of transition *rate* — and there is no pooled
    connection to go stale against idle_session_timeout either.
    """
    global _engine
    if _engine is None:
        cfg = Config()
        _engine = sa.create_engine(_sync_db_url(cfg.database_url), poolclass=sa.pool.NullPool)
    return _engine


def get_db():
    return _get_engine().connect()


def get_normalize_job(job_id: str):
    with get_db() as db:
        row = db.execute(
            sa.text("SELECT * FROM normalize_jobs WHERE id = :id"), {"id": job_id}
        ).mappings().fetchone()
        if row is None:
            raise ValueError(f"normalize_jobs row not found: {job_id}")
        return SimpleNamespace(**dict(row))


def transition_normalize_job(job_id, to_stage, *, error=None, input_i=None,
                             input_tp=None, input_lra=None, probe=None,
                             archive_key=None) -> None:
    """Move a normalize_jobs row to *to_stage* on a fresh, short-lived connection
    (idle_session_timeout=10min on this DB; same rationale as transcribe)."""
    import json as _json
    sets = ["stage = CAST(:stage AS normalize_stage)", "last_transition_at = now()"]
    params = {"stage": to_stage, "job_id": job_id}
    if error is not None:
        sets.append("error_message = :error")
        params["error"] = error
    else:
        sets.append("error_message = NULL")
    for col, val in (("input_i", input_i), ("input_tp", input_tp),
                     ("input_lra", input_lra), ("archive_key", archive_key)):
        if val is not None:
            sets.append(f"{col} = :{col}")
            params[col] = val
    if probe is not None:
        sets.append("probe = CAST(:probe AS jsonb)")
        params["probe"] = _json.dumps(probe)
    with get_db() as db:
        db.execute(sa.text(f"UPDATE normalize_jobs SET {', '.join(sets)} WHERE id = :job_id"), params)
        db.commit()


# ---- flows ----------------------------------------------------------------

@flow(name="scan-normalize")
def scan_normalize_flow() -> None:
    """Enumerate audio/*.mp3 into normalize_jobs. Idempotent (source_key UNIQUE)."""
    logger = get_run_logger()
    cfg = Config()
    keys = [k for k in wasabi.list_keys("audio/", cfg) if k.lower().endswith(".mp3")]
    n = 0
    with get_db() as db:
        for key in keys:
            res = db.execute(sa.text("""
                INSERT INTO normalize_jobs (source_key, stage)
                VALUES (:sk, 'pending')
                ON CONFLICT (source_key) DO NOTHING
            """), {"sk": key})
            n += res.rowcount or 0
        db.commit()
    logger.info("scan-normalize: %d audio keys, +%d new jobs", len(keys), n)


@flow(name="analyze-normalize-item", retries=1, retry_delay_seconds=60)
def analyze_normalize_item_flow(job_id: str) -> None:
    """Measure one file's raw loudness into the report columns; decide skip/analyzed."""
    logger = get_run_logger()
    cfg = Config()
    job = get_normalize_job(job_id)
    scratch = _SCRATCH / "normalize" / str(job.id)
    try:
        transition_normalize_job(job_id, "analyzing")
        src = wasabi.download_file(job.source_key, scratch / "in.mp3", cfg)
        probe_info = nf.probe(src)
        measured = nf.measure(src, cfg, with_dynaudnorm=False)
        input_i = float(measured["input_i"])
        input_tp = float(measured["input_tp"])
        input_lra = float(measured["input_lra"])
        stage = "analyzed" if needs_normalization(input_i, input_tp, cfg) else "skipped"
        transition_normalize_job(job_id, stage, input_i=input_i, input_tp=input_tp,
                                 input_lra=input_lra, probe=probe_info)
        logger.info("analyze-normalize-item: %s I=%.1f TP=%.1f LRA=%.1f → %s",
                    job.source_key, input_i, input_tp, input_lra, stage)
    except Exception as exc:  # noqa: BLE001 — record failure then re-raise for retry
        transition_normalize_job(job_id, "failed", error=str(exc)[:2000])
        raise
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


@flow(name="normalize-item", retries=1, retry_delay_seconds=60)
def normalize_item_flow(job_id: str) -> None:
    """Normalize one analyzed file in place, archive-first.

    Order is load-bearing:
      1. copy_object_if_absent → audio-original/ (first write wins FOREVER — on a
         retry the audio/ object may already be normalized; the archive is the
         only true original and must never be overwritten)
      2. download FROM THE ARCHIVE key (guaranteed original → idempotent re-runs)
      3. two-pass dynaudnorm+loudnorm render matching source encode params
      4. upload over audio/ preserving prior Cache-Control
      5. best-effort Cloudflare purge
    """
    logger = get_run_logger()
    cfg = Config()
    job = get_normalize_job(job_id)
    scratch = _SCRATCH / "normalize" / str(job.id)
    try:
        transition_normalize_job(job_id, "normalizing")
        arch_key = archive_key_for(job.source_key)
        wasabi.copy_object_if_absent(job.source_key, arch_key, cfg)

        head = wasabi.head_object(job.source_key, cfg) or {}
        cache_control = head.get("CacheControl") or _DEFAULT_CACHE_CONTROL

        src = wasabi.download_file(arch_key, scratch / "in.mp3", cfg)
        measured = nf.measure(src, cfg, with_dynaudnorm=True)
        out = nf.render(src, scratch / "out.mp3", measured, job.probe, cfg)
        wasabi.upload_mp3(out, job.source_key, cfg, cache_control=cache_control)
        purge_urls([f"{_WASABI_BASE}/{job.source_key}"], cfg, logger)

        transition_normalize_job(job_id, "done", archive_key=arch_key)
        logger.info("normalize-item: %s normalized in place (original → %s)",
                    job.source_key, arch_key)
    except Exception as exc:  # noqa: BLE001 — record failure then re-raise for retry
        transition_normalize_job(job_id, "failed", error=str(exc)[:2000])
        raise
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def recover_orphaned(from_stage: str, to_stage: str, stale_minutes: int,
                     max_retries: int) -> int:
    """Re-queue rows stranded in an in-flight stage by a dead worker.

    A pod roll (ArgoCD sync, node eviction, OOM) kills in-flight runs without
    running their except/finally, leaving rows in 'analyzing'/'normalizing'.
    Neither dispatcher claims those stages, so without this they are stranded
    forever — invisible to the queue and never retried. Observed in
    production: a mid-run pod replacement stranded 6 rows in 'analyzing'.

    Recovery targets are stage-specific: 'analyzing' → 'pending' (redo the
    measurement), 'normalizing' → 'analyzed' (the measurement survived; redo
    only the rewrite). Re-running normalize-item is safe because it is
    archive-first and always re-reads the original from audio-original/.

    ``stale_minutes`` must exceed the longest real run — there is no heartbeat
    here, so a too-small value would reclaim a job a slow-but-alive worker is
    still processing, running it twice.
    """
    with get_db() as db:
        res = db.execute(sa.text(f"""
            UPDATE normalize_jobs
               SET stage = CASE WHEN retry_count < :max
                                THEN CAST(:to_stage AS normalize_stage)
                                ELSE CAST('failed' AS normalize_stage) END,
                   retry_count = retry_count + 1,
                   error_message = 'recovered: worker died/stalled mid-{from_stage}',
                   last_transition_at = now()
             WHERE stage = CAST(:from_stage AS normalize_stage)
               AND last_transition_at < now() - (:mins * interval '1 minute')
        """), {"max": max_retries, "to_stage": to_stage,
               "from_stage": from_stage, "mins": stale_minutes})
        db.commit()
        return res.rowcount or 0


def _dispatch(logger, *, claim_sql: str, deployment: str, label: str,
              max_runs: int, max_retries: int) -> None:
    """Shared atomic-claim drain loop (transcribe idiom: UPDATE…SELECT…SKIP LOCKED).

    Each claim opens its own short-lived connection (idle_session_timeout=10min
    on this DB); the connection is closed *before* the blocking run_deployment
    call so it's never held idle across it."""
    processed = 0
    while processed < max_runs:
        with get_db() as db:
            row = db.execute(sa.text(claim_sql), {"max_retries": max_retries}).first()
            db.commit()
        if row is None:
            logger.info("%s: queue empty after %d runs", label, processed)
            return
        job_id = str(row.id)
        logger.info("%s: claimed + dispatching job_id=%s", label, job_id)
        run_deployment(name=deployment, parameters={"job_id": job_id})
        processed += 1
    logger.info("%s: hit max_runs=%d cap", label, max_runs)


@flow(name="dispatch-analyze-normalize")
def dispatch_analyze_normalize_flow(max_runs: int = 10000, max_retries: int = 3) -> None:
    """Drain pending analysis (+ failed-in-analysis: input_i IS NULL)."""
    logger = get_run_logger()
    recovered = recover_orphaned("analyzing", "pending", _STALE_MINUTES, max_retries)
    if recovered:
        logger.info("dispatch-analyze-normalize: recovered %d orphaned row(s)", recovered)
    _dispatch(
        logger,
        claim_sql="""
            UPDATE normalize_jobs SET
                stage = 'analyzing',
                retry_count = retry_count + CASE WHEN stage = 'failed' THEN 1 ELSE 0 END,
                last_transition_at = now()
            WHERE id = (
                SELECT id FROM normalize_jobs
                WHERE stage = 'pending'
                   OR (stage = 'failed' AND input_i IS NULL AND retry_count < :max_retries)
                ORDER BY (stage = 'failed'), created_at
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            RETURNING id
        """,
        deployment="analyze-normalize-item/analyze-normalize-item",
        label="dispatch-analyze-normalize",
        max_runs=max_runs,
        max_retries=max_retries,
    )


@flow(name="dispatch-normalize")
def dispatch_normalize_flow(max_runs: int = 10000, max_retries: int = 3) -> None:
    """Drain analyzed (+ failed-in-normalize: input_i IS NOT NULL). MANUAL ONLY —
    triggering this flow is the operator's go-ahead to rewrite bytes."""
    logger = get_run_logger()
    recovered = recover_orphaned("normalizing", "analyzed", _STALE_MINUTES, max_retries)
    if recovered:
        logger.info("dispatch-normalize: recovered %d orphaned row(s)", recovered)
    _dispatch(
        logger,
        claim_sql="""
            UPDATE normalize_jobs SET
                stage = 'normalizing',
                retry_count = retry_count + CASE WHEN stage = 'failed' THEN 1 ELSE 0 END,
                last_transition_at = now()
            WHERE id = (
                SELECT id FROM normalize_jobs
                WHERE stage = 'analyzed'
                   OR (stage = 'failed' AND input_i IS NOT NULL AND retry_count < :max_retries)
                ORDER BY (stage = 'failed'), created_at
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            RETURNING id
        """,
        deployment="normalize-item/normalize-item",
        label="dispatch-normalize",
        max_runs=max_runs,
        max_retries=max_retries,
    )
