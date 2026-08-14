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
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import sqlalchemy as sa
from prefect import flow, get_run_logger
from prefect.deployments import run_deployment

from video_grabber.config import Config
from video_grabber.directus.writer import (
    get_tv_channel_start_date,
    patch_mp3_subtitles,
    patch_tv_channel_subtitles,
    wasabi_public_url,
)
from video_grabber.storage import wasabi
from video_grabber.transcribe.audio import extract_audio
from video_grabber.transcribe.chunking import windows
from video_grabber.transcribe.srt import (
    collapse_repetition_loops,
    Cue,
    dedupe_consecutive,
    merge,
    parse_srt,
    render_srt,
    render_vtt,
    shift,
    strip_nonspeech_cues,
)
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


def transition_transcribe_job(job_id, to_stage, *, error=None, srt_key=None) -> None:
    """Move a transcribe_jobs row to *to_stage* on a fresh, short-lived connection.

    Opening a connection per transition (rather than holding one across the
    flow) is load-bearing: rt911-db sets idle_session_timeout=10min on the
    video_grabber database, and whisper keeps transcribe-item busy for 15-20
    minutes — any connection opened before transcription is dead by the time
    the flow records 'done'/'failed'."""
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
    with get_db() as db:
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


def probe_duration_seconds(path: Path) -> float:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True,
    )
    if r.returncode != 0 or not r.stdout.strip():
        raise RuntimeError(f"ffprobe could not read a duration from {path}")
    return float(r.stdout.strip())


def slice_wav(src: Path, dest: Path, offset_ms: int, length_ms: int) -> Path:
    """Cut one window out of a WAV as its own file.

    Whisper is given the segment rather than the whole recording with -ot/-d,
    because --vad scans the ENTIRE input regardless of the duration flag. On a
    1-hour file that is ~11 s of wasted VAD per window; on the 6.75-hour NORAD
    tapes it is ~74 s per window across ~41 windows, which is most of the
    runtime. Measured on a 1-hour file: 49.8 s via -d, 38 s pre-split including
    the cut.

    -c copy on PCM is a byte-range cut, so this costs almost nothing.
    """
    r = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-y",
         "-ss", f"{offset_ms / 1000:.3f}", "-t", f"{length_ms / 1000:.3f}",
         "-i", str(src), "-c", "copy", str(dest)],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg could not slice {src} at {offset_ms}ms: {r.stderr[-400:]}")
    return dest


def read_whisper_text(path: Path) -> str:
    """Read a whisper output file, tolerating bytes that are not valid UTF-8.

    whisper.cpp writes raw decoder output and does not guarantee UTF-8. One NORAD
    tape emitted 0xb5 mid-file, which failed the whole job on the default strict
    decode -- losing 6+ hours of transcription over one byte. Replacing the
    offending bytes keeps the rest, which is the right trade for an archive: one
    mojibake character beats no transcript at all.
    """
    return path.read_text(encoding="utf-8", errors="replace")


def transcribe_windows(wav: Path, scratch: Path, cfg, duration_s: float) -> list[Cue]:
    """Transcribe a recording as a sequence of bounded windows, merged onto one
    timeline.

    Whole-file transcription collapses on the long position tapes: a single
    5-minute window of the NEADS MCC tape yields 150 words while the entire
    6.67-hour file yields 84. See
    plans/2026-08-13-audio-enhancement-findings.md.

    VAD is enabled for every window. On the short clips it costs nothing; on the
    tapes it is what stops hours of open-mic silence swamping the decoder.
    """
    blocks: list[list[Cue]] = []
    for i, (offset_ms, length_ms) in enumerate(
        windows(duration_s, cfg.chunk_seconds, cfg.chunk_overlap_seconds)
    ):
        base = scratch / f"w{i:04d}"
        segment = scratch / f"w{i:04d}.wav"
        slice_wav(wav, segment, offset_ms, length_ms)
        try:
            srt_path = transcribe_wav(segment, base, cfg, vad=True)
            blocks.append(shift(parse_srt(read_whisper_text(srt_path)), offset_ms / 1000.0))
        finally:
            segment.unlink(missing_ok=True)
    return merge(blocks)


