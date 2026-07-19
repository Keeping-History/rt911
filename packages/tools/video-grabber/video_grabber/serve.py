"""
Long-lived process that registers and serves video-grabber flows.

Runs in place of `prefect worker start` for process-type work pools.
The flows execute in this process, using the worker pod's mounted
/tmp/vg-scratch volume (see k8s/worker-deployment.yaml).

Concurrency limits cap simultaneous flow runs so we stay within IA's
2-concurrent bulk-access guideline and don't blow out the 50 GiB scratch
volume by stacking parallel downloads. Default collision strategy in
Prefect 3 is ENQUEUE, so excess runs queue rather than cancelling.

In-package modules (e.g. the scanner) receive ``get_run_logger()`` as
an injected ``logger`` argument from the flow rather than relying on
PREFECT_LOGGING_EXTRA_LOGGERS — that env var didn't surface the
stdlib loggers in the Prefect UI reliably, and dependency injection
avoids coupling pure modules to Prefect's runtime.
"""
import subprocess
import sys
import threading
import time

import sqlalchemy as sa
from prefect import serve

from video_grabber.pipeline.flows import (
    build_channel_flow,
    dispatch_discovered_flow,
    process_item_flow,
    requeue_pending_review_flow,
    scan_collections_flow,
)
from video_grabber.transcribe.flows import (
    build_channel_subtitles_flow,
    dispatch_transcribe_flow,
    scan_transcribe_flow,
    transcribe_item_flow,
)
from video_grabber.thumbnails.batch_flow import batch_thumbnails_flow
from video_grabber.usenet.flows import (
    dispatch_usenet_flow,
    process_usenet_item_flow,
    scan_usenet_flow,
)
from video_grabber.normalize.flows import (
    analyze_normalize_item_flow,
    dispatch_analyze_normalize_flow,
    dispatch_normalize_flow,
    normalize_item_flow,
    scan_normalize_flow,
)

# Four concurrent download+encode pipelines. These jobs are largely
# download-bound (pulling the ~200 MB .ogv derivative from IA) with VAAPI doing
# the video encode on the iGPU, so concurrency overlaps the network waits and
# 4x measurably beats 2x in practice. Keep the pod CPU limit and 50 GiB scratch
# in lockstep in infra worker.yaml (each in-flight item is ~a few GiB; raise pod
# CPU so the per-job decode/scale/audio work isn't CFS-throttled at this width).
_PROCESS_ITEM_LIMIT = 4
# Scanner is serial by design; per-call rate-limit lives in IA_RATE_PER_SEC.
_SCAN_LIMIT = 1
# Four concurrent dispatchers, to actually saturate the four-encode pipeline
# (_PROCESS_ITEM_LIMIT). Each dispatcher is blocking — it drives one process-item
# at a time — so it takes N dispatchers to keep N encodes running; a single one
# only ever reaches 1x. They share the queue via stage transitions (process-item
# flips a job to 'downloading' at start, so the others stop seeing it). A rare
# double-pick of the same job is possible in the brief window before that flip;
# it is harmless (upload + Directus are idempotent) and a completed-on-disk copy
# is now reused rather than re-fetched, so the worst case is one wasted re-encode.
# Raising the ceiling does not by itself start N dispatchers — that is still an
# operational step (launch N dispatch-discovered runs, or add a schedule).
_DISPATCH_LIMIT = 4
# Channel assembly is ffmpeg-light (tiny gap segments) but writes shared
# playlists; one at a time keeps per-channel publishes from racing.
_BUILD_CHANNEL_LIMIT = 2
# DB-only re-classification of the pending_review backlog; serial is plenty.
_REQUEUE_LIMIT = 1
# Usenet: scan is serial (IA rate-limited). Processing is download + a C++ thread
# pass + bulk Directus writes per archive — light on CPU/disk vs. video encode, so a
# wider fan-out is fine. Dispatchers are blocking, so it takes N to keep N running.
_USENET_SCAN_LIMIT = 1
_USENET_PROCESS_LIMIT = 4
_USENET_DISPATCH_LIMIT = 4
# Re-run the (bounded, idempotent) dispatcher every 5 minutes to keep the queue draining.
_USENET_DISPATCH_INTERVAL = 300
# Transcription shares the encode-1 iGPU with VAAPI video encode (whisper Vulkan
# vs. h264_vaapi). 6 concurrent whisper-Vulkan instances destabilised the iGPU —
# workers crashed silently (native SIGSEGV/SIGKILL, not OOM; the node had 96% RAM
# free), each orphaning its job and losing its slot until all 6 were dead and the
# pipeline stalled. Held at 3 to ease GPU contention; the supervisor below makes a
# crash self-healing rather than terminal. scan/dispatch are serial; channel merge
# writes one shared per-channel SRT so keep at 1.
_TRANSCRIBE_ITEM_LIMIT = 3
_TRANSCRIBE_SCAN_LIMIT = 1
_TRANSCRIBE_DISPATCH_LIMIT = 3
_BUILD_CHANNEL_SUBS_LIMIT = 1
# A live worker heartbeats its claimed job's last_transition_at every minute, so a
# 'transcribing' row untouched for this long means its worker died — recover it.
# Well above the 60s heartbeat but far below the ~1h46m max real transcription, so
# it never reclaims a job a slow-but-alive worker is still running.
_TRANSCRIBE_STALE_MINUTES = 5
_TRANSCRIBE_SUPERVISE_INTERVAL = 20
_TRANSCRIBE_MAX_RETRIES = 3
_THUMBNAIL_LIMIT = 1  # one batch run at a time; manually triggered from Prefect UI
# Loudness normalization: mp3 decode/encode is cheap next to the video encodes
# sharing this pod — 2 concurrent per-item flows, serial scan. Dispatchers are
# blocking (one item at a time each), so 2 keeps both item slots fed. NONE of
# these get a schedule; dispatch-normalize in particular is the operator's
# review gate — triggering it manually IS the go-ahead to rewrite audio/ bytes.
_NORMALIZE_SCAN_LIMIT = 1
_NORMALIZE_ITEM_LIMIT = 2
_NORMALIZE_DISPATCH_LIMIT = 2


