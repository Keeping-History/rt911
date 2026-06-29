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
# vs. h264_vaapi). Encode backlog is fully drained; encode-1 is at ~5% CPU / 2% RAM
# so iGPU is idle. Raised to 6 concurrent slots. Revert if encode backlog returns.
# scan/dispatch are serial; channel merge writes one shared per-channel SRT so keep at 1.
_TRANSCRIBE_ITEM_LIMIT = 6
_TRANSCRIBE_SCAN_LIMIT = 1
_TRANSCRIBE_DISPATCH_LIMIT = 6
_BUILD_CHANNEL_SUBS_LIMIT = 1
_THUMBNAIL_LIMIT = 1  # one batch run at a time; manually triggered from Prefect UI


def _start_transcribe_workers() -> None:
    """Reset stuck transcription jobs and spawn one dispatch worker per slot.

    Called once at pod startup, before serve() blocks. Any job left in
    'transcribing' from the previous pod session is reset to 'failed' so the
    dispatcher retries it. Workers write to /tmp/transcribe-worker-N.log."""
    from video_grabber.config import Config
    from video_grabber.transcribe.flows import _sync_db_url

    cfg = Config()
    engine = sa.create_engine(_sync_db_url(cfg.database_url))
    with engine.connect() as db:
        result = db.execute(sa.text("""
            UPDATE transcribe_jobs
            SET stage = CAST('failed' AS transcribe_stage),
                error_message = 'reset: pod restarted'
            WHERE stage = 'transcribing'
            RETURNING id
        """))
        db.commit()
        n = result.rowcount
    engine.dispose()
    if n:
        print(f"[serve] reset {n} stuck transcribing job(s) to failed", flush=True)

    for i in range(_TRANSCRIBE_DISPATCH_LIMIT):
        log = open(f"/tmp/transcribe-worker-{i}.log", "w")  # noqa: SIM115
        proc = subprocess.Popen(
            [sys.executable, "-m", "video_grabber.transcribe.dispatch_worker", str(i)],
            stdout=log,
            stderr=log,
        )
        print(f"[serve] started transcribe-worker-{i} pid={proc.pid}", flush=True)


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
    )


if __name__ == "__main__":
    main()
