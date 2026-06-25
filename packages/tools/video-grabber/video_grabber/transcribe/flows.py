"""Prefect flows for the audio-transcription pipeline.

Mirrors the usenet pipeline's scan → dispatch → process shape over
transcribe_jobs:

- scan-transcribe          enumerate completed TV programs + Wasabi audio/ keys
- dispatch-transcribe      atomically claim pending/failed jobs, run transcribe-item
- transcribe-item          extract audio → whisper.cpp → per-unit SRT/VTT; mp3 also
                           PATCHes its mp3_items row
- build-channel-subtitles  offset each program's cues onto the stitched timeline,
                           merge → channel SRT/VTT → PATCH tv_channels

The per-channel offset relies on the assembler's isochronous invariant: a program
airing at air_date sits at (air_date − tv_channels.start_date) seconds in the
stream (see ../epg/assembler.py and docs/transcription.md)."""
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import sqlalchemy as sa
from prefect import flow, get_run_logger
from prefect.deployments import run_deployment

from video_grabber.config import Config
from video_grabber.directus.writer import (
    _WASABI_BASE,
    patch_mp3_subtitles,
    patch_tv_channel_subtitles,
)
from video_grabber.storage import wasabi
from video_grabber.transcribe.audio import extract_audio
from video_grabber.transcribe.srt import Cue, merge, parse_srt, render_srt, render_vtt, shift
from video_grabber.transcribe.whisper import transcribe_wav

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


def get_transcribe_job(job_id: str):
    with get_db() as db:
        row = db.execute(
            sa.text("SELECT * FROM transcribe_jobs WHERE id = :id"), {"id": job_id}
        ).mappings().fetchone()
        if row is None:
            raise ValueError(f"transcribe_jobs row not found: {job_id}")
        return SimpleNamespace(**dict(row))


def transition_transcribe_job(db, job_id, to_stage, *, error=None, srt_key=None) -> None:
    sets = ["stage = CAST(:stage AS transcribe_stage)", "last_transition_at = now()"]
    params = {"stage": to_stage, "job_id": job_id}
    if error is not None:
        sets.append("error_message = :error")
        params["error"] = error
    else:
        sets.append("error_message = NULL")
    if srt_key is not None:
        sets.append("srt_key = :srt_key")
        params["srt_key"] = srt_key
    db.execute(sa.text(f"UPDATE transcribe_jobs SET {', '.join(sets)} WHERE id = :job_id"), params)
    db.commit()


# ---- pure merge helper (unit-tested) --------------------------------------

def _as_utc(dt: datetime) -> datetime:
    """Return *dt* as an aware UTC datetime.

    Naive datetimes (e.g. from Postgres ``timestamp WITHOUT time zone``) are
    assumed to already be in UTC and are tagged with ``timezone.utc``.  Aware
    datetimes are converted to UTC."""
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def build_channel_cues(window_start: datetime, programs: list[tuple[datetime, str]]) -> list[Cue]:
    """Offset each program's cues by (air_date − window_start) and merge.

    ``programs`` is ``[(air_date, srt_text), …]``. Returns merged, time-sorted cues
    on the channel's stitched-stream timeline.

    Both naive and aware datetimes are accepted.  Naive values are treated as UTC
    (matching the assembler's isochronous invariant) so that production rows from
    ``tv_channels.start_date`` (``timestamp WITHOUT time zone``) and
    ``programs.air_date`` (``timestamptz``) can be mixed without raising TypeError."""
    ws_utc = _as_utc(window_start)
    blocks: list[list[Cue]] = []
    for air_date, srt_text in programs:
        offset = (_as_utc(air_date) - ws_utc).total_seconds()
        blocks.append(shift(parse_srt(srt_text), offset))
    return merge(blocks)


# ---- flows ----------------------------------------------------------------

@flow(name="scan-transcribe")
def scan_transcribe_flow() -> None:
    """Enumerate work into transcribe_jobs. Idempotent (source_key UNIQUE)."""
    logger = get_run_logger()
    cfg = Config()
    with get_db() as db:
        # TV: every completed program with an uploaded master playlist.
        tv_rows = db.execute(sa.text("""
            SELECT p.ia_identifier, p.air_date, c.slug AS channel_slug, j.wasabi_key
            FROM video_jobs j
            JOIN programs p ON p.id = j.program_id
            JOIN channels c ON c.id = j.channel_id
            WHERE j.stage = 'complete' AND j.wasabi_key IS NOT NULL
        """)).mappings().all()
        tv_n = 0
        for r in tv_rows:
            src_url = f"{_WASABI_BASE}/{r['wasabi_key']}"
            res = db.execute(sa.text("""
                INSERT INTO transcribe_jobs (kind, source_key, channel_slug, source_url, stage)
                VALUES ('tv', :sk, :slug, :url, 'pending')
                ON CONFLICT (source_key) DO NOTHING
            """), {"sk": r["ia_identifier"], "slug": r["channel_slug"], "url": src_url})
            tv_n += res.rowcount or 0
        db.commit()

        # mp3: every audio/ object in the bucket.
        mp3_keys = [k for k in wasabi.list_keys("audio/", cfg) if k.lower().endswith(".mp3")]
        mp3_n = 0
        for key in mp3_keys:
            src_url = f"{_WASABI_BASE}/{key}"
            res = db.execute(sa.text("""
                INSERT INTO transcribe_jobs (kind, source_key, source_url, stage)
                VALUES ('mp3', :sk, :url, 'pending')
                ON CONFLICT (source_key) DO NOTHING
            """), {"sk": key, "url": src_url})
            mp3_n += res.rowcount or 0
        db.commit()
        logger.info("scan-transcribe: +%d tv, +%d mp3 new jobs", tv_n, mp3_n)


