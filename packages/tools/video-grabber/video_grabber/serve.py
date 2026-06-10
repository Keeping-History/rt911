"""
Long-lived process that registers and serves video-grabber flows.

Runs in place of `prefect worker start` for process-type work pools.
The flows execute in this process, using the worker pod's mounted
/tmp/vg-scratch volume (see k8s/worker-deployment.yaml).
"""
from prefect import serve

from video_grabber.pipeline.flows import process_item_flow, scan_collections_flow


def main() -> None:
    serve(
        process_item_flow.to_deployment(name="process-item"),
        scan_collections_flow.to_deployment(name="scan-collections"),
    )


if __name__ == "__main__":
    main()
