# Pipeline stages

The pipeline is implemented as Prefect flows in [`video_grabber/pipeline/flows.py`](../video_grabber/pipeline/flows.py). All stage names are values of the Postgres `pipeline_stage` enum defined in migration `001` ([`video_grabber/db/migrations/versions/001_initial_schema.py:22-28`](../video_grabber/db/migrations/versions/001_initial_schema.py)).

## The state machine

```
              ┌─► pending_review ─(human triage)─┐
              │                                  │
discovered ─► metadata_extracted ─► downloading ─► downloaded ─►
   encoding ─► encoded ─► uploading ─► complete

      (any) ─► failed
```

| Stage | Set by | Means |
| --- | --- | --- |
| `discovered` | `scan_collections_flow` | Row inserted from an IA item that passed the candidate filter and has a known channel. |
| `pending_review` | `scan_collections_flow` | Same as `discovered`, but channel could not be normalized. Held until a human classifies it. |
| `metadata_extracted` | (currently inlined; reserved for future air-date/duration extraction stage) | Air date, channel, and duration written to `programs`. |
| `downloading` | `process_item_flow` | Worker is fetching source bytes from IA into `/tmp/vg-scratch/<id>/`. |
| `downloaded` | `process_item_flow` | Source file is on disk. |
| `encoding` | `process_item_flow` | ffmpeg is running the three rendition jobs. |
| `encoded` | `process_item_flow` | HLS package is on disk in `encoded/`. |
| `uploading` | `process_item_flow` | Worker is pushing the package to Wasabi. |
| `complete` | `process_item_flow` | Wasabi key written to `video_jobs.wasabi_key`; Directus `media_items` row inserted. |
| `failed` | `process_item_flow` (`except` branch) | Exception captured in `video_jobs.error_message`. |

## The two flows

### `scan-collections`

[`flows.py:87-96`](../video_grabber/pipeline/flows.py)

Crawls each named IA collection recursively. Rate-limited by `IA_RATE_PER_SEC` (default 2/s, matching IA's bulk-access guidance). Items with `mediatype == "collection"` are recursed into; leaf items are passed to `upsert_job()` which uses `ON CONFLICT (ia_identifier) DO NOTHING` so reruns are free.

```python
@flow(name="scan-collections")
def scan_collections_flow(collections: list[str] = ["sept_11_tv_archive", "911"]):
```

Default collections are the two pre-imported IA sets. Pass any IA collection ID to scan it.

### `process-item`

[`flows.py:99-135`](../video_grabber/pipeline/flows.py)

One run per `video_jobs.id`. Walks `downloading → downloaded → encoding → encoded → uploading → complete`, calling `transition_job()` between each step. On exception, transitions to `failed` and re-raises so Prefect marks the run as failed.

```python
@flow(name="process-item")
def process_item_flow(job_id: str):
```

## Atomic transitions

Every stage change goes through [`transition_job()`](../video_grabber/pipeline/flows.py) (`flows.py:46-84`), which performs both writes — the cached state on `video_jobs.stage` and the audit row in `pipeline_transitions` — on the same connection and commits them together. The enum cast is explicit because SQLAlchemy doesn't auto-cast string→enum for Postgres custom types:

```sql
UPDATE video_jobs SET stage = CAST(:stage AS pipeline_stage), ...
INSERT INTO pipeline_transitions (job_id, from_stage, to_stage, worker_id)
  VALUES (:job_id, CAST(:from_stage AS pipeline_stage), CAST(:to_stage AS pipeline_stage), :worker_id);
```

`worker_id` is sourced from `HOSTNAME`, which Kubernetes sets to the pod name — useful for correlating audit rows back to Prefect run logs.

## Failure handling

The `try/except` in `process_item_flow` (`flows.py:108-135`) catches every exception, records it with `to_stage="failed"` and `error=str(exc)`, then re-raises. Two consequences:

1. `pipeline_transitions` records the transition into `failed` with `from_stage=NULL` (the previous in-flight stage is not recorded because we don't capture it before re-raising). The original stage can be recovered by querying the second-to-last transition row for the job.
2. Prefect's UI shows the run as failed, so Prefect-level retry policies apply.

A failed job is **not** automatically retried. Operators query for `WHERE stage = 'failed'` and decide whether to clear `error_message`, reset `stage`, and rerun.

## Scratch directory

Worker-local: `SCRATCH_DIR` env var (default `/tmp/vg-scratch`) is mounted as a 50Gi `emptyDir` in the worker pod. Layout:

```
/tmp/vg-scratch/
└── <ia_identifier>/
    ├── <source>.mp4         # downloader output
    └── encoded/
        ├── master.m3u8
        ├── full/  index.m3u8  init.mp4  seg0000.m4s  …
        ├── mid/   …
        └── thumb/ …
```

Nothing cleans this up on success today. If pods churn over many items, expect the volume to fill — see the runbook for `kubectl exec` cleanup notes.
