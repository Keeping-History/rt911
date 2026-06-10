# Runbook

Operational playbook for the common things that go wrong. Assumes you have `kubectl` access to the `video-grabber` namespace and `psql` access to the pipeline database.

## Where things live

- **Prefect UI** — `https://prefect-ui.dev.keepinghistory.org` (BasicAuth).
- **Worker logs** — `kubectl logs -n video-grabber deploy/video-grabber-worker -f`.
- **Pipeline DB** — `video_grabber` database on the shared Postgres referenced by `video-grabber-secrets/DATABASE_URL`.
- **Scratch volume** — inside the worker pod at `/tmp/vg-scratch`.

## Flows don't appear in the Prefect UI

Symptom: Prefect UI shows the worker connected but the Deployments tab is empty, or the deployments you expected aren't there.

Almost always one of:

1. **The worker container is running `prefect worker start` instead of `python -m video_grabber.serve`.** Check the running command:
   ```bash
   kubectl describe pod -n video-grabber -l app=video-grabber-worker | grep -A2 Command
   ```
   If you see `prefect worker start`, the image is stale. Rebuild + push the image (Dockerfile `CMD` should be `["python", "-m", "video_grabber.serve"]`) and `kubectl rollout restart deploy/video-grabber-worker -n video-grabber`.

2. **A stale `video-grabber-pool` of type `process` exists from an earlier setup.** This package no longer uses a work pool — `serve()` registers deployments directly. If you see the pool in `prefect work-pool ls` you can delete it:
   ```bash
   kubectl exec -it -n video-grabber deploy/video-grabber-worker -- \
     prefect work-pool delete video-grabber-pool
   ```
   Don't try to "fix" the pool's type — `serve()` doesn't read from it.

3. **`PREFECT_API_URL` is wrong or unreachable.** The ConfigMap value is `http://prefect-server.video-grabber.svc.cluster.local:4200/api`. Test from the worker:
   ```bash
   kubectl exec -n video-grabber deploy/video-grabber-worker -- \
     curl -sf "$PREFECT_API_URL/health"
   ```
   Anything but `true` means the worker can't talk to the server.

