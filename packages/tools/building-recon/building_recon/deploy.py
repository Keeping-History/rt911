"""
Register the reconstruct-2001-buildings deployment on the building-recon-k8s work pool.

Run from the package root (entrypoint paths are relative to it), with
PREFECT_API_URL pointing at the in-cluster server:

    PREFECT_API_URL=http://prefect-server.video-grabber.svc.cluster.local:4200/api \
        python -m building_recon.deploy

Env knobs:
    BUILDING_RECON_IMAGE  image ref baked into job pods (default building-recon:0.1.0)
"""

import os

from building_recon.flow import reconstruct_buildings

IMAGE = os.environ.get("BUILDING_RECON_IMAGE", "building-recon:0.1.0")

if __name__ == "__main__":
    deployment_id = reconstruct_buildings.deploy(
        name="reconstruct-2001-buildings-k8s",
        work_pool_name="building-recon-k8s",
        image=IMAGE,
        build=False,   # image is built/loaded out-of-band (see README)
        push=False,
        description="2001 building footprints (NYC, DC, Arlington) + curated WTC "
                    "-> Directus buildings collection + Wasabi GeoJSON",
        tags=["building-recon"],
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
