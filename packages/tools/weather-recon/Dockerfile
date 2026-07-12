# One image serves both roles: the Prefect worker and the flow-run Jobs it spawns.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

WORKDIR /app

# Deps first (stable layer), pinned to the in-cluster Prefect server version.
RUN pip install "prefect==3.7.4" "prefect-kubernetes>=0.5" "httpx>=0.27" "boto3>=1.34"

COPY pyproject.toml ./
COPY weather_recon ./weather_recon
COPY data/stations.csv ./data/stations.csv
RUN pip install --no-deps .

# Flow-run jobs override this; the worker Deployment uses it as-is.
CMD ["prefect", "worker", "start", "--pool", "weather-recon-k8s", "--type", "kubernetes"]
