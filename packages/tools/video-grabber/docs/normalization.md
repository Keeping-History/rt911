# Audio loudness-normalization pipeline

Measures the loudness of every RadioScanner MP3 (`audio/*.mp3` in Wasabi),
produces a reviewable report, and — after an explicit operator go-ahead —
normalizes the files **in place**, archiving the originals first. No Directus
or frontend changes: `mp3_items` URLs are unaffected.

Code lives in [`video_grabber/normalize/`](../video_grabber/normalize/). The
state table is `normalize_jobs` (migration `005`). For the rationale behind
these decisions (why in-place, why archive-first, why a manual review gate),
see [`plans/2026-07-19-audio-normalize-design.md`](../../../../plans/2026-07-19-audio-normalize-design.md).

---

## Flows and triggers

Mirrors the transcribe pipeline's scan → dispatch → per-item shape, but with
an extra split between analysis and the destructive normalize pass.

| Flow | Trigger | What it does |
|---|---|---|
| `scan-normalize` | manual | Enumerates every `audio/*.mp3` key in Wasabi, inserts into `normalize_jobs` with `ON CONFLICT (source_key) DO NOTHING` — idempotent. |
| `dispatch-analyze-normalize` | manual | Atomically claims one `pending` (or retryable failed-in-analysis) job at a time and blocks on `analyze-normalize-item` for it. Drains the whole queue before returning. |
| `analyze-normalize-item` | dispatched (limit 2) | ffprobe + a measurement-only `loudnorm` pass on the raw file. Stores `input_i`/`input_tp`/`input_lra` + `probe`. Within tolerance → `skipped`; otherwise → `analyzed`. |
| `dispatch-normalize` | **manual only — never scheduled** | Atomically claims one `analyzed` (or retryable failed-in-normalize) job at a time and blocks on `normalize-item`. The gap between analysis and triggering this flow **is** the operator review gate — no schedule exists that can start overwriting files on its own. |
| `normalize-item` | dispatched (limit 2) | Archive-first in-place normalization: archive → normalize → upload → purge → `done` (see below). |

---

## Stage machine

```
pending → analyzing → analyzed | skipped → normalizing → done | failed
```

- `analyzing` is set by `analyze-normalize-item` before it does any work, so a
  crash mid-analysis leaves the row visibly stuck rather than silently retried
  as `pending`.
- `skipped` means the file was already within tolerance at analysis time. It
  is terminal and distinct from `done` on purpose: `done` rows already took a
  lossy re-encode and must never take another, but if the tolerance is later
  tightened, only `skipped` rows are re-candidates.
- `normalizing` is set by `normalize-item` before it touches Wasabi.
- `failed` can be reached from either `analyzing` or `normalizing` — see the
  discriminator below for telling them apart.

---

## The failed-row discriminator: `input_i`

Both dispatchers pull from the same `stage = 'failed'` pool, but each must
retry only the jobs that failed in *its own* stage. They tell the difference
using `input_i`, which is only ever written by `analyze-normalize-item`:

- `input_i IS NULL` → failed during analysis (never got a measurement) →
  `dispatch-analyze-normalize` retries it.
- `input_i IS NOT NULL` → failed during normalization (analysis already
  succeeded and wrote a measurement) → `dispatch-normalize` retries it.

Both dispatchers bump `retry_count` on every reclaim and stop retrying once
`retry_count >= max_retries` (default 3).

---

## Archive-first, first-write-wins

`normalize-item`'s order of operations is load-bearing:

1. `copy_object_if_absent` copies `audio/<name>.mp3` → `audio-original/<name>.mp3`
   **only if the archive key doesn't already exist.**
2. Download **from the archive key**, not from `audio/`.
3. Two-pass `dynaudnorm` + EBU R128 `loudnorm` render matching the source's
   encode params.
4. Upload over `audio/<name>.mp3`, preserving the object's prior
   `Cache-Control`.
5. Best-effort Cloudflare purge.

