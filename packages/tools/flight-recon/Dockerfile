# One image serves both roles: the Prefect worker and the flow-run Jobs it spawns.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

WORKDIR /app

# Deps first (stable layer), pinned to the in-cluster Prefect server version.
RUN pip install \
    "pandas>=2.0" "numpy>=1.26" "matplotlib>=3.8" \
    "prefect==3.7.4" "prefect-kubernetes>=0.5" "httpx>=0.27" "psycopg[binary]>=3.1"

COPY pyproject.toml reconstruct.py ./
COPY flight_recon ./flight_recon
COPY data ./data
RUN pip install --no-deps .

# Flow-run jobs override this; the worker Deployment uses it as-is.
CMD ["prefect", "worker", "start", "--pool", "flight-recon-k8s", "--type", "kubernetes"]
