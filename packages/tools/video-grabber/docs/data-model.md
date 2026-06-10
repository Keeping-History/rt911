# Data model

The pipeline database is Postgres, managed by Alembic. Migration `001_initial_schema` ([`video_grabber/db/migrations/versions/001_initial_schema.py`](../video_grabber/db/migrations/versions/001_initial_schema.py)) creates the full schema; there are no later revisions.

## Tables

### `channels`

Catalog of broadcast networks served by the pipeline.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | UUID PK | `gen_random_uuid()` default. |
| `slug` | text, unique | Lowercase, hyphenated (`cnn`, `abc-news`). The same slug appears in Wasabi paths and Directus' `sources.slug`. |
| `display_name` | text | Human label used in EPG JSON. |
| `timezone` | text | Fixed offset name (e.g. `EDT`); `directus/writer.py` and `epg/assembler.py` consume it. |
| `created_at` | timestamptz | `now()`. |

Channels are seeded separately (not by the pipeline). New channels added via DDL or admin tooling.

### `programs`

Per-air metadata for a single broadcast. One program per IA item (one-to-one with `video_jobs.ia_identifier`).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | UUID PK | |
| `channel_id` | UUID FK → `channels.id` | |
| `title` | text | Used as Directus `media_items.full_title`. |
| `description` | text | Optional. |
| `air_date` | timestamptz | UTC. Parsed from title/description by `ia/metadata.py`. |
| `duration_seconds` | integer | From IA `length`; used by Directus writer for `calc_duration` and end-time. |
| `ia_identifier` | text | Denormalized for convenience; equal to the parent `video_jobs.ia_identifier`. |
| `created_at` | timestamptz | |

### `video_jobs`

The pipeline state row. One row per IA identifier; the unique constraint on `ia_identifier` is what makes `scan-collections` idempotent.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | UUID PK | Used as `job_id` in Prefect flows. |
| `ia_identifier` | text, **unique** | Scanner upserts with `ON CONFLICT DO NOTHING`. |
| `stage` | `pipeline_stage` enum | Default `discovered`. Cached current state. |
| `collection` | text | Source collection (`sept_11_tv_archive` or `911`). |
| `channel_id` | UUID FK → `channels.id` | Set when the channel is recognized; NULL for `pending_review` rows. |
| `program_id` | UUID FK → `programs.id` | Set when metadata extraction populates `programs`. |
| `ia_metadata` | jsonb | Raw IA fields captured at scan time. |
| `local_path` | text | Where the source landed on the worker filesystem (currently unused; reserved). |
| `encoded_path` | text | Where the HLS package landed (currently unused; reserved). |
| `wasabi_key` | text | The key of the uploaded `master.m3u8`. Set on transition to `complete`. |
| `bytes_total` | bigint | Source file size (currently unset; downloader does not write this). |
| `bytes_downloaded` | bigint | Updated during streaming download; default `0`. |
| `error_message` | text | Populated on `failed`. |
| `retry_count` | integer | Reserved; not incremented automatically. |
| `last_transition_at` | timestamptz | Updated by `transition_job()`. |
| `created_at` | timestamptz | |

Index: `idx_jobs_stage` on `stage` so "give me everything stuck in `encoding`" is cheap.

### `pipeline_transitions`

Append-only audit log. The source of truth for "what happened to this job, and when."

| Column | Type | Notes |
| --- | --- | --- |
| `id` | bigint PK | autoincrement. |
| `job_id` | UUID FK → `video_jobs.id` | |
| `from_stage` | `pipeline_stage` | NULL for the initial transition and for transitions into `failed`. |
| `to_stage` | `pipeline_stage` | Not null. |
| `worker_id` | text | Pod name from `HOSTNAME`. |
| `occurred_at` | timestamptz | `now()` default. |

Index: `idx_transitions_job` on `job_id`.

### `schedule_slots`

Consumed by the EPG assembler ([`epg/assembler.py`](../video_grabber/epg/assembler.py)). One row per programmed slot on a channel/day.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | UUID PK | |
| `channel_id` | UUID FK → `channels.id` | |
| `program_id` | UUID FK → `programs.id` | NULL when `is_gap` is true. |
| `starts_at` | timestamptz | |
| `ends_at` | timestamptz | |
| `segment_url` | text | Optional override for the slot's playlist URL. |
| `is_gap` | boolean | `false` default; assembler does not currently use this flag (it computes gaps from time ranges). |

Index: `idx_slots_channel_time` on `(channel_id, starts_at, ends_at)`.

## The `pipeline_stage` enum

```sql
CREATE TYPE pipeline_stage AS ENUM (
  'discovered', 'metadata_extracted', 'pending_review',
  'downloading', 'downloaded', 'encoding', 'encoded',
  'uploading', 'complete', 'failed'
);
```

Adding a new value requires a follow-up Alembic migration. SQLAlchemy does not auto-cast strings to this enum, so every write in `flows.py` uses `CAST(:stage AS pipeline_stage)` explicitly.

## Reference queries

Jobs stuck for more than an hour:

```sql
SELECT id, ia_identifier, stage, error_message, last_transition_at
FROM video_jobs
WHERE stage NOT IN ('complete', 'pending_review')
  AND last_transition_at < now() - interval '1 hour'
ORDER BY last_transition_at;
```

Full history of a single job:

```sql
SELECT from_stage, to_stage, worker_id, occurred_at
FROM pipeline_transitions
WHERE job_id = '...'
ORDER BY occurred_at;
```

Reset a failed job back to `discovered`:

```sql
UPDATE video_jobs
SET stage = 'discovered', error_message = NULL, last_transition_at = now()
WHERE id = '...';
```

(The audit log retains the failure record — only the cached `stage` column rolls back.)
