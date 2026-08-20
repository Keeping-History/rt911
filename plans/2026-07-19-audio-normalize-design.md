# Audio Normalization Pipeline — Design

**Date:** 2026-07-19
**Status:** Approved (brainstorm complete; implementation plan to follow)
**Package:** `packages/tools/video-grabber` — new `video_grabber/normalize/` module

## Problem

The `audio/` prefix of the Wasabi bucket (served via `files.911realtime.org`) holds
the RadioScanner's MP3 recordings — 25-year-old radio material of highly variable
quality. Loudness varies both file-to-file (one tape transferred hot, another
quiet) and within a single file (different transmissions/speakers at wildly
different levels). We want a Prefect pipeline that measures every file's loudness,
produces a reviewable report, and — after an explicit operator go-ahead —
normalizes the files in place.

## Decisions (from brainstorm)

| Question | Decision |
|---|---|
| Output target | **In place, originals archived** to `audio-original/<name>.mp3` first. No Directus or frontend changes; `mp3_items` URLs keep working. |
| Normalization | **In-file leveling + loudness**: `dynaudnorm` then two-pass EBU R128 `loudnorm` to ≈ −16 LUFS integrated / −1.5 dBTP. |
| Analyze stage | **Analyze all, then normalize.** Measurements stored per-job in Postgres; files within tolerance marked `skipped`; destructive pass is a separate, manually-triggered dispatcher. |
| Re-encode | **Match source params** (sample rate, channels from ffprobe; bitrate `max(source, 128k)` CBR, `libmp3lame`). |

## Architecture

A fourth pipeline in video-grabber, structurally mirroring `transcribe/`:
own Alembic migration + state table, `scan` → `dispatch` → `per-item` flows
registered in `serve.py`, deployed via the existing land-on-main → GitOps path.

### Data model — migration `004_normalize_jobs`

```
normalize_jobs
  id                  UUID PK default gen_random_uuid()
  source_key          TEXT NOT NULL UNIQUE      -- e.g. audio/wnyc-am.mp3
  stage               normalize_stage ENUM      -- see below
  input_i             NUMERIC                   -- integrated loudness, LUFS
  input_tp            NUMERIC                   -- true peak, dBTP
  input_lra           NUMERIC                   -- loudness range, LU
  probe               JSONB                     -- {bitrate, sample_rate, channels, duration}
  archive_key         TEXT                      -- audio-original/<name>.mp3, set post-archive
  error_message       TEXT
  retry_count         INTEGER default 0
  last_transition_at  TIMESTAMPTZ default now()
  created_at          TIMESTAMPTZ default now()
  INDEX idx_normalize_jobs_stage (stage)
```

`normalize_stage`: `pending → analyzing → analyzed | skipped → normalizing → done | failed`.

- `skipped` = already within tolerance; terminal, distinct from `done` so the
  report is honest about what was rewritten. If tolerance is later tightened,
  only `skipped` rows are re-candidates — `done` rows already took a lossy
  generation and must not take another.
- The numeric columns are the reviewable report: one SQL query gives the
  loudness distribution of the whole collection.

### Flows (`video_grabber/normalize/flows.py`, registered in `serve.py`)

| Flow | Trigger | What it does |
|---|---|---|
| `scan-normalize` | manual, serial | `wasabi.list_keys("audio/")` → insert `.mp3` keys as `pending` (`ON CONFLICT DO NOTHING`; rescans idempotent). |
| `dispatch-analyze-normalize` | manual, serial | Drains `pending` via blocking `run_deployment` (transcribe idiom), auto-requeues `failed` under `retry_count < max`. |
| `analyze-normalize-item` | dispatched, limit 2 | Download → ffprobe → measurement-only `loudnorm=print_format=json` pass → store `input_i/tp/lra` + `probe`. Within tolerance → `skipped`, else `analyzed`. |
| `dispatch-normalize` | **manual only — never scheduled** | Drains `analyzed`. The gap between analysis and this trigger *is* the review gate; no schedule exists that can start overwriting files. |
| `normalize-item` | dispatched, limit 2 | Archive → normalize → upload → purge → `done` (see below). |

Concurrency 2 for the per-item flows (mp3 work is cheap next to the video
encodes sharing the pod); scans/dispatchers serial.

### ffmpeg chain (`normalize-item`)

Filter chain: `dynaudnorm,loudnorm` — in-file leveling first, then file-to-file
loudness. Two-pass:

1. **Pass 1 (measure through the chain):**
   `ffmpeg -i in.mp3 -af dynaudnorm,loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null -`
   and parse the trailing JSON block from stderr. The analyze flow's stored
   measurement **cannot** be reused here: `dynaudnorm` changes loudness before
   `loudnorm` sees it, so pass-2 `measured_*` values must be taken through the
   same filter chain.
