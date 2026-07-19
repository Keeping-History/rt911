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
- `video_grabber/usenet/` — a **second, independent pipeline**: ingest Usenet newsgroup
  archives from IA, thread them with usenetarchive (C++), write to Directus. Own state
  table (`usenet_jobs`, migration `002`) and Prefect flows (`scan-usenet`/`process-usenet-item`/
  `dispatch-usenet`). See [`docs/usenet-ingestion.md`](docs/usenet-ingestion.md) — read it before
  touching the threading pipeline; it documents the required usenetarchive build sequence and the
  non-obvious gotchas (compressed-input, exit codes, packed msgids, OOM, NUL bytes, payload size).
- `video_grabber/transcribe/` — a **third pipeline**: transcribe encoded TV programs +
  radio MP3s with whisper.cpp (Vulkan/iGPU) into per-channel and per-MP3 SRT/VTT,
  register in Directus (`subtitles` column). Own state table (`transcribe_jobs`,
  migration `003`) and flows (`scan-transcribe`/`transcribe-item`/`dispatch-transcribe`/
  `build-channel-subtitles`). See [`docs/transcription.md`](docs/transcription.md).
- `video_grabber/normalize/` — a **fourth pipeline**: measure loudness of every
  `audio/*.mp3` (report in `normalize_jobs`, migration `005`), then — via the
  manually-triggered `dispatch-normalize` only — normalize files in place
  (dynaudnorm + two-pass EBU R128 loudnorm), archiving originals to
  `audio-original/` first (first-write-wins). See [`docs/normalization.md`](docs/normalization.md).
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
3. **GitOps rolls the worker — do NOT `kubectl set image`.** The cluster runs ArgoCD with
   `automated.selfHeal: true`, so any imperative change to the live Deployment is reverted
   within seconds. The app (`kubectl -n argocd get application video-grabber`) syncs from a
   **separate repo**: `github.com/Keeping-History/infra`, path `apps/video-grabber`, branch
   `main` (cloned locally at `/home/robbiebyrd/infra`). The deployed image SHA is pinned by a
   kustomize override in `apps/video-grabber/.argocd-source-video-grabber.yaml`
   (the `worker.yaml`/`kustomization.yaml` `newTag` is just `latest` and is overridden by it).
   Infra-side automation watches GHCR and commits the SHA bump there — the
   `build: automatic update of video-grabber` commits — after which ArgoCD auto-syncs and
   rolls the worker. So normally **just landing on `main` and waiting ~a few minutes** ships it.
   To force/expedite, edit the SHA in `.argocd-source-video-grabber.yaml`, commit + push to
   infra `main` (self-merge is fine), then let auto-sync run (or trigger a refresh).
4. **Verify:**
   ```sh
   kubectl -n argocd get application video-grabber -o jsonpath='{.status.sync.status} {.status.health.status}{"\n"}'
   kubectl -n video-grabber get deploy video-grabber-worker \
     -o jsonpath='{.spec.template.spec.containers[0].image}'   # should be the new SHA
   ```
5. **Schema changes only:** bump the migrate Job (`apps/video-grabber/migrate-job.yaml`,
   runs `alembic upgrade head`) in the infra repo as well; it deploys via the same ArgoCD app.

The k3s cluster is **local to the dev host** — `kubectl` works directly (the
`open /etc/rancher/k3s/config.yaml: permission denied` warnings are harmless and can
be ignored). Namespace is `video-grabber`. Prefect server + worker run there;
`prefect-server` is reachable in-cluster at
`http://prefect-server.video-grabber.svc.cluster.local:4200/api`. The worker runs on the
`encode-1` node (Ryzen iGPU) and the pipeline executes in-pod via a Prefect runner — there
is no work pool, so `--job-variable image` does nothing; the image comes from GitOps only.

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
