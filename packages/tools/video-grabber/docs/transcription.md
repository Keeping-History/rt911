# Audio transcription pipeline

Transcribes encoded TV programs and radio MP3s with whisper.cpp (Vulkan/iGPU)
into per-unit and per-channel SRT/VTT subtitle files, uploads them to Wasabi,
and registers the `.srt` URL in Directus (`subtitles` column on `tv_channels`
and `mp3_items`). The frontend swaps the `.srt` extension to `.vtt` to obtain
the sibling VTT file for the `<track>` element.

Code lives in [`video_grabber/transcribe/`](../video_grabber/transcribe/). The
state table is `transcribe_jobs` (migration `003`).

---

## End-to-end data flow

```
video_jobs (stage='complete', wasabi_key set)           audio/ keys in Wasabi
         │  scan-transcribe                                      │
         ▼                                                       ▼
   transcribe_jobs (kind='tv')                    transcribe_jobs (kind='mp3')
         │                    dispatch-transcribe (drains queue, blocking)
         └─────────────────────────────────────────────────────┘
                                       │
                               transcribe-item (per job)
                                       │
                    ┌──────────────────┴──────────────────┐
                    │ ffmpeg: extract 16 kHz mono WAV     │
                    │ whisper-cli: WAV → .srt + .vtt      │
                    │ upload to Wasabi subtitles/          │
                    └──────────────────┬──────────────────┘
                      tv: srt_key in   │    mp3: also PATCH mp3_items.subtitles
                      transcribe_jobs  │
                                       ▼
                         build-channel-subtitles (per channel, run manually)
                                       │
                    ┌──────────────────┴──────────────────┐
                    │ offset each program's cues by        │
                    │ (air_date − tv_channels.start_date)  │
                    │ merge → channel SRT/VTT              │
                    │ upload, PATCH tv_channels.subtitles  │
                    └─────────────────────────────────────┘
```

---

## Flows and their operational order

There are four Prefect flows. Run them in this sequence:

| Step | Flow | What it does |
|---|---|---|
| 1 | `scan-transcribe` | Enumerates every `video_jobs` row with `stage='complete'` and a non-null `wasabi_key`, plus every `audio/*.mp3` key in Wasabi. Inserts into `transcribe_jobs` with `ON CONFLICT (source_key) DO NOTHING` — idempotent. |
| 2 | `dispatch-transcribe` | Atomically claims one pending or retryable-failed job at a time and blocks on `transcribe-item` for it. Drains the whole queue before returning. Run two instances in parallel (the concurrency cap is 2) to keep both GPUs busy. |
| (2a) | `transcribe-item` | Invoked by `dispatch-transcribe` per job. Extracts audio, runs whisper, uploads SRT/VTT, patches `mp3_items` for MP3 jobs. TV Directus write is deferred to step 3. |
| 3 | `build-channel-subtitles` | Per-channel post-processing: reads each done program's per-unit SRT from Wasabi, offsets the cues onto the channel timeline, merges all programs, uploads the channel SRT/VTT, and PATCHes `tv_channels.subtitles`. Re-runnable. |

`dispatch-transcribe` is **not** on a schedule in `serve.py` (unlike `dispatch-usenet`).
It must be triggered manually (or via a one-time cron/k8s Job) after a scan.
`build-channel-subtitles` must be triggered separately per channel slug after the
queue is drained.

---

## The isochronous offset invariant

The assembled per-channel HLS stream is **isochronous**: one real second equals one
media second, with gaps blue-filled. The player seeks any instant by computing
`currentTime = (wallClock − window_start) / 1000` (see `epg/assembler.py`).

For subtitle merging to be correctly aligned, each program's cues must be shifted
by the same offset:

```
cue_stream_time = cue_program_time + (air_date − tv_channels.start_date)
```

`tv_channels.start_date` is the `window_start` anchor used by the assembler — it
is the earliest moment in the assembled window, stored by `upsert_channel_media_item`.
This value is read by `build-channel-subtitles` from the `tv_channels` row whose
`content` marker matches `{"channel_stream": slug}`.

`build_channel_cues()` in `flows.py` implements this:

```python
offset = (air_date - window_start).total_seconds()
blocks.append(shift(parse_srt(srt_text), offset))
```

MP3 radio files are transcribed 1:1 — the SRT cues are relative to the MP3 start
and no offset is applied; the per-unit SRT is written directly to `mp3_items.subtitles`.

---

## whisper.cpp, Vulkan, and GPU contention

whisper.cpp is built with the Vulkan backend in the `whisper-builder` Docker stage:

```dockerfile
cmake -B build -DGGML_VULKAN=1 -DGGML_NATIVE=OFF -DCMAKE_BUILD_TYPE=Release
```

`GGML_NATIVE=OFF` ensures the binary runs on the `encode-1` node (AMD Ryzen iGPU)
without being tied to the CI builder's CPU architecture. If Vulkan is unavailable
at runtime, whisper.cpp falls back to CPU automatically.

The model is baked into the image at build time:

```dockerfile
RUN bash ./models/download-ggml-model.sh medium.en && \
    cp models/ggml-medium.en.bin /opt/models/
```

The runtime image copies it to `/opt/models/ggml-medium.en.bin`.

**GPU contention with VAAPI video encode:** the `encode-1` iGPU handles both
`h264_vaapi` video encoding (VAAPI driver) and whisper Vulkan compute. These
compete for iGPU resources. The transcription concurrency cap is therefore set
to **2** (`_TRANSCRIBE_ITEM_LIMIT = 2` in `serve.py`) — raise it only if the
video-encoding backlog is idle.

### Configuration knobs

| Env var | Default (in image) | Meaning |
|---|---|---|
| `WHISPER_BIN` | `/usr/local/bin/whisper-cli` | Path to the whisper-cli binary |
| `WHISPER_MODEL` | `/opt/models/ggml-medium.en.bin` | Path to the ggml model file |
| `WHISPER_THREADS` | `4` | CPU threads passed to `-t` |
| `SUBTITLES_PREFIX` | `subtitles` | Wasabi key prefix for all subtitle files |

---

## Wasabi key layout

```
subtitles/
  programs/<ia_identifier>.srt      # per-TV-program (from transcribe-item, kind='tv')
  programs/<ia_identifier>.vtt
  <channel_slug>/channel.srt        # merged per-channel (from build-channel-subtitles)
  <channel_slug>/channel.vtt
  audio/<mp3_basename>.srt          # per-MP3 (from transcribe-item, kind='mp3')
  audio/<mp3_basename>.vtt
```

`<ia_identifier>` is the Internet Archive item ID (e.g. `911networks_cnn_20010911_120000`).
`<mp3_basename>` is the stem of the `audio/` key (e.g. `wtop_20010911_060000`).

---

## The `.srt`-in-column, `.vtt`-by-swap decision

The `subtitles` column on `tv_channels` and `mp3_items` stores the **`.srt` URL**.
The frontend derives the `.vtt` sibling by replacing `.srt` with `.vtt`
(see `packages/frontend` — the `vttUrl` helper). This keeps a single Directus
column per row while giving the browser the VTT it needs for the `<track>` element
(browsers require WebVTT, not SRT, for the `<track src>` attribute).

Both the `.srt` and `.vtt` are uploaded by `transcribe-item` and
`build-channel-subtitles` from the same whisper output — no conversion is needed
because whisper.cpp writes both natively (`--output-srt --output-vtt`).