**Why first-write-wins:** on a retry, the `audio/` object may already be the
*normalized* version from a prior attempt that failed after step 4 (e.g. the
purge or the `done` transition). If the archive copy were unconditional, a
retry would re-copy the already-normalized `audio/` bytes over the archive,
permanently destroying the only true original. Refusing to overwrite an
existing archive key — and always downloading and re-normalizing from the
archive, never from `audio/` — makes every crash point safe: after step 1,
the original exists in both places; after that, `audio-original/` always
holds the true original regardless of what `audio/` holds.

---

## Review SQL

Run after `dispatch-analyze-normalize` drains the queue, before triggering
`dispatch-normalize`:

```sql
SELECT stage, count(*), round(avg(input_i),1), min(input_i), max(input_i)
FROM normalize_jobs GROUP BY stage;
```

This is the operator review gate in practice — eyeball the loudness
distribution and the `analyzed` vs `skipped` split before authorizing the
destructive pass.

---

## Operational runbook

1. **Scan:**
   ```python
   from prefect.deployments import run_deployment
   run_deployment(name="scan-normalize/scan-normalize", timeout=0)
   ```
2. **Analyze (non-destructive):**
   ```python
   run_deployment(name="dispatch-analyze-normalize/dispatch-analyze-normalize", timeout=0)
   ```
3. **Review** — run the SQL above. Confirm the `analyzed`/`skipped` split and
   loudness spread look sane before proceeding.
4. **Normalize (destructive, manual go-ahead):**
   ```python
   run_deployment(name="dispatch-normalize/dispatch-normalize", timeout=0)
   ```
5. **Restart the file-proxy cache** once the batch completes — per-file
   purging isn't supported at the nginx-s3-gateway layer, only at Cloudflare:
   ```bash
   kubectl -n file-proxy rollout restart deploy/file-proxy
   ```
6. **Spot-check** a few normalized files by playing them back in the
   RadioScanner app.

---

## Cloudflare purge configuration

`normalize-item` best-effort purges the public URL from Cloudflare's cache
after each in-place overwrite — `audio/` objects carry a long immutable
`Cache-Control`, so without purging, CF (and browsers) may keep serving
pre-normalization bytes indefinitely. Purge failure logs a warning and does
not fail the job; origin bytes are already correct.

Required worker env vars:

| Env var | Meaning |
|---|---|
| `CF_API_TOKEN` | Cloudflare API token with cache-purge permission on the zone |
| `CF_ZONE_ID` | Cloudflare zone ID for `files.911realtime.org` |

If either is unset, purges are skipped with a warning (never a hard failure).

**Delivery:** the worker's Deployment already does `envFrom` the whole
out-of-band `video-grabber-secrets` Secret (see `apps/video-grabber/worker.yaml`
in the infra repo) — no infra YAML change is needed. Add the two keys directly
to that Secret and restart the worker:

```sh
kubectl -n video-grabber patch secret video-grabber-secrets \
  --type merge -p '{"stringData":{"CF_API_TOKEN":"<token>","CF_ZONE_ID":"<zone-id>"}}'
kubectl -n video-grabber rollout restart deploy/video-grabber-worker
```

The token needs only `Zone → Cache Purge → Purge` permission on the
`911realtime.org` zone (create it in the Cloudflare dashboard).

---

## Break-glass restore

There is no dedicated restore flow — this is intentionally break-glass only.
Copies every archived original back over its `audio/` key, then re-purge
Cloudflare and restart the file-proxy deployment. Run inside the worker pod's
python (copied verbatim from `normalize/analysis.py`'s module docstring):

```python
from video_grabber.config import Config
from video_grabber.storage.wasabi import _make_s3_client, list_keys
cfg = Config(); s3 = _make_s3_client(cfg)
for k in list_keys("audio-original/", cfg):
    dest = "audio/" + k.removeprefix("audio-original/")
    s3.copy_object(Bucket=cfg.wasabi_bucket, Key=dest,
                   CopySource={"Bucket": cfg.wasabi_bucket, "Key": k},
                   MetadataDirective="COPY")
```

Then re-purge Cloudflare and `kubectl -n file-proxy rollout restart deploy/file-proxy`.