2. **Pass 2 (render):** same chain with `measured_I/measured_TP/measured_LRA/
   measured_thresh/offset` filled in and `linear=true` (one constant gain, no
   second layer of dynamic compression), encoded `libmp3lame`, source sample
   rate + channels from `probe`, bitrate `max(source_bitrate, 128k)` CBR.

Tunables are `Config` fields, not literals: `NORM_TARGET_I=-16`,
`NORM_TARGET_TP=-1.5`, `NORM_TOLERANCE_LU=1.0`. `dynaudnorm` starts at
defaults; tune `f`/`g` via the same seam if it pumps on scanner audio.

Skip rule (analyze stage): `|input_i − NORM_TARGET_I| ≤ NORM_TOLERANCE_LU`
**and** `input_tp ≤ NORM_TARGET_TP`.

### Archival, upload, caching (per-file order of operations)

1. **Archive first:** server-side `copy_object` `audio/<name>.mp3` →
   `audio-original/<name>.mp3`. **First write wins, forever** — if the archive
   key already exists (retry/re-run), do not overwrite it: the `audio/` object
   may already be normalized and clobbering the archive would destroy the only
   true original. This makes every crash point safe: either the original exists
   in both places, or it's archived and `audio/` holds original-or-normalized.
2. Download, normalize (two-pass above), upload over `audio/<name>.mp3` with
   explicit `ContentType: audio/mpeg`, preserving the object's prior
   `Cache-Control`.
3. **Cloudflare purge, best-effort:** POST the public URL to CF's purge API.
   New worker env `CF_API_TOKEN` / `CF_ZONE_ID` (Secret in the infra repo).
   Purge failure logs a warning but does not fail the job — origin bytes are
   correct. The `audio/` objects carry a long immutable `Cache-Control`, so
   without purging, CF and browsers may serve stale bytes indefinitely.
4. Mark `done`.

**nginx-s3-gateway (`file-proxy`) cache:** per-file purging isn't supported
there; the runbook step is a one-time `kubectl rollout restart` of the
file-proxy deployment after the batch completes.

**Rollback:** the `audio-original/` prefix. A documented boto3 snippet (module
docstring + this doc) copies `audio-original/*` back over `audio/*` and
re-purges. No dedicated restore flow — break-glass only.

```python
# Break-glass restore (run in the worker pod's python):
from video_grabber.config import Config
from video_grabber.storage.wasabi import _make_s3_client, list_keys
cfg = Config(); s3 = _make_s3_client(cfg)
for k in list_keys("audio-original/", cfg):
    dest = "audio/" + k.removeprefix("audio-original/")
    s3.copy_object(Bucket=cfg.wasabi_bucket, Key=dest,
                   CopySource={"Bucket": cfg.wasabi_bucket, "Key": k},
                   MetadataDirective="COPY")
# then re-purge Cloudflare + rollout-restart file-proxy
```

### Interactions with existing pipelines

- **transcribe:** keys don't change, so existing `transcribe_jobs` rows are
  untouched; nothing re-transcribes. (Normalized audio might transcribe better,
  but re-transcription is explicitly out of scope.)
- **mp3_items / streamer / frontend:** URLs unchanged; zero changes needed.
- `.mp3` gets an explicit `ContentType` at upload; `storage/wasabi.py`'s
  suffix table isn't touched (uploads here use `put_object`/`upload_file`
  with explicit args).

## Testing

- `test_normalize_decisions.py` — skip-tolerance edges (±1 LU, TP boundary),
  encode-param mapping (128k floor, mono/stereo passthrough), `audio/` →
  `audio-original/` key mapping.
- `test_loudnorm_parse.py` — extracting the trailing JSON block from realistic
  ffmpeg stderr (mixed with progress noise; the most fragile piece).
- Flow tests mock boto3 + subprocess per existing pipeline tests; migration
  `004` rides the live-Postgres `test_migrations.py` pattern.
- CI automatic via path-filtered `build-video-grabber.yml` (pytest + ruff gate
  the image build); ship via land-on-main → GitOps roll.

## Operational runbook (happy path)

1. Land on `main`; wait for image + GitOps roll (per video-grabber CLAUDE.md).
2. Bump the migrate Job in infra (`alembic upgrade head` → `004`).
3. Add `CF_API_TOKEN`/`CF_ZONE_ID` Secret + env to the worker in infra.
4. Trigger `scan-normalize`, then `dispatch-analyze-normalize` (Prefect UI).
5. Review: `SELECT stage, count(*), round(avg(input_i),1), min(input_i), max(input_i) FROM normalize_jobs GROUP BY stage;`
6. When satisfied, trigger `dispatch-normalize`.
7. After the batch: `kubectl -n file-proxy rollout restart deploy/file-proxy`.
8. Spot-check a few URLs in the RadioScanner.

## Out of scope

- Re-transcribing normalized audio.
- Directus schema/URL changes.
- A restore flow (documented snippet only).
- Automatic scheduling of the destructive pass.