The `hls-video-element` web component must forward its `<track>` child to the
inner `<video>` element for captions to fire. If it does not (some versions slot
the child into the shadow DOM's light children without forwarding), the imperative
fallback is to add the track via `videoElement.addTextTrack()` / a dynamically
appended `<track>` on the inner `<video>` directly.

---

## `transcribe_jobs` state table (migration `003`)

One row per transcription unit. Mirrors `usenet_jobs`:

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | `gen_random_uuid()` primary key |
| `kind` | text | `'tv'` or `'mp3'` |
| `source_key` | text | UNIQUE — IA identifier (TV) or Wasabi `audio/` key (MP3); the idempotency key |
| `channel_slug` | text | TV only; used by `build-channel-subtitles` |
| `source_url` | text | Public URL passed to ffmpeg |
| `srt_key` | text | Produced per-unit Wasabi key; set on transition to `done` |
| `stage` | enum | `pending → transcribing → done / failed` |
| `error_message` | text | Last error; kept on failure for diagnosis |
| `retry_count` | int | Bumped each time `dispatch-transcribe` re-claims a failed job |
| `last_transition_at` | timestamptz | Updated on every stage change |
| `created_at` | timestamptz | Insert time |

**Failed jobs are kept, not purged.** `dispatch-transcribe` automatically retries
them up to `max_retries` (default 3) times by re-claiming rows where
`stage = 'failed' AND retry_count < max_retries`. The `error_message` column is
the first place to look when diagnosing a failure.

---

## Operational recipe

### 1. Run a scan

```python
# inside the worker pod:
from prefect.deployments import run_deployment
run_deployment(name="scan-transcribe/scan-transcribe", timeout=0)
```

Check what was enqueued:
```bash
kubectl -n video-grabber exec -i deploy/video-grabber-worker -- python -c "
import sqlalchemy as sa
from video_grabber.transcribe.flows import get_db
db = get_db()
print(dict(db.execute(sa.text(
    \"SELECT kind, stage, count(*) FROM transcribe_jobs GROUP BY kind, stage\"
)).fetchall()))"
```

### 2. Drain the queue

Trigger two `dispatch-transcribe` runs (matching the concurrency cap of 2):

```python
from prefect.deployments import run_deployment
# Each call blocks until that dispatcher exhausts the queue.
# Run both concurrently (two shells / two threads) to saturate the two-wide limit.
run_deployment(name="dispatch-transcribe/dispatch-transcribe", timeout=0)
```

Monitor progress:
```bash
kubectl -n video-grabber exec -i deploy/video-grabber-worker -- python -c "
import sqlalchemy as sa
from video_grabber.transcribe.flows import get_db
db = get_db()
print(dict(db.execute(sa.text(
    \"SELECT stage, count(*) FROM transcribe_jobs GROUP BY stage\"
)).fetchall()))"
```

Inspect failures (kept for diagnosis):
```bash
kubectl -n video-grabber exec -i deploy/video-grabber-worker -- python -c "
import sqlalchemy as sa
from video_grabber.transcribe.flows import get_db
db = get_db()
[print(r) for r in db.execute(sa.text(
    \"SELECT kind, source_key, retry_count, left(error_message, 120) \"
    \"FROM transcribe_jobs WHERE stage='failed' LIMIT 10\"
))]"
```

### 3. Build each channel's subtitles

After the queue is empty (or has only permanent failures), run
`build-channel-subtitles` for each channel slug:

```python
from prefect.deployments import run_deployment
for slug in ["cnn", "msnbc", "wtop", ...]:   # all channel slugs
    run_deployment(
        name="build-channel-subtitles/build-channel-subtitles",
        parameters={"channel_slug": slug},
        timeout=0,
    )
```

`build-channel-subtitles` is idempotent: re-running it regenerates the channel
SRT/VTT from the current set of `done` programs and re-PATCHes Directus.

### 4. Verify

Check Directus rows:
```bash
# tv_channels: should have non-null subtitles for assembled channels
curl -s -H "Authorization: Bearer $DIRECTUS_API_TOKEN" \
  "$DIRECTUS_URL/items/tv_channels?fields=id,title,subtitles&filter[subtitles][_nnull]=true" \
  | python3 -m json.tool | head -40

# mp3_items
curl -s -H "Authorization: Bearer $DIRECTUS_API_TOKEN" \
  "$DIRECTUS_URL/items/mp3_items?fields=id,title,subtitles&filter[subtitles][_nnull]=true" \
  | python3 -m json.tool | head -40
```

Spot-check a `.vtt` file directly:
```bash
curl -I "https://files.911realtime.org/subtitles/cnn/channel.vtt"
```

Then open the TV or Radio app and confirm the captions toggle shows English
subtitles aligned to playback.

---

## CORS verification

**Tested on 2026-06-25 (no live `.vtt` artifacts yet).**

### What was tested

```bash
# 1. A real existing object on an allowed path (playlists/):
curl -sI -H "Origin: https://beta.911realtime.org" \
  "https://files.911realtime.org/playlists/cnn/master.m3u8" \
  | grep -i "access-control"
```

Result (HTTP 200):
```
access-control-allow-headers: *
access-control-allow-methods: GET, HEAD, OPTIONS
access-control-allow-origin: *
access-control-expose-headers: Content-Length, Content-Range, Content-Type, Accept-Ranges, ETag
access-control-max-age: 86400
```

```bash
# 2. The subtitles/ prefix (no live artifact yet):
curl -sI -H "Origin: https://beta.911realtime.org" \
  "https://files.911realtime.org/subtitles/test.vtt" \
  | grep -i "access-control"
```

Result (HTTP 404, **no CORS headers**):
```
(no Access-Control-* headers)
```

### Why `subtitles/` gets no CORS headers

The file proxy is nginx-s3-gateway behind Traefik. CORS is applied by a Traefik
middleware (`apps/file-proxy/middleware.yaml`) that stamps `Access-Control-Allow-Origin: *`
unconditionally on every response — **but only for routes that Traefik forwards to
the proxy**. The Ingress allow-list (`apps/file-proxy/ingress.yaml`) controls which
path prefixes Traefik routes at all. It currently includes:

```
/hls, /playlists, /audio, /download, /transcoded, /guide, /epg, /thumbnails, /images
```

`/subtitles` is not in this list. A request for `subtitles/...` therefore 404s at
Traefik before reaching nginx or the CORS middleware, returning no CORS headers.

### Required infra change (deploy prerequisite)

Add one path entry to `apps/file-proxy/ingress.yaml` in the infra repo:

```yaml
- path: /subtitles
  pathType: Prefix
  backend: { service: { name: file-proxy, port: { number: 80 } } }
```

Once that commit lands on infra `main` and ArgoCD syncs, any `subtitles/*.vtt`
object already uploaded to Wasabi will be served with `Access-Control-Allow-Origin: *`.

The browser `<track>` fetch is a CORS request; without this header the browser
blocks it and captions do not appear, even though the VTT file exists in Wasabi.

### What the existing test proves / does not prove

- **Proves:** the CORS middleware is correctly wired and unconditionally stamps
  `Access-Control-Allow-Origin: *` on all paths it reaches — no per-object
  configuration is needed once a path is admitted.
- **Does not prove:** that `subtitles/` objects are currently accessible (they are
  not), or that the `.vtt` MIME type is served correctly (untested; nginx-s3-gateway
  proxies the `Content-Type` from Wasabi's object metadata, which should be
  `text/vtt` if uploaded with the right content type — worth confirming after
  first upload).
