# Architecture

video-grabber is a six-stage Prefect pipeline that turns raw Internet Archive broadcast items into HLS streams served from Wasabi and surfaced through Directus. State lives in Postgres; orchestration lives in Prefect; binary work (download, transcode, upload) runs inside Kubernetes pods that the Prefect worker schedules on demand.

## High-level dataflow

```
┌────────────────────┐
│ Internet Archive   │  collection: sept_11_tv_archive, 911
│ (metadata + files) │
└─────────┬──────────┘
          │ scan-collections flow (rate-limited search)
          ▼
┌────────────────────┐      ┌────────────────────────────┐
│ video_jobs (PG)    │◄────►│ pipeline_transitions (PG)  │ ◄── audit log
│ stage: discovered  │      └────────────────────────────┘
└─────────┬──────────┘
          │ process-item flow (one row per IA identifier)
          ▼
   downloading ─► downloaded ─► encoding ─► encoded ─► uploading ─► complete
          │
          └─► failed   (any stage)
                  │
                  └─► pending_review  (unrecognized channel; needs human triage)

complete ─► writes Directus media_items row ─► Wasabi-hosted master.m3u8

EPG assembler  (separate flow, runs daily)
   schedule_slots + channels ─► per-channel day-playlist + EPG JSON
```

## Component map

| Module | Responsibility | Talks to |
| --- | --- | --- |
| `ia/scanner.py` | Recursively crawl IA collections, upsert candidate `video_jobs`. | Internet Archive (`internetarchive` SDK), Postgres |
| `ia/metadata.py` | Parse air dates and timezones from title/description. | — (pure) |
| `ia/channel_map.py` | Normalize an IA item to a canonical channel slug. | — (pure) |
| `pipeline/flows.py` | Prefect flow definitions, stage transitions, error capture. | Postgres, all worker modules |
| `pipeline/downloader.py` | Pick the best source file, resumable byte-range download. | Internet Archive HTTP API |
| `video/encoder.py` | 3-rendition ABR HLS via ffmpeg/ffprobe. | local ffmpeg/ffprobe |
| `video/gap_filler.py` | Blue (`#0000f5`) silent fMP4 segments matching encoder rungs. | local ffmpeg |
| `storage/wasabi.py` | Upload HLS package with the right `Content-Type` and `Cache-Control`. | Wasabi S3 |
| `directus/writer.py` | Idempotent `POST /items/media_items`, channel→source resolution. | Directus HTTP API |
| `epg/assembler.py` | Build per-channel 24-hour master + rendition playlists with gap inserts. | Postgres |
| `db/migrations/` | Alembic schema; `001_initial_schema` defines all tables and the stage enum. | Postgres |

Everything outside `epg/` is on the IA → Wasabi → Directus path. `epg/` is the read path that the frontend consumes.

## Boundaries and why

**Internet Archive is treated as untrusted input.** Items can have unparseable lengths, unknown networks, or missing dates. The scanner is permissive (anything ≥12 minutes proceeds); unrecognized channels land in `pending_review` rather than being dropped (`ia/scanner.py:25-46`). The metadata parser has multiple regex strategies and falls back to EDT when no timezone is named (`ia/metadata.py:30-32`).

**Stage transitions are atomic in DB.** `transition_job()` does `UPDATE video_jobs` + `INSERT pipeline_transitions` in the same SQLAlchemy connection and commits both together (`pipeline/flows.py:46-84`). The audit table is the canonical "what happened to this job" log; the `stage` column on `video_jobs` is just a cached current state.

**Workers are stateless past `/tmp/vg-scratch`.** Each `process_item_flow` run reconstructs everything it needs from the DB row and the IA identifier. The 50Gi `emptyDir` is throwaway. If a worker pod dies mid-encode, the next attempt re-downloads from scratch (the resumable download in `downloader.py` covers in-process resume, not cross-pod resume).

**Directus is the public catalog; Postgres is the pipeline log.** The pipeline never reads from Directus — it only writes one record per successful job into `media_items` with the Wasabi URL. If Directus is unavailable, the job sits in `uploading`/`complete` and the writer retries on the next flow run (the idempotency check makes this safe — `directus/writer.py:31-39`).

**EPG assembly is decoupled from pipeline.** It reads `schedule_slots` and writes flat playlist files. It never modifies job state and can be rerun freely.

## Why six stages

The granularity exists so a flaky network or a corrupt source file fails at the cheapest possible step. Splitting `downloading`/`downloaded`/`encoding`/`encoded`/`uploading` lets the operator pick the right retry point: re-run encode without re-downloading 4 GB, or re-run upload without re-encoding 60 minutes of footage. The audit log in `pipeline_transitions` makes "where did this job get stuck" answerable in one query.

## What lives outside this package

- **The Prefect server itself** runs as a separate Deployment (`k8s/prefect-server-deployment.yaml`). It owns its own Postgres database (`prefect`); the pipeline owns `video_grabber`.
- **The Directus instance** runs in the `rt911` namespace. video-grabber only consumes its HTTP API.
- **Wasabi** is the long-term storage tier. Bucket `files.911realtime.org`, region `us-central-1`.
- **The frontend** (`packages/frontend`) consumes the EPG JSON and `master.m3u8` URLs published by this package, but it has no knowledge of `video_jobs`.
