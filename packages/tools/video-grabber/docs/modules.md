# Module guide

Per-subpackage responsibilities, ordered roughly by the path a job takes through the system.

## `video_grabber.config`

[`video_grabber/config.py`](../video_grabber/config.py)

A frozen-by-convention `@dataclass` that reads env vars in `field(default_factory=...)`. Constructing `Config()` re-reads the environment each time, so tests can `monkeypatch.setenv()` and then `Config()` to assert effective values without managing module-level state. There is no validation — empty strings are valid placeholders for missing credentials, which the consumers detect at call time.

| Field | Env var | Default |
| --- | --- | --- |
| `database_url` | `DATABASE_URL` | `""` |
| `wasabi_endpoint` | `WASABI_ENDPOINT_URL` | `https://s3.us-central-1.wasabisys.com` |
| `wasabi_bucket` | `WASABI_BUCKET` | `files.911realtime.org` |
| `wasabi_key` / `wasabi_secret` | `WASABI_ACCESS_KEY_ID` / `WASABI_SECRET_ACCESS_KEY` | `""` |
| `directus_url` | `DIRECTUS_URL` | `http://localhost:8055` |
| `directus_api_token` | `DIRECTUS_API_TOKEN` | `""` |
| `ia_rate_per_sec` | `IA_RATE_PER_SEC` | `2` |
| `min_duration_seconds` | `MIN_DURATION_SECONDS` | `720` (12 min) |

`directus_email` / `directus_password` are also read but **not used by the worker**. They exist only for manual admin scripts; the writer always uses the static API token. Session tokens race across concurrent workers and were the source of an early bug — see the `.env.example` warning.

## `video_grabber.ia`

### `scanner.py`

[`ia/scanner.py`](../video_grabber/ia/scanner.py)

Recursive `crawl_collection()` walks an IA collection identifier with `session.search_items()` and recurses into items whose `mediatype == "collection"`. Leaf items are passed through `is_candidate()` (duration ≥ `MIN_DURATION_SECONDS`) and then `upsert_job()`.

The `visited` set is mandatory — IA collections form a DAG, not a tree, so without dedup the crawler can revisit the same sub-collection through multiple parents. `sleep_sec` between item iterations enforces the IA rate limit (calculated as `1 / IA_RATE_PER_SEC` in the calling flow).

`upsert_job()` uses `INSERT … ON CONFLICT (ia_identifier) DO NOTHING`, so rescanning is a free no-op for known items. New items with a recognized channel start at `stage='discovered'`; new items with no recognizable channel start at `stage='pending_review'`.

### `metadata.py`

[`ia/metadata.py`](../video_grabber/ia/metadata.py)

Pure date/timezone parsing. Two regex strategies tried in order: ISO 8601 then "Month Day, Year HH:MM TZ". Both return a `datetime` in UTC.

Specific behaviors worth knowing:

- **Default timezone is EDT (`UTC-4`)**, matching the on-air timezone of the eastern US 9/11 coverage. Items with no timezone abbreviation are interpreted in EDT, not local time, not UTC. This is intentional and ported from `packages/backend/seed.mjs`.
- **ISO with no zone is treated as UTC**, not EDT. Mixed-mode quirk; rationale: ISO strings in our corpus came from machine-generated metadata that records in UTC.
- BST/CEST are mapped for the small number of BBC items in the collection.
- The patterns use `_MONTH_NAMES` with both long ("september") and short ("sept", "sep") forms.

### `channel_map.py`

[`ia/channel_map.py`](../video_grabber/ia/channel_map.py)

`normalize_slug(item)` checks `creator`, then `subject`, then `title`. The first hit wins. `KNOWN_CHANNELS` lists the canonical major networks; the `_LOCAL_CALL_SIGN` regex catches W/K-prefixed 4-letter affiliate signs (WABC, KCAL, etc.) and lowercases them as the slug. Returns `None` for unrecognized items, which causes the scanner to file the item under `pending_review`.

Adding a new channel = add a `lowercase pattern: canonical-slug` entry to `KNOWN_CHANNELS` and re-deploy.

## `video_grabber.pipeline`

### `flows.py`

[`pipeline/flows.py`](../video_grabber/pipeline/flows.py)

The Prefect entry points. See [pipeline.md](./pipeline.md) for the stage-by-stage walkthrough. Three notes on the implementation:

- `get_db()` opens a new SQLAlchemy connection per call. There is no pooling at this layer; pooling is whatever `sqlalchemy.create_engine` defaults to (which is fine for one flow run per worker pod at a time).
- The `ArchiveSession` import is guarded with `try/except ImportError` so unit tests can import `flows.py` without `internetarchive` installed.
- `transition_job(error=...)` writes both the error message and the `failed` stage in one UPDATE.