Historical context: an earlier iteration of this deployment tried to use a Kubernetes-typed work pool with `flow.deploy(image=...)`. That blows up with `ValueError: Work pool 'video-grabber-pool' does not support custom Docker images` because the pool was auto-created as `process` type when the worker first connected. The current design sidesteps the whole work-pool model by using `serve()` instead. See [deployment.md](./deployment.md#execution-model) for the reasoning.

## Rescan a collection

Idempotent. Run from the Prefect UI:

1. Trigger `scan-collections` with no parameters → uses defaults `["sept_11_tv_archive", "911"]`.
2. Or pass a custom list:
   ```python
   scan_collections_flow(collections=["another_ia_collection"])
   ```

New items are upserted with `ON CONFLICT DO NOTHING`. Existing rows are unchanged. Recognized-channel items land at `discovered`; unknown-channel items land at `pending_review`.

## Promote a `pending_review` item

You've decided the channel for an item is, say, `cnn`. There is no admin UI today — fix it directly in SQL:

```sql
UPDATE video_jobs
SET stage = 'discovered',
    channel_id = (SELECT id FROM channels WHERE slug = 'cnn'),
    last_transition_at = now()
WHERE id = '<job-uuid>';

INSERT INTO pipeline_transitions (job_id, from_stage, to_stage, worker_id)
VALUES ('<job-uuid>', 'pending_review', 'discovered', 'manual-review');
```

Then trigger `process_item_flow(job_id='<job-uuid>')` from the Prefect UI.

The downstream `directus/writer.py` checks `job.passed_through_review` to decide `approved=0` vs `approved=1`. That flag is **not** on the table today — if you want reviewed items to land in Directus as `approved=0` (i.e. needing human validation), set the flag on whatever in-memory job object the flow builds. The current code reads `job.passed_through_review` directly from the DB row, so plumbing it requires a schema column. Track this as a known gap.

## Retry a failed job

Find failed jobs:

```sql
SELECT id, ia_identifier, error_message, last_transition_at
FROM video_jobs
WHERE stage = 'failed'
ORDER BY last_transition_at DESC;
```

Decide whether the failure is transient (IA timeout, Wasabi 503, Directus 5xx) or permanent (`select_best_file` raised "no suitable file found"). For transient failures:

```sql
UPDATE video_jobs
SET stage = 'discovered',
    error_message = NULL,
    last_transition_at = now()
WHERE id = '<job-uuid>';
```

Then trigger `process_item_flow(job_id='<job-uuid>')`. The audit log retains the original failure row, so the history isn't lost.

For permanent failures, leave the job at `stage='failed'` (or move it back to `pending_review` for human notes). Don't keep retrying something that's never going to succeed.

## Job is stuck mid-pipeline

If a worker pod died mid-encode, the job will sit at `stage='encoding'` or wherever it was. The next Prefect run for that job restarts from the beginning of `process_item_flow`; the resumable downloader picks up where the previous attempt left off (per-pod, not cross-pod — see caveat below).

```sql
SELECT id, ia_identifier, stage, last_transition_at, error_message
FROM video_jobs
WHERE stage NOT IN ('complete', 'pending_review')
  AND last_transition_at < now() - interval '30 minutes'
ORDER BY last_transition_at;
```

To force a fresh restart from `discovered`:

```sql
UPDATE video_jobs
SET stage = 'discovered', error_message = NULL, last_transition_at = now()
WHERE id = '<job-uuid>';
```

The byte-range resume in `downloader.py` only works if the partial file is still on `/tmp/vg-scratch` — once the pod restarts, the `emptyDir` is gone and the next attempt re-downloads from offset 0.

## Scratch volume is full

```bash
kubectl exec -n video-grabber deploy/video-grabber-worker -- df -h /tmp/vg-scratch
```

The pipeline doesn't clean up automatically. Either restart the pod (loses any in-flight resume state but reclaims the whole volume) or clean selectively:

```bash
# remove everything for completed jobs
kubectl exec -n video-grabber deploy/video-grabber-worker -- \
  sh -c 'cd /tmp/vg-scratch && ls -d */ | xargs -I {} sh -c "test -d {} && echo {}"'
# then rm -rf the IA identifiers you've confirmed are at stage='complete' in the DB
```

If this becomes a frequent problem, the right fix is to add a cleanup step at the end of `process_item_flow` after `transition_job(...complete...)`.

## Wasabi upload returns 400

Most likely cause: boto3 was upgraded past 1.36 and the checksum-header workaround in [`storage/wasabi.py`](../video_grabber/storage/wasabi.py) regressed. Look at the response body for `InvalidArgument` mentioning `x-amz-checksum-*`. The fix is in `_make_s3_client`:

```python
request_checksum_calculation="when_required",
response_checksum_validation="when_required",
```

Both must be present. If either is missing or set to `when_supported`, Wasabi rejects the upload.

## Directus write returns 401

The static API token in `video-grabber-secrets/DIRECTUS_API_TOKEN` was rotated or revoked. Generate a new static token in Directus (Settings → Access Tokens → static), update the Secret, and restart the worker:

```bash
kubectl rollout restart deploy/video-grabber-worker -n video-grabber
```

If you see intermittent 401s rather than uniform 401s, somebody set `DIRECTUS_API_TOKEN` to a session token. Get a static one — see [configuration.md](./configuration.md) for why.

## Playlist plays for 5 seconds then stalls

Symptom: `master.m3u8` loads, video starts, freezes after the first segment.

Likely cause: a gap segment referenced in the playlist isn't actually on Wasabi. The assembler emits `seg_gap_<remainder>s.m4s` for fractional-duration gaps; if `gap_filler.py` only pre-generated a 6-second gap, any 1–5 second remainder reference 404s.

Check the playlist for `seg_gap_*` and verify those keys exist:

```bash
aws s3 ls s3://files.911realtime.org/hls/cnn/20010911/_gap/full/ \
  --endpoint-url https://s3.us-central-1.wasabisys.com
```

Regenerate the missing durations with `gap_filler.generate_gap_fmp4()` and re-upload.

## Frontend isn't seeing a new program

The Wasabi upload succeeded but Directus doesn't have the row.

```sql
SELECT stage, wasabi_key, error_message FROM video_jobs WHERE ia_identifier = '...';
```

If `stage = 'complete'` and `wasabi_key` is set, look at worker logs from the `complete` transition window — Directus may have returned a non-2xx that wasn't surfaced as an exception. The writer is idempotent, so it's safe to call `write_media_item(job, wasabi_key, cfg)` again from a Python shell inside the worker:

```python
from video_grabber.directus.writer import write_media_item
from video_grabber.config import Config
# … reconstruct job from DB row …
write_media_item(job, job.wasabi_key, Config())
```

## Database migration needed

Schema migrations run automatically on every ArgoCD sync via the `db-migrate` Job ([`k8s/migrate-job.yaml`](../k8s/migrate-job.yaml)) — a PreSync hook at sync-wave 1 (after `db-init`). To ship a new revision:

1. `cd packages/tools/video-grabber`
2. Author a new revision under `video_grabber/db/migrations/versions/`. Hand-write the migration — `target_metadata` is `None`, so autogeneration is not wired up.
3. Open a PR with the new revision file. On merge:
   - CI rebuilds the image (migration code ships in `/app/video_grabber/db/migrations/`).
   - ArgoCD Image Updater bumps the SHA in the infra repo.
   - The next ArgoCD sync triggers the `db-migrate` PreSync hook, which runs `alembic -c /app/alembic.ini upgrade head` against the live database.
   - The worker then rolls out with the schema already at the new HEAD.

To run migrations out of band (debugging, or against an unmanaged environment):

```bash
kubectl exec -n video-grabber deploy/video-grabber-worker -- \
  alembic -c /app/alembic.ini upgrade head
```

Or from a developer laptop with `DATABASE_URL` port-forwarded:

```bash
cd packages/tools/video-grabber
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/video_grabber \
  alembic upgrade head
```

`env.py` rewrites the `postgresql+asyncpg://` scheme to `postgresql+psycopg2://` automatically, so the same Secret can be reused without modification.
