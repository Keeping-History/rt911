"""
Register the load-weather-stations deployment on the weather-recon-k8s work pool.

Run from the package root, with PREFECT_API_URL pointing at the in-cluster server:

    PREFECT_API_URL=http://prefect-server.video-grabber.svc.cluster.local:4200/api \
        python -m weather_recon.deploy

Env knobs:
    WEATHER_RECON_IMAGE  image ref baked into job pods (default weather-recon:0.1.0)
"""

import os

from weather_recon.flow import load_weather_stations

IMAGE = os.environ.get("WEATHER_RECON_IMAGE", "weather-recon:0.1.0")

if __name__ == "__main__":
    deployment_id = load_weather_stations.deploy(
        name="load-weather-stations-k8s",
        work_pool_name="weather-recon-k8s",
        image=IMAGE,
        build=False,   # image is built/loaded out-of-band (see README)
        push=False,
        description="Curated US/CA/MX METAR stations -> Directus weather_stations "
                    "(+ ensures weather_observations / weather_forecasts collections)",
        tags=["weather-recon"],
        parameters={"stations_path": "/app/data/stations.csv"},
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