### `downloader.py`

[`pipeline/downloader.py`](../video_grabber/pipeline/downloader.py)

Talks to the public IA HTTP API (`https://archive.org`), not the Python SDK, to keep the HTTP semantics explicit. `get_ia_files(identifier)` hits `/metadata/<id>/files`.

`select_best_file()` orders candidates by format priority (`.mp4` > `.mpg`/`.mpeg2` > `.avi` > `.ogv`) and skips known low-quality derivatives (anything containing `512kb`, `256kb`, `128kb`, `_small`, `_tiny`, `_thumb`). Raises `ValueError` when nothing qualifies.

`download_item(job, dest_dir, cfg=None, *, logger=None)` fetches the best source. When `cfg` is passed it tries Wasabi first, then falls back to Internet Archive:

- **Wasabi-first reuse.** A prior effort grabbed ~700 of these sources into the bucket at `download/<ia_identifier>/<file>`. `find_wasabi_source()` checks for `download/<id>/<best.name>` and reuses it **only if `head_object` ContentLength byte-matches IA's reported `size`** (a truncated or different cut falls through to IA). When it matches, the file is pulled with `s3.download_file` — in-region, no IA rate limit. ~13% of the current queue (711 of ~5,600 jobs) hits this fast path. Note the IA *metadata* call still happens (it provides the authoritative size to verify against); only the multi-GB *file* transfer is skipped.
- **IA streaming download** (the fallback, also used when `cfg` is None): if the destination file already exists, sends `Range: bytes=<size>-` and appends; streams 1 MiB chunks with `httpx.stream` (no full-buffer load).
- Calls `update_bytes_downloaded()` per chunk — the actual DB write is currently a no-op stub; the live progress counter is reserved for a future "what % done" view.

## `video_grabber.video`

### `encoder.py`

[`video/encoder.py`](../video_grabber/video/encoder.py)

Three subprocess calls — one per rendition — instead of one ffmpeg invocation with `-map` arrays. The trade-off: slightly longer wall-clock time, much simpler error attribution. If `mid` fails, you know exactly which command failed and can rerun just that step.

| Rendition | Resolution | Video | Audio | Bandwidth (master.m3u8) |
| --- | --- | --- | --- | --- |
| `full` | 854×480 | CRF 21, maxrate 2500k | 128k stereo | 2 628 000 |
| `mid` | 320×240 | CBR ~300k, maxrate 350k | 96k stereo | 396 000 |
| `thumb` | 160×120 | CBR ~128k, maxrate 160k | 8k mono | 136 000 |

Common encoding flags (shared across all rungs):

- `libx264`, profile main, level 3.1.
- `-preset slow` — long encode times, smaller files, better quality.
- 29.97 fps with `-g 60 -keyint_min 60 -sc_threshold 0` — fixed 2-second GOP, no scene-cut keyframe insertion. Required for `independent_segments`.
- Audio: `aac` at 44 100 Hz.

HLS flags: `fmp4`/CMAF (`init.mp4` + `seg%04d.m4s`), VOD playlist type, 6-second segments, `independent_segments` so any rendition can be started from any segment.

`scale_keep_aspect()` rounds output dimensions to even numbers (H.264 requirement) and refuses to upscale — small source videos stay small in the upper rungs rather than being blown up.

`probe_resolution()` shells out to `ffprobe` to determine source dimensions before computing scale targets.

### `gap_filler.py`

[`video/gap_filler.py`](../video_grabber/video/gap_filler.py)

Generates fMP4 segments of solid blue (`#0000f5`, the EBU colour-bar "no signal" blue used by US broadcast continuity) plus silent audio, sized to match each `RENDITIONS` entry so hls.js's level-switching logic doesn't reject them as codec-incompatible.

Critical: **the thumb rung keeps audio (8kbps mono)** even though no human listens to a 160×120 stream. hls.js requires every rendition in the master playlist to expose the same audio profile, so dropping audio on thumb causes silent-rung fallbacks to behave incorrectly. Don't "optimize" this.

`generate_gap_fmp4(output_dir, *, remainder_seconds=(1,2,3,4,5))` emits, per rendition, a shared `init.mp4` + the canonical `seg_gap_6s.m4s` + one `seg_gap_<n>s.m4s` per remainder — the exact segments the assembler references to fill a gap of any length (`⌊G/6⌋ × 6s + G%6`). Each segment is encoded standalone with a forced IDR at frame 0 (`-force_key_frames expr:eq(n,0)`) so it decodes independently. No master/index playlist is produced. See [channel-stitching.md](./channel-stitching.md).