def _recover_orphaned_transcribing(engine, stale_minutes: int) -> int:
    """Re-queue 'transcribing' jobs whose worker died mid-transcription.

    A worker that crashes (native SIGSEGV / SIGKILL) never runs the flow's
    except/finally, so its job is stuck in 'transcribing'. Live workers heartbeat
    last_transition_at every minute, so a row untouched for ``stale_minutes`` has
    no live worker → recover it: back to 'pending' to retry, or to 'failed' once
    retries are exhausted (kept for diagnosis), bumping retry_count either way.
    ``stale_minutes=0`` recovers every 'transcribing' row — used at boot, when no
    worker is running yet so all of them are orphans."""
    with engine.begin() as db:
        res = db.execute(sa.text("""
            UPDATE transcribe_jobs
               SET stage = CASE WHEN retry_count < :max
                                THEN CAST('pending' AS transcribe_stage)
                                ELSE CAST('failed'  AS transcribe_stage) END,
                   retry_count = retry_count + 1,
                   error_message = 'recovered: worker died/stalled mid-transcription',
                   last_transition_at = now()
             WHERE stage = 'transcribing'
               AND last_transition_at < now() - (:mins * interval '1 minute')
            RETURNING id
        """), {"max": _TRANSCRIBE_MAX_RETRIES, "mins": stale_minutes})
        return res.rowcount


def _spawn_transcribe_worker(i: int) -> subprocess.Popen:
    log = open(f"/tmp/transcribe-worker-{i}.log", "w")  # noqa: SIM115
    return subprocess.Popen(
        [sys.executable, "-m", "video_grabber.transcribe.dispatch_worker", str(i)],
        stdout=log,
        stderr=log,
    )