@flow(name="transcribe-item", retries=1, retry_delay_seconds=60)
def transcribe_item_flow(job_id: str) -> None:
    """Transcribe one unit. Produces per-unit SRT/VTT in Wasabi; mp3 also PATCHes
    its mp3_items row. TV's Directus write happens in build-channel-subtitles."""
    logger = get_run_logger()
    cfg = Config()
    db = get_db()
    job = get_transcribe_job(job_id)
    scratch = _SCRATCH / "transcribe" / str(job.id)
    try:
        transition_transcribe_job(db, job_id, "transcribing")
        wav = extract_audio(job.source_url, scratch / "audio.wav")
        out_base = scratch / "out"
        srt_path = transcribe_wav(wav, out_base, cfg)
        vtt_path = out_base.with_suffix(".vtt")

        if job.kind == "tv":
            base_key = f"{cfg.subtitles_prefix}/programs/{job.source_key}"
        else:  # mp3 → mirror the audio/ basename
            stem = Path(job.source_key).stem
            base_key = f"{cfg.subtitles_prefix}/audio/{stem}"
        srt_key = f"{base_key}.srt"
        wasabi.upload_text(srt_path.read_text(), srt_key, cfg)
        wasabi.upload_text(vtt_path.read_text(), f"{base_key}.vtt", cfg)

        if job.kind == "mp3":
            matched = patch_mp3_subtitles(job.source_url, f"{_WASABI_BASE}/{srt_key}", cfg)
            if not matched:
                logger.warning(
                    "transcribe-item: patch_mp3_subtitles found no mp3_items row for "
                    "source_url=%s source_key=%s — SRT/VTT uploaded but Directus not updated",
                    job.source_url,
                    job.source_key,
                )

        transition_transcribe_job(db, job_id, "done", srt_key=srt_key)
        logger.info("transcribe-item: %s %s → %s", job.kind, job.source_key, srt_key)
    except Exception as exc:  # noqa: BLE001 — record failure then re-raise for retry
        transition_transcribe_job(db, job_id, "failed", error=str(exc)[:2000])
        raise
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
        db.close()


@flow(name="build-channel-subtitles")
def build_channel_subtitles_flow(channel_slug: str) -> None:
    """Merge a channel's done programs into one SRT/VTT and PATCH tv_channels.

    window_start comes from tv_channels.start_date (the assembled window anchor).
    Re-runnable: regenerates the whole channel SRT from current 'done' programs."""
    logger = get_run_logger()
    cfg = Config()
    with get_db() as db:
        ws_row = db.execute(sa.text("""
            SELECT start_date FROM tv_channels
            WHERE content = :marker
        """), {"marker": json.dumps({"channel_stream": channel_slug})}).mappings().fetchone()
        if ws_row is None:
            logger.warning("build-channel-subtitles: no tv_channels row for %s; skipping", channel_slug)
            return
        window_start = ws_row["start_date"]

        rows = db.execute(sa.text("""
            SELECT p.air_date, t.srt_key
            FROM transcribe_jobs t
            JOIN programs p ON p.ia_identifier = t.source_key
            WHERE t.kind = 'tv' AND t.channel_slug = :slug
              AND t.stage = 'done' AND t.srt_key IS NOT NULL
            ORDER BY p.air_date
        """), {"slug": channel_slug}).mappings().all()
        if not rows:
            logger.info("build-channel-subtitles: %s has no done programs yet", channel_slug)
            return

    programs = [(r["air_date"], wasabi.read_text(r["srt_key"], cfg)) for r in rows]
    cues = build_channel_cues(window_start, programs)

    base_key = f"{cfg.subtitles_prefix}/{channel_slug}/channel"
    srt_key = f"{base_key}.srt"
    wasabi.upload_text(render_srt(cues), srt_key, cfg)
    wasabi.upload_text(render_vtt(cues), f"{base_key}.vtt", cfg)
    patch_tv_channel_subtitles(channel_slug, f"{_WASABI_BASE}/{srt_key}", cfg)
    logger.info("build-channel-subtitles: %s merged %d programs → %s",
                channel_slug, len(rows), srt_key)


@flow(name="dispatch-transcribe")
def dispatch_transcribe_flow(max_runs: int = 1000, max_retries: int = 3) -> None:
    """Drain transcribe_jobs by atomically claiming a job and blocking on its run.

    Same atomic-claim pattern as the video/usenet dispatchers. Pending work is
    claimed before retryable failed jobs; a failed claim spends one retry."""
    logger = get_run_logger()
    processed = 0
    with get_db() as db:
        while processed < max_runs:
            row = db.execute(sa.text("""
                UPDATE transcribe_jobs SET
                    stage = 'transcribing',
                    retry_count = retry_count + CASE WHEN stage = 'failed' THEN 1 ELSE 0 END,
                    last_transition_at = now()
                WHERE id = (
                    SELECT id FROM transcribe_jobs
                    WHERE stage = 'pending'
                       OR (stage = 'failed' AND retry_count < :max_retries)
                    ORDER BY (stage = 'failed'), created_at
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                )
                RETURNING id
            """), {"max_retries": max_retries}).first()
            db.commit()
            if row is None:
                logger.info("dispatch-transcribe: queue empty after %d runs", processed)
                return
            job_id = str(row.id)
            logger.info("dispatch-transcribe: claimed + dispatching job_id=%s", job_id)
            run_deployment(name="transcribe-item/transcribe-item", parameters={"job_id": job_id})
            processed += 1
    logger.info("dispatch-transcribe: hit max_runs=%d cap", max_runs)
