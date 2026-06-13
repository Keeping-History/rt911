# video-grabber

Prefect pipeline that pulls 9/11 broadcast footage from the Internet Archive,
encodes it to ABR fMP4/CMAF HLS, uploads to Wasabi, and registers it in Directus.
Also stitches per-channel continuous HLS streams + EPG guide JSON.

## Layout

- `video_grabber/pipeline/` — the per-item flow (`flows.py`), `downloader.py`,
  `resolve.py` (derive channel/program from IA metadata).
- `video_grabber/video/` — `encoder.py` (libx264 + h264_vaapi paths), `gap_filler.py`.
- `video_grabber/epg/` — `assembler.py`, `scheduler.py` (channel stitching).
- `video_grabber/{storage,directus,ia,db}/` — Wasabi S3, Directus writer, IA scan, migrations.
- `k8s/` — deployment manifests (see Deploy below).
- `tests/` — pytest. `test_migrations.py` needs a live Postgres; it **errors** (not
  fails) when none is reachable — that's an environment gap, not a regression.

## Build & deploy workflow

**This is the canonical way to ship a code change to the live worker.** Images are
tagged by git commit SHA; the running worker pins a specific SHA, so deploying =
landing code on `main` (CI builds the image) then rolling the Deployment to the new tag.

1. **Land on `main`.** CI (`.github/workflows/build-video-grabber.yml`) triggers on
   push/PR touching `packages/tools/video-grabber/**`:
   - `test` job: spins a `postgres:16` service, `pip install -e ".[dev]"`,
     `pytest tests/ -v`, then `ruff check video_grabber/ tests/`. Run both locally
     first (`pytest`, `ruff check`) — a ruff failure blocks the build.
   - `build` job: **only runs on non-PR events** (`if: github.event_name != 'pull_request'`),
     so a PR validates but does **not** produce an image. The image is built and pushed
     only once the commit is on `main`. Tags: `ghcr.io/keeping-history/video-grabber:<sha>`
     and `:latest`.
2. **Wait for the image.** Watch the run with `gh run watch` / `gh run list`. The image
   tag is the full commit SHA (`git rev-parse HEAD`).
3. **Roll the worker** to the new SHA (do NOT use `--job-variable image`; the pipeline
   runs in the worker pod via an in-pod Prefect runner, no work pool):
   ```sh
   SHA=$(git rev-parse HEAD)
   kubectl -n video-grabber set image deploy/video-grabber-worker \
     worker=ghcr.io/keeping-history/video-grabber:$SHA
   kubectl -n video-grabber rollout status deploy/video-grabber-worker
   ```
4. **Schema changes only:** also update + run the migrate Job
   (`k8s/migrate-job.yaml`, runs `alembic upgrade head`) before rolling the worker.

The k3s cluster is **local to the dev host** — `kubectl` works directly (the
`open /etc/rancher/k3s/config.yaml: permission denied` warnings are harmless and can
be ignored). Namespace is `video-grabber`. Prefect server + worker run there;
`prefect-server` is reachable in-cluster at
`http://prefect-server.video-grabber.svc.cluster.local:4200/api`.

## Operating the pipeline

- **Dispatch work:** the `dispatch-discovered` flow drains the queue one job at a time
  (blocking `run_deployment`). It dispatches fresh `stage='discovered'` jobs first, then
  auto-requeues `stage='failed'` jobs with `retry_count < max_retries` (default 3),
  bumping `retry_count` each time so a permanently-broken source stops after N tries.
  **A failed job is automatically retried on the next full run** — no manual re-trigger.
- **Inspect run state:** query the Prefect API from inside the worker pod, which already
  has `PREFECT_API_URL` set:
  `kubectl -n video-grabber exec -i deploy/video-grabber-worker -- python - < script.py`.
  Prefect's flow-run history and the DB diverge — `video_jobs.stage` is the source of
  truth for what still needs work (failed runs that were retried show as `complete` there).
- **Encoding:** `h264_vaapi` hardware path activates when `VAAPI_DEVICE` (e.g.
  `/dev/dri/renderD128`) is set on a host with an AMD/Intel iGPU (encode-1 node, ~26×
  realtime); otherwise falls back to libx264 `preset slow` (~2.4×).