def existing_srt_key(mp3_key: str, srt_stems: set[str], srt_paths: set[str]) -> str | None:
    """Return the SRT key already in the bucket for *mp3_key*, or None.

    Checks the mirrored layout first and falls back to the historical flat-stem
    layout, so this stays correct whichever layout the bucket is currently in.
    """
    mirrored = f"subtitles/{Path(mp3_key).with_suffix('.srt')}"
    if mirrored in srt_paths:
        return mirrored
    stem = Path(mp3_key).stem
    if stem in srt_stems:
        return f"subtitles/audio/{stem}.srt"
    return None


def subtitle_base_key(job_kind: str, source_key: str, cfg) -> str:
    """Extension-less subtitle key for a source.

    mp3 keys mirror their full audio/ path rather than collapsing to a bare
    stem: 93 basenames repeat across folders, and a flat namespace makes the
    second transcription silently overwrite the first. Those 93 are currently
    genuine duplicates of the same clip, so nothing is corrupt today — this is
    hardening against the first real collision.
    """
    if job_kind == "tv":
        return f"{cfg.subtitles_prefix}/programs/{source_key}"
    return f"{cfg.subtitles_prefix}/{Path(source_key).with_suffix('')}"


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
            src_url = wasabi_public_url(r["wasabi_key"])
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
            src_url = wasabi_public_url(key)
            res = db.execute(sa.text("""
                INSERT INTO transcribe_jobs (kind, source_key, source_url, stage)
                VALUES ('mp3', :sk, :url, 'pending')
                ON CONFLICT (source_key) DO NOTHING
            """), {"sk": key, "url": src_url})
            mp3_n += res.rowcount or 0
        db.commit()
        logger.info("scan-transcribe: +%d tv, +%d mp3 new jobs", tv_n, mp3_n)


@flow(name="reconcile-transcribe-jobs")
def reconcile_transcribe_jobs_flow() -> None:
    """Seed transcribe_jobs as 'done' for every mp3 whose SRT already exists.

    Load-bearing guard. transcribe_jobs is empty, and scan-transcribe only
    de-duplicates against rows that are already there — so without this, the next
    scan re-enqueues all 789 mp3s and re-transcribes ~296 hours of audio that is
    already captioned. Idempotent: ON CONFLICT DO NOTHING.
    """
    logger = get_run_logger()
    cfg = Config()
    srt_keys = [k for k in wasabi.list_keys(f"{cfg.subtitles_prefix}/", cfg)
                if k.endswith(".srt")]
    srt_paths = set(srt_keys)
    srt_stems = {Path(k).stem for k in srt_keys}
    mp3_keys = [k for k in wasabi.list_keys("audio/", cfg) if k.lower().endswith(".mp3")]

    seeded = skipped = 0
    with get_db() as db:
        for key in mp3_keys:
            srt_key = existing_srt_key(key, srt_stems, srt_paths)
            if srt_key is None:
                skipped += 1
                continue
            res = db.execute(sa.text("""
                INSERT INTO transcribe_jobs (kind, source_key, source_url, stage, srt_key)
                VALUES ('mp3', :sk, :url, 'done', :srt)
                ON CONFLICT (source_key) DO NOTHING
            """), {"sk": key, "url": wasabi_public_url(key), "srt": srt_key})
            seeded += res.rowcount or 0
        db.commit()
    logger.info("reconcile-transcribe-jobs: seeded %d done, %d still untranscribed",
                seeded, skipped)


