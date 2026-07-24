# One image serves both roles: the Prefect worker and the flow-run Jobs it spawns.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

WORKDIR /app

# Deps first (stable layer), pinned to the in-cluster Prefect server version.
RUN pip install \
    "prefect==3.7.4" "prefect-kubernetes>=0.5"

COPY pyproject.toml build_2001.py ./
COPY building_recon ./building_recon
COPY data ./data
RUN pip install --no-deps .

# Flow-run jobs override this; the worker Deployment uses it as-is.
CMD ["prefect", "worker", "start", "--pool", "building-recon-k8s", "--type", "kubernetes"]