## `video_grabber.storage`

### `wasabi.py`

[`storage/wasabi.py`](../video_grabber/storage/wasabi.py)

Wasabi-specific boto3 client. Three quirks that all exist for one bug each:

1. **`addressing_style="path"`** — Wasabi's virtual-hosted DNS for bucket names containing dots (`files.911realtime.org` does) is unreliable; path-style addressing is the supported workaround.
2. **`request_checksum_calculation="when_required"`** — boto3 ≥ 1.36 started injecting `x-amz-checksum-*` headers on every PUT. Wasabi rejects unrecognized checksum algorithms with HTTP 400. This setting reverts boto3 to the pre-1.36 behavior.
3. **`response_checksum_validation="when_required"`** — same root cause, GET path.

Upload key layout: `hls/<channel-slug>/<YYYYMMDD>/<ia-identifier>/<file>`. `upload_hls_package()` returns the `master.m3u8` key so the caller can write it to `video_jobs.wasabi_key`.

Four generic helpers back the channel-stitching feature: `upload_tree(local_dir, key_prefix, cfg)` (uploads a directory tree, used for the gap package → `hls/<slug>/_gap/`), `upload_text(content, key, cfg)` (PUTs a string — the `playlists/<slug>/*.m3u8` playlists and the `epg/*.json` guide), and `read_text(key, cfg)` + `list_keys(prefix, cfg)` (used by `_rebuild_epg_guide` to reassemble `epg/guide.json`). `upload_hls_package` is now a thin wrapper over `upload_tree`.

`Content-Type` and `Cache-Control` are set per extension:

| Extension | Content-Type | Cache-Control |
| --- | --- | --- |
| `.m3u8` | `application/vnd.apple.mpegurl` | `max-age=5` (playlists change; segments don't) |
| `.mp4` (init.mp4) | `video/mp4` | `max-age=31536000` (immutable) |
| `.m4s` | `video/iso.segment` | `max-age=31536000` (immutable) |

Multipart upload trips at 100 MiB with 50 MiB chunks and 10-way concurrency.

## `video_grabber.directus`

### `writer.py`

[`directus/writer.py`](../video_grabber/directus/writer.py)

Writes one row to Directus `media_items`. Idempotent on rerun: the first action is a `GET /items/media_items?filter[content][ia_identifier][_eq]=...`. If a row exists, the writer returns early.

Static Bearer token only — see the `.env.example` warning about session-token races. Date strings use Directus's naive-UTC convention (`%Y-%m-%dT%H:%M:%S`, no `Z`, no offset). `end_date` is computed from `air_date + duration_seconds`.

`source` is a foreign key resolved by `_resolve_source_id()` which queries `/items/sources?filter[slug][_eq]=<channel_slug>` and returns the first match's `id`. If no source exists, `source` is `None` and Directus must accept the nullable FK.

`approved` is `0` if `job.passed_through_review` is truthy (i.e. the job was once in `pending_review` and a human cleared it), `1` otherwise — so reviewed items go to a human-validation queue downstream while clean-pipeline items go live.

The `content` field is `json.dumps({"ia_identifier": …})`. Directus stores it as a JSON column; the round-trip through `json.dumps` is required because the field's schema is `string`, not `json`, in this project's Directus config.

`upsert_channel_media_item(channel, master_url, window_start, cfg)` is the channel-stitching counterpart: it writes/PATCHes **one** row per channel, keyed for idempotency on the top-level `url` (`playlists/<slug>/master.m3u8`) — not a `content` subfield, which 403s since `content` is an opaque JSON string. See [channel-stitching.md](./channel-stitching.md).

## `video_grabber.epg`

See [epg.md](./epg.md) (playlist/JSON mechanics) and [channel-stitching.md](./channel-stitching.md) (the full continuous-stream feature). Contains `assembler.py` (`assemble_range`/`assemble_day`) and `scheduler.py` (`build_schedule`/`resolve_slots` — lays `programs` onto `schedule_slots` with the first-wins-clip overlap policy).

## `video_grabber.db`

Alembic migrations only. `env.py` overrides `sqlalchemy.url` from `DATABASE_URL` if set, so the same migrations script runs both locally and in the cluster against the in-cluster Postgres. `target_metadata = None` — migrations are hand-written, not autogenerated.

Run migrations: `alembic -c <config> upgrade head`. There is no `alembic.ini` in the repo today; if you need to run migrations outside the deploy hook, supply your own config that points at `video_grabber/db/migrations`.