def _start_transcribe_workers() -> None:
    """Spawn one dispatch worker per slot and supervise them.

    Called once at pod startup, before serve() blocks. A background supervisor
    thread (a) respawns any worker that dies — a native whisper/Vulkan crash would
    otherwise permanently lose a slot — and (b) periodically re-queues jobs orphaned
    in 'transcribing' by such a crash. Workers write to /tmp/transcribe-worker-N.log."""
    from video_grabber.config import Config
    from video_grabber.transcribe.flows import _sync_db_url

    cfg = Config()
    engine = sa.create_engine(_sync_db_url(cfg.database_url))

    # On boot no worker is running, so every 'transcribing' row is an orphan.
    n = _recover_orphaned_transcribing(engine, 0)
    if n:
        print(f"[serve] recovered {n} orphaned transcribing job(s) at startup", flush=True)

    procs = {}
    for i in range(_TRANSCRIBE_DISPATCH_LIMIT):
        procs[i] = _spawn_transcribe_worker(i)
        print(f"[serve] started transcribe-worker-{i} pid={procs[i].pid}", flush=True)

    def supervise() -> None:
        while True:
            time.sleep(_TRANSCRIBE_SUPERVISE_INTERVAL)
            try:
                for i, proc in list(procs.items()):
                    if proc.poll() is not None:
                        print(f"[serve] transcribe-worker-{i} died (exit={proc.returncode}); "
                              "respawning", flush=True)
                        procs[i] = _spawn_transcribe_worker(i)
                recovered = _recover_orphaned_transcribing(engine, _TRANSCRIBE_STALE_MINUTES)
                if recovered:
                    print(f"[serve] recovered {recovered} stalled transcribing job(s)", flush=True)
            except Exception as exc:  # noqa: BLE001 — supervisor must never die
                print(f"[serve] transcribe supervisor error: {exc}", flush=True)

    threading.Thread(target=supervise, daemon=True, name="transcribe-supervisor").start()


def main() -> None:
    _start_transcribe_workers()
    serve(
        process_item_flow.to_deployment(
            name="process-item",
            concurrency_limit=_PROCESS_ITEM_LIMIT,
        ),
        scan_collections_flow.to_deployment(
            name="scan-collections",
            concurrency_limit=_SCAN_LIMIT,
        ),
        dispatch_discovered_flow.to_deployment(
            name="dispatch-discovered",
            concurrency_limit=_DISPATCH_LIMIT,
        ),
        build_channel_flow.to_deployment(
            name="build-channel",
            concurrency_limit=_BUILD_CHANNEL_LIMIT,
        ),
        requeue_pending_review_flow.to_deployment(
            name="requeue-pending-review",
            concurrency_limit=_REQUEUE_LIMIT,
        ),
        scan_usenet_flow.to_deployment(
            name="scan-usenet",
            concurrency_limit=_USENET_SCAN_LIMIT,
        ),
        process_usenet_item_flow.to_deployment(
            name="process-usenet-item",
            concurrency_limit=_USENET_PROCESS_LIMIT,
        ),
        # Scheduled every 5 minutes: each run drains discovered/failed jobs until
        # the queue empties, then returns (a no-op when empty). This is what makes
        # the pipeline self-draining after a one-time scan — no manual dispatch.
        # Overlapping runs (up to the concurrency limit) give N-way throughput.
        dispatch_usenet_flow.to_deployment(
            name="dispatch-usenet",
            concurrency_limit=_USENET_DISPATCH_LIMIT,
            interval=_USENET_DISPATCH_INTERVAL,
        ),
        transcribe_item_flow.to_deployment(
            name="transcribe-item",
            concurrency_limit=_TRANSCRIBE_ITEM_LIMIT,
        ),
        scan_transcribe_flow.to_deployment(
            name="scan-transcribe",
            concurrency_limit=_TRANSCRIBE_SCAN_LIMIT,
        ),
        dispatch_transcribe_flow.to_deployment(
            name="dispatch-transcribe",
            concurrency_limit=_TRANSCRIBE_DISPATCH_LIMIT,
        ),
        build_channel_subtitles_flow.to_deployment(
            name="build-channel-subtitles",
            concurrency_limit=_BUILD_CHANNEL_SUBS_LIMIT,
        ),
        batch_thumbnails_flow.to_deployment(
            name="batch-thumbnails",
            concurrency_limit=_THUMBNAIL_LIMIT,
        ),
        scan_normalize_flow.to_deployment(
            name="scan-normalize",
            concurrency_limit=_NORMALIZE_SCAN_LIMIT,
        ),
        dispatch_analyze_normalize_flow.to_deployment(
            name="dispatch-analyze-normalize",
            concurrency_limit=_NORMALIZE_DISPATCH_LIMIT,
        ),
        analyze_normalize_item_flow.to_deployment(
            name="analyze-normalize-item",
            concurrency_limit=_NORMALIZE_ITEM_LIMIT,
        ),
        # MANUAL ONLY — never add an interval/schedule here (destructive pass).
        dispatch_normalize_flow.to_deployment(
            name="dispatch-normalize",
            concurrency_limit=_NORMALIZE_DISPATCH_LIMIT,
        ),
        normalize_item_flow.to_deployment(
            name="normalize-item",
            concurrency_limit=_NORMALIZE_ITEM_LIMIT,
        ),
    )


if __name__ == "__main__":
    main()
