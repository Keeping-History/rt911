# Deployment

All Kubernetes manifests live under [`k8s/`](../k8s). They target the `video-grabber` namespace and are designed for ArgoCD-style GitOps deployment against the `dev.keepinghistory.org` cluster, but they will apply against any cluster with the named secrets present.

## Execution model

The pipeline uses Prefect's **`serve()` model**, not a Kubernetes work pool. The single worker pod is the long-lived process that registers the flow deployments with the Prefect server and executes runs in-process. Reasons:

- The worker pod already has the 50 GiB `emptyDir` scratch mounted — moving to per-run Job pods would force every flow run to its own (smaller) ephemeral storage and require PVC plumbing in the base job template.
- ffmpeg is a single-process tool; running it next to the orchestrator inside the same pod is fine and simpler.
- `serve()` deployments don't need a work pool at all, eliminating the "wrong pool type" failure mode (see [runbook.md](./runbook.md)).

The entrypoint is [`video_grabber/serve.py`](../video_grabber/serve.py):

```python
serve(
    process_item_flow.to_deployment(name="process-item"),
    scan_collections_flow.to_deployment(name="scan-collections"),
)
```

This is idempotent — every pod restart re-registers the same two deployments, and Prefect deduplicates by name.

## Container image

[`Dockerfile`](../Dockerfile) — `python:3.12-slim`, installs `ffmpeg` and `ca-certificates`, `pip install -e .` against the package, then runs the serve entrypoint:

```dockerfile
CMD ["python", "-m", "video_grabber.serve"]
```

Build and publish (CI publishes to `ghcr.io/keeping-history/video-grabber:latest`):

```bash
cd packages/tools/video-grabber
docker build -t ghcr.io/keeping-history/video-grabber:latest .
docker push ghcr.io/keeping-history/video-grabber:latest
```

The worker deployment ([`k8s/worker-deployment.yaml`](../k8s/worker-deployment.yaml)) pulls this tag with no digest pinning — restarting a pod is enough to pick up a fresh image.

## Manifests

| File | What it creates |
| --- | --- |
| `namespace.yaml` | `video-grabber` namespace. |
| `rbac.yaml` | `video-grabber-worker` ServiceAccount, namespaced Role for `batch/jobs` + `pods`/`pods/log`, and a `ClusterRole` granting `namespaces:list` (to suppress a 403 noise log on worker boot). |
| `prefect-server-deployment.yaml` | Single-replica `prefect-server` Deployment + ClusterIP Service on port 4200. Uses the official `prefecthq/prefect:3-latest` image. |
| `worker-deployment.yaml` | `video-grabber-worker` Deployment (1 replica, 2–4 CPU, 4–8 GiB RAM, 50 GiB `emptyDir` scratch). Pulls `envFrom` a ConfigMap + Secret. ConfigMap is defined inline. |
| `ingress-prefect-ui.yaml` | Traefik Ingress exposing the Prefect UI at `prefect-ui.dev.keepinghistory.org` behind a BasicAuth middleware (`video-grabber-prefect-auth@kubernetescrd`) and cert-manager-issued TLS. |
| `db-init-job.yaml` | One-shot Job that runs as an ArgoCD `PreSync` hook to create the `video_grabber` and `prefect` databases on the shared Postgres. |

## Required external resources

Things the manifests assume exist and reference by name:

- **Secret `video-grabber-secrets`** in the `video-grabber` namespace, with at minimum:
  - `DATABASE_URL` — Postgres URL for the pipeline database.
  - `WASABI_ACCESS_KEY_ID`, `WASABI_SECRET_ACCESS_KEY`.
  - `DIRECTUS_API_TOKEN` — static token, not session-issued.
  - `PREFECT_API_DATABASE_CONNECTION_URL` — Postgres URL for the Prefect server's own state DB (must be a different database from the pipeline's).
- **Secret `postgres-secrets`** (consumed by `db-init-job.yaml`) with `DATABASE_URL` pointing at a Postgres role that can `CREATE DATABASE`.
- **Traefik Middleware** `video-grabber-prefect-auth` (not in this manifest set) — BasicAuth secret for the Prefect UI. Created out-of-band by the same path used for the `time-machine` namespace's bullboard ingress.
- **No work pool needed.** `serve()` registers deployments directly against the API. If a stale `video-grabber-pool` exists from an earlier iteration of this deployment, you can leave it (harmless) or delete it:
  ```bash
  kubectl exec -it -n video-grabber deploy/video-grabber-worker -- \
    prefect work-pool delete video-grabber-pool
  ```

## The ConfigMap

Defined inline in `worker-deployment.yaml`:

```yaml
PREFECT_API_URL: "http://prefect-server.video-grabber.svc.cluster.local:4200/api"
WASABI_ENDPOINT_URL: "https://s3.us-central-1.wasabisys.com"
WASABI_BUCKET: "files.911realtime.org"
DIRECTUS_URL: "http://directus.rt911.svc.cluster.local:8055"
IA_RATE_PER_SEC: "2"
MIN_DURATION_SECONDS: "720"
SCRATCH_DIR: "/tmp/vg-scratch"
```

Note that `DIRECTUS_URL` crosses namespaces — it points at the Directus service in `rt911`. The `directus` Service in that namespace must accept traffic from the `video-grabber` namespace (no NetworkPolicy blocks).

## ArgoCD application sync order

1. `namespace.yaml` (no hook, ordinary sync).
2. `db-init-job.yaml` runs as a `PreSync` hook (`argocd.argoproj.io/hook: PreSync`) and is replaced on every sync (`hook-delete-policy: BeforeHookCreation`). It is idempotent — both `CREATE DATABASE` statements use `|| true`.
3. `rbac.yaml`, `prefect-server-deployment.yaml`, then the worker once Prefect is ready.

Database schema migrations are **not** in the manifests today. Alembic must be run manually (`alembic upgrade head` from a pod with `DATABASE_URL` set) after the first deploy and after any schema-changing PR. See [data-model.md](./data-model.md) for the current revision.

## Local "deployment" (development)

Skip Kubernetes entirely for development:

```bash
# Terminal 1 — Prefect server
prefect server start

# Terminal 2 — serve the flows
export PREFECT_API_URL=http://localhost:4200/api
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/video_grabber
# … plus Wasabi/Directus from .env
python -m video_grabber.serve
```

`serve()` blocks the terminal and polls the API for scheduled runs. Trigger one from the Prefect UI at `http://localhost:4200` (Deployments → `process-item` → Run → Custom run, fill in `job_id`), or from the CLI:

```bash
prefect deployment run "process-item/process-item" --param 'job_id="<uuid>"'
prefect deployment run "scan-collections/scan-collections"
```

## Resource sizing notes

- **CPU**: ffmpeg with `-preset slow` is single-threaded per encode but we run three sequentially. Two cores at request, four at limit gives headroom for the OS, httpx, and boto3's parallel upload threads.
- **Memory**: 4 GiB request comfortably covers a 90-minute source plus the three ffmpeg processes. 8 GiB limit is conservative.
- **Scratch volume**: 50 GiB `emptyDir` is enough for one item at a time (source can be 4–8 GiB, encoded HLS ~1–2 GiB). Nothing cleans up between items — see the runbook for manual scratch eviction.
