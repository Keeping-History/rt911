"""
Register the reconstruct-flights deployment on the flight-recon-k8s work pool.

Run from the package root (entrypoint paths are relative to it), with
PREFECT_API_URL pointing at the in-cluster server:

    PREFECT_API_URL=http://prefect-server.video-grabber.svc.cluster.local:4200/api \
        python -m flight_recon.deploy

Env knobs:
    FLIGHT_RECON_IMAGE  image ref baked into job pods (default flight-recon:0.1.1)
    FLIGHT_RECON_CRON   optional cron schedule, e.g. "0 6 * * 1" — omitted = manual runs only
"""

import os

from flight_recon.flow import reconstruct_flights

IMAGE = os.environ.get("FLIGHT_RECON_IMAGE", "flight-recon:0.1.1")
CRON = os.environ.get("FLIGHT_RECON_CRON")

if __name__ == "__main__":
    deployment_id = reconstruct_flights.deploy(
        name="reconstruct-flights-k8s",
        work_pool_name="flight-recon-k8s",
        image=IMAGE,
        build=False,   # image is built/loaded out-of-band (see README)
        push=False,
        cron=CRON,
        description="BTS On-Time -> plausible flight trajectories -> Directus "
                    "(flight_positions / flight_tracks / reconstruction_runs)",
        tags=["flight-recon"],
        parameters={
            "start": "2001-09-09",
            "end": "2001-09-12",
            "flights_path": "/app/data/sample_bts_2001-09-09_2001-09-12.csv",
            "airports_path": "/app/data/airports.csv",
        },
        job_variables={
            "namespace": "video-grabber",
            "image_pull_policy": "IfNotPresent",  # image is imported into k3s containerd
            "finished_job_ttl": 3600,
            "env": {
                "DIRECTUS_URL": "http://rt911-api.rt911.svc.cluster.local:8055",
            },
        },
    )
    print(f"registered deployment {deployment_id}")