@flow(name="transcribe-item", retries=1, retry_delay_seconds=60)
def transcribe_item_flow(job_id: str) -> None:
    """Transcribe one unit. Produces per-unit SRT/VTT in Wasabi; mp3 also PATCHes
    its mp3_items row. TV's Directus write happens in build-channel-subtitles."""
    logger = get_run_logger()
    cfg = Config()
    job = get_transcribe_job(job_id)
    scratch = _SCRATCH / "transcribe" / str(job.id)
    try:
        transition_transcribe_job(job_id, "transcribing")
        wav = extract_audio(job.source_url, scratch / "audio.wav")
        cues = transcribe_windows(wav, scratch, cfg, probe_duration_seconds(wav))

        # strip_nonspeech_cues runs BEFORE dedupe_consecutive so [Music] and
        # [BLANK_AUDIO] are removed outright rather than collapsed to one cue —
        # collapsing is what made six hours of open-mic NEADS audio look like a
        # clean 84-word transcript. dedupe then removes genuine hallucination
        # loops, where whisper repeats a phrase over silence.
        # Order matters. strip first so markers are removed outright rather than
        # collapsed to one; then collapse cycles, which catches the alternating
        # A/B/A/B loops dedupe_consecutive cannot see; then dedupe the leftover
        # identical pairs a cycle of two repeats leaves behind.
        clean_cues = dedupe_consecutive(
            collapse_repetition_loops(strip_nonspeech_cues(cues))
        )
        out_base = scratch / "out"
        out_base.parent.mkdir(parents=True, exist_ok=True)
        srt_path = out_base.with_suffix(".srt")
        vtt_path = out_base.with_suffix(".vtt")
        srt_path.write_text(render_srt(clean_cues))
        vtt_path.write_text(render_vtt(clean_cues))

        base_key = subtitle_base_key(job.kind, job.source_key, cfg)
        srt_key = f"{base_key}.srt"
        wasabi.upload_text(read_whisper_text(srt_path), srt_key, cfg)
        wasabi.upload_text(read_whisper_text(vtt_path), f"{base_key}.vtt", cfg)

        if job.kind == "mp3":
            matched = patch_mp3_subtitles(job.source_url, wasabi_public_url(srt_key), cfg)
            if not matched:
                # A miss means the SRT is in the bucket but nothing points at it.
                # This warned-and-continued for 575 jobs while every run reported
                # success — which is how the URL-encoding bug survived 18 months.
                # It is a failure, not a note.
                raise RuntimeError(
                    f"patch_mp3_subtitles matched no mp3_items row for "
                    f"source_url={job.source_url!r} (source_key={job.source_key!r}). "
                    f"SRT/VTT uploaded to {srt_key!r} but the row is unlinked."
                )

        transition_transcribe_job(job_id, "done", srt_key=srt_key)
        logger.info("transcribe-item: %s %s → %s", job.kind, job.source_key, srt_key)
    except Exception as exc:  # noqa: BLE001 — record failure then re-raise for retry
        transition_transcribe_job(job_id, "failed", error=str(exc)[:2000])
        raise
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


@flow(name="build-channel-subtitles")
def build_channel_subtitles_flow(channel_slug: str) -> None:
    """Merge a channel's done programs into one SRT/VTT and PATCH tv_channels.

    window_start comes from tv_channels.start_date (the assembled window anchor).
    Re-runnable: regenerates the whole channel SRT from current 'done' programs."""
    logger = get_run_logger()
    cfg = Config()
    window_start = get_tv_channel_start_date(channel_slug, cfg)
    if window_start is None:
        # Hard failure, not a skip. This lookup matches tv_channels on the
        # content marker {"channel_stream": <slug>}; a stale marker (CCTV4 sat
        # on "cctv3" long after everything else moved to "cctv4") silently
        # produced a COMPLETED run that wrote nothing, hiding a fully
        # transcribed channel with no subtitles. Fail loudly instead.
        raise ValueError(
            f"build-channel-subtitles: no tv_channels row matches "
            f'content marker {{"channel_stream": "{channel_slug}"}} — '
            "refusing to report success without writing subtitles"
        )

    with get_db() as db:
        rows = db.execute(sa.text("""
            SELECT p.air_date, t.srt_key
            FROM transcribe_jobs t
            JOIN programs p ON p.ia_identifier = t.source_key
            WHERE t.kind = 'tv' AND t.channel_slug = :slug
              AND t.stage = 'done' AND t.srt_key IS NOT NULL
            ORDER BY p.air_date
        """), {"slug": channel_slug}).mappings().all()
        if not rows:
            # Legitimate mid-rollout state (nothing transcribed yet), so not an
            # error — but warn, so an unexpectedly empty channel is visible
            # rather than buried at info level in a "successful" run.
            logger.warning(
                "build-channel-subtitles: %s has no done programs with an srt_key; "
                "wrote nothing", channel_slug,
            )
            return

    programs = [(r["air_date"], wasabi.read_text(r["srt_key"], cfg)) for r in rows]
    cues = build_channel_cues(window_start, programs)

    base_key = f"{cfg.subtitles_prefix}/{channel_slug}/channel"
    srt_key = f"{base_key}.srt"
    wasabi.upload_text(render_srt(cues), srt_key, cfg)
    wasabi.upload_text(render_vtt(cues), f"{base_key}.vtt", cfg)
    patch_tv_channel_subtitles(channel_slug, wasabi_public_url(srt_key), cfg)
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
