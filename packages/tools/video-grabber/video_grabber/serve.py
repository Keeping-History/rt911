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
from prefect import serve

from video_grabber.pipeline.flows import (
    build_channel_flow,
    dispatch_discovered_flow,
    process_item_flow,
    scan_collections_flow,
)

# Two concurrent download+encode pipelines. The worker pod is sized to give each
# ~4 CPU cores (limit 8) so the two encodes run at full speed rather than
# time-slicing; 50 GiB scratch comfortably holds two in-flight items (~a few GiB
# each). Raise in lockstep with the pod CPU limit in infra worker.yaml.
_PROCESS_ITEM_LIMIT = 2
# Scanner is serial by design; per-call rate-limit lives in IA_RATE_PER_SEC.
_SCAN_LIMIT = 1
# Two concurrent dispatchers, to actually saturate the two-encode pipeline
# (_PROCESS_ITEM_LIMIT). Each dispatcher is blocking — it drives one process-item
# at a time — so it takes two dispatchers to keep two encodes running; a single
# one only ever reaches 1x. The two share the queue via stage transitions
# (process-item flips a job to 'downloading' at start, so the other dispatcher
# stops seeing it). A rare double-pick of the same job is possible in the brief
# window before that flip, but harmless: upload + Directus writes are idempotent,
# so the worst case is one wasted re-encode. (If that waste ever matters, claim
# rows atomically with SELECT ... FOR UPDATE SKIP LOCKED in the dispatcher.)
_DISPATCH_LIMIT = 2
# Channel assembly is ffmpeg-light (tiny gap segments) but writes shared
# playlists; one at a time keeps per-channel publishes from racing.
_BUILD_CHANNEL_LIMIT = 2


def main() -> None:
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
    )


if __name__ == "__main__":
    main()
