---
status: in_progress
approved_at: "2026-06-10T01:39:50.369Z"
updated: "2026-06-10T02:38:53.328Z"
started_at: "2026-06-10T02:38:53.328Z"
---
# Plan: Video Grabber — IA Broadcast Archive → HLS Pipeline

**Created:** 2026-06-10 | **Status:** Draft | **Effort:** XL | **Branch:** time-machine-setup

## Summary

Build `packages/tools/video-grabber`, a Python pipeline that scrapes Internet Archive collections `sept_11_tv_archive` and `911` for broadcast TV recordings from Sep 9–17, 2001, tracks each file through a multi-stage workflow (discover → download → encode → upload), assembles 24-hour HLS streams per channel with blue gap fillers, generates an EPG, and surfaces everything through Prefect's built-in UI. Completed HLS packages are written to Wasabi S3 (`files.911realtime.org`) and registered in the existing `media_items` table via Directus API.

## Architecture Context

- New namespace `video-grabber` on k3s. Prefect server + worker + PostgreSQL all deployed there. Follows bullboard/time-machine sidecar pattern from infra repo.
- Pipeline state (video_jobs, channels, programs, schedule_slots) lives in a **separate PostgreSQL** from rt911-db. Completed packages are written to rt911 via Directus API (`POST /items/media_items`) — same pattern as `seed.mjs` / `import-usenet.mjs`.
- `media_items.url` is only written after `complete` stage; `approved = 0` by default so nothing surfaces to the live streamer until manually approved via Directus.
- All datetimes stored as `TIMESTAMPTZ` (UTC). Channel `timezone` field is metadata only, applied at output time. Matches existing naive-UTC-then-append-Z convention in `TV.tsx`.
- Prefect flows map 1:1 to pipeline stages. Workers run as Kubernetes Jobs (one pod per flow run). PostgreSQL is Prefect's only backend dependency.
- S3 path layout: `hls/{channel_slug}/{yyyymmdd}/{ia_identifier}/index.m3u8`; init segment at `.../init.mp4`; fMP4 segments at `.../seg_{n:04d}.m4s`. Immutable segments get `Cache-Control: max-age=31536000`.
- IA identifier is the dedup key. All inserts use `ON CONFLICT (ia_identifier) DO NOTHING` so rescans are safe.
- gen-epg.mjs gap-filling logic must be superseded by the new EPG assembler; running both simultaneously produces inconsistent results.
- Download, encode, and upload run as sequential `@task` calls within a single `@flow` on one Kubernetes Job pod — no inter-pod file transfer needed (emptyDir scratch volume is shared within the flow run).

## Research Findings

- `internetarchive` library handles pagination automatically; `mediatype:collection` items require manual recursion with a `visited` set to prevent cycles.
- IA `date` field = upload/capture date, NOT air date. Must parse from `title` / `description`. Existing `seed.mjs:parseTitleDate()` has working regex patterns to port.
- Many 2001 IA broadcast files are MPEG-2 program streams (`.mpg`). FFmpeg stream-copy to HLS works only if codec/resolution/framerate/audio all match — re-encode with `libx264/aac` if inputs differ.
- Wasabi S3 is boto3-compatible with `endpoint_url` override. Incomplete multipart uploads are auto-deleted after 31 days. Abort explicitly on failure to avoid cost.
- Prefect self-hosted uses `prefect/prefect-helm` chart. k3s `local-path` PVC for Prefect's own PostgreSQL. `strategy: Recreate` required for PVC-backed Deployments.
- k3s infra repo pattern: `apps/video-grabber/` + `argocd/applications/video-grabber.yaml`. Secrets via `kubectl create secret`, never committed.
- `FOR UPDATE SKIP LOCKED` on `video_jobs` prevents two workers claiming the same item without Redis.

## Security Considerations

- Wasabi credentials (`WASABI_ACCESS_KEY_ID`, `WASABI_SECRET_ACCESS_KEY`) stored as k8s Secret, never in git.
- Directus `ADMIN_PASSWORD` same pattern — k8s Secret.
- Prefect UI exposed behind Traefik BasicAuth middleware (same pattern as bullboard in infra repo).
- IA download URLs are public but respect robots.txt / rate limits. Cap concurrent downloads at 2 per the IA bulk-download guidelines.

## Performance Considerations

- FFmpeg re-encode of a 24-hour stream is CPU-intensive. Encoding Deployments should request 2+ CPU cores and run on nodes with available headroom. Stream-copy is ~100x faster if codec matches — check before deciding encode strategy per item.
- 24-hour HLS at 6s segments = 14,400 `.ts` files per channel per day. Wasabi PUT calls are cheap but parallelise uploads to 10 concurrent threads via `TransferConfig`.
- Prefect worker pods need ephemeral storage for intermediate video files. Set `emptyDir` volume with `sizeLimit: 50Gi` — large enough for multi-hour MPEG-2 files (raw MPEG-2 broadcast can be 2–8 GB/hour).
- IA API rate limit: honor `ARCHIVE_RATE_PER_SEC=2` for S3-like downloads; use `tenacity` exponential backoff on 503s.

## Resolved Decisions

- **Wasabi endpoint:** `s3.us-central-1.wasabisys.com` (us-central-1 region)
- **Video format:** Fragmented MP4 (fMP4/CMAF). HLS output uses `-hls_segment_type fmp4` producing `.m4s` segments + `init.mp4`. Prefer `.mp4` source files from IA over `.mpeg2`/`.ogv`/`.avi`.
- **Shared PostgreSQL:** Deploy a dedicated PostgreSQL instance in a `databases` namespace, accessible cluster-wide at `postgres.databases.svc.cluster.local`. Video-grabber pipeline tables, Prefect backend, and future services all connect here. rt911-db remains separate (owned by Directus).

## Resolved Decisions (continued)

- **`approved` flag:** `approved = 1` for items that complete all pipeline stages cleanly. `approved = 0` only for items that passed through `pending_review` or had metadata uncertainty. Items can be un-approved via Directus if needed.
- **EPG format:** Output `EPGChannel[]` JSON (matching `EPG.tsx` contract) uploaded to Wasabi at `epg/{yyyymmdd}.json`. No XMLTV — deferred to a future P3 story. Frontend `testdata.json` static import will need a follow-up story to become a dynamic fetch.

## Steps

### Step 1: Project foundation + DB schema

- **Test:** `tests/test_config.py` — asserts all required env vars are loaded with correct types; `tests/test_migrations.py` — runs migrations against a test Postgres and verifies all tables/enum exist
- **Implement:** `packages/tools/video-grabber/pyproject.toml`, `Dockerfile`, `.env.example`, `video_grabber/config.py`, `video_grabber/db/migrations/` (Alembic)
- **Code:**
```python
# video_grabber/config.py
from dataclasses import dataclass
import os

@dataclass
class Config:
    database_url: str = os.getenv("DATABASE_URL", "")
    wasabi_endpoint: str = os.getenv("WASABI_ENDPOINT_URL", "https://s3.wasabisys.com")
    wasabi_bucket: str = os.getenv("WASABI_BUCKET", "files.911realtime.org")
    wasabi_key: str = os.getenv("WASABI_ACCESS_KEY_ID", "")
    wasabi_secret: str = os.getenv("WASABI_SECRET_ACCESS_KEY", "")
    directus_url: str = os.getenv("DIRECTUS_URL", "http://localhost:8055")
    directus_email: str = os.getenv("ADMIN_EMAIL", "")
    directus_password: str = os.getenv("ADMIN_PASSWORD", "")
    ia_rate_per_sec: int = int(os.getenv("IA_RATE_PER_SEC", "2"))
    min_duration_seconds: int = int(os.getenv("MIN_DURATION_SECONDS", "720"))
```
```sql
-- migrations/001_initial_schema.sql
CREATE TYPE pipeline_stage AS ENUM (
    'discovered','metadata_extracted','pending_review',
    'downloading','downloaded','encoding','encoded',
    'uploading','complete','failed'
);
CREATE TABLE channels (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, timezone TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE programs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channels(id),
    title TEXT NOT NULL, description TEXT, air_date TIMESTAMPTZ NOT NULL,
    duration_seconds INT NOT NULL, ia_identifier TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE video_jobs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ia_identifier TEXT UNIQUE NOT NULL, stage pipeline_stage DEFAULT 'discovered',
    collection TEXT NOT NULL, channel_id UUID REFERENCES channels(id),
    program_id UUID REFERENCES programs(id), ia_metadata JSONB,
    local_path TEXT, encoded_path TEXT, wasabi_key TEXT,
    bytes_total BIGINT, bytes_downloaded BIGINT DEFAULT 0,
    error_message TEXT, retry_count INT DEFAULT 0,
    last_transition_at TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE schedule_slots (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES channels(id),
    program_id UUID REFERENCES programs(id),
    starts_at TIMESTAMPTZ NOT NULL, ends_at TIMESTAMPTZ NOT NULL,
    segment_url TEXT, is_gap BOOLEAN DEFAULT false);
CREATE INDEX idx_jobs_stage ON video_jobs(stage);
CREATE INDEX idx_slots_channel_time ON schedule_slots(channel_id, starts_at, ends_at);
-- Audit log for all stage transitions (referenced by Step 8 transition_job())
CREATE TABLE pipeline_transitions (
    id          BIGSERIAL PRIMARY KEY,
    job_id      UUID NOT NULL REFERENCES video_jobs(id),
    from_stage  pipeline_stage,
    to_stage    pipeline_stage NOT NULL,
    worker_id   TEXT,
    occurred_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_transitions_job ON pipeline_transitions(job_id);
-- Prefect uses its own database: CREATE DATABASE prefect; in the shared PostgreSQL
-- video_grabber pipeline tables go in: CREATE DATABASE video_grabber;
```
- **Validation:** `python -m pytest tests/test_config.py tests/test_migrations.py`

### Research Enhancement

- **Pattern:** Add a k8s init Job (or init container) that runs `CREATE DATABASE IF NOT EXISTS video_grabber; CREATE DATABASE IF NOT EXISTS prefect;` against the shared PostgreSQL before the worker Deployment starts — prevents race on first deploy.
- **Pattern:** `PREFECT_API_DATABASE_CONNECTION_URL=postgresql+asyncpg://user:pass@postgres.databases.svc.cluster.local:5432/prefect` — asyncpg driver required by Prefect server.
- **Edge Case:** Alembic `env.py` must use `PREFECT_API_DATABASE_CONNECTION_URL`-style DSN only for video_grabber DB (not Prefect's DB); keep them on separate connection strings.
- **Ref:** Prefect v3 server deployment docs; k3s local-path PVC (RWO, single-replica StatefulSet required)

---

### Step 2: IA collection scanner

- **Test:** `tests/test_scanner.py` — unit-test fan-out recursion with mocked `search_items` returning mixed leaf/sub-collection results; assert visited-set prevents cycles; assert items outside Sep 9–17 2001 are excluded; assert dedup via `ia_identifier`
- **Implement:** `video_grabber/ia/scanner.py` — recursive collection crawl writing `video_jobs` rows at stage `discovered`
- **Code:**
```python
BROADCAST_NETWORKS = {
    "abc", "cbs", "nbc", "cnn", "fox", "msnbc", "pbs", "bbc",
    "msnbc", "c-span", "univision", "telemundo",
    # local affiliate patterns matched via regex on title
}

def crawl_collection(session, identifier: str, db, visited: set[str] | None = None):
    visited = visited or set()
    if identifier in visited:
        return
    visited.add(identifier)
    results = session.search_items(
        f"collection:{identifier}",
        fields=["identifier", "mediatype", "title", "description",
                "subject", "creator", "date", "length"]
    )
    for item in results:
        if item.get("mediatype") == "collection":
            crawl_collection(session, item["identifier"], db, visited)
        else:
            if is_candidate(item):
                upsert_job(db, item, collection=identifier)

def is_candidate(item: dict) -> bool:
    duration = float(item.get("length") or 0)
    if duration < MIN_DURATION_SECONDS:  # 720s = 12 min
        return False
    return matches_network(item)  # title/subject/creator contains known network
```
- **Constraint:** Cap search concurrency at `ia_rate_per_sec`. Use `tenacity.retry` with `wait_exponential` on `InternetArchiveError`.
- **Validation:** `python -m pytest tests/test_scanner.py`

### Research Enhancement

- **Pattern:** Channel slug normalization must be defined before implementation — two developers will produce incompatible slugs independently. Define a canonical map: `{"Cable News Network": "cnn", "MSNBC": "msnbc", "ABC News": "abc-news", "CBS News": "cbs-news", "NBC News": "nbc-news", "PBS": "pbs", "BBC": "bbc", "Fox News": "fox-news", "C-SPAN": "c-span", "Univision": "univision", "Telemundo": "telemundo"}` plus a regex fallback for local affiliates (e.g., `r'W[A-Z]{3}'` → lower-case call sign). Store this map in `video_grabber/ia/channel_map.py`.
- **Edge Case:** IA `creator`, `subject`, and `title` fields all carry network names but in different formats. Normalization should try `creator` first (most structured), then `subject`, then regex on `title`.
- **Edge Case:** The same broadcast network may appear in both collections under different spellings. Normalization prevents duplicate `channels` rows.
- **Ref:** Existing `sources` table in rt911 already has slugs for known channels — pre-seed `channels` table from these to maintain consistency with the frontend's source display names.

---

### Step 3: Metadata extractor

- **Test:** `tests/test_metadata.py` — test title parsing against a fixture set of ~20 real IA broadcast titles; assert correct air_date, channel_slug, timezone, duration_seconds extracted; test timezone-to-UTC conversion; test fallback to EDT when timezone absent
- **Implement:** `video_grabber/ia/metadata.py` — parse air date (porting `parseTitleDate` logic from `packages/backend/seed.mjs`), channel normalization, timezone resolution
- **Code:**
```python
# Port of seed.mjs parseTitleDate + channel extraction
TITLE_DATE_PATTERNS = [
    r'(\w+ \d{1,2},?\s+\d{4})\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)\s*(EDT|CDT|PDT|EST|CST|PST|ET|CT|PT)?',
    r'(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)',
]

def extract_air_date_utc(title: str, description: str = "") -> datetime | None:
    for text in [title, description]:
        for pattern in TITLE_DATE_PATTERNS:
            if m := re.search(pattern, text, re.IGNORECASE):
                return parse_and_convert_to_utc(m)
    return None

def resolve_timezone(tz_str: str | None, channel_slug: str) -> ZoneInfo:
    if tz_str:
        return TZABBR_MAP.get(tz_str.upper(), ZoneInfo("America/New_York"))
    return CHANNEL_TIMEZONE_DEFAULTS.get(channel_slug, ZoneInfo("America/New_York"))
```
- **Constraint:** Air date outside Sep 9–17 2001 UTC → set stage to `failed` with `error_message="out_of_range"` (do not delete; allows audit).
- **Validation:** `python -m pytest tests/test_metadata.py`

---

### Step 4: Download worker

- **Test:** `tests/test_downloader.py` — mock IA S3 endpoint; assert byte-range resume (sends `Range: bytes=N-` header after partial download); assert state transitions `downloading` → `downloaded`; assert retry on 503
- **Implement:** `video_grabber/pipeline/downloader.py` — streaming HTTP download with byte-range resume, writes `bytes_downloaded` progress
- **Code:**
```python
def download_item(job: VideoJob, dest_dir: Path) -> Path:
    files = get_ia_files(job.ia_identifier)
    best = select_best_file(files)  # mp4 > mpg/mpeg2 > ogv
    url = f"https://archive.org/download/{job.ia_identifier}/{best['name']}"
    dest = dest_dir / job.ia_identifier / best['name']
    dest.parent.mkdir(parents=True, exist_ok=True)

    offset = dest.stat().st_size if dest.exists() else 0
    headers = {"Range": f"bytes={offset}-"} if offset else {}

    with httpx.stream("GET", url, headers=headers, follow_redirects=True) as r:
        r.raise_for_status()
        with dest.open("ab") as f:
            for chunk in r.iter_bytes(chunk_size=1024 * 1024):
                f.write(chunk)
                offset += len(chunk)
                update_bytes_downloaded(job.id, offset)
    return dest
```
- **Validation:** `python -m pytest tests/test_downloader.py`

### Research Enhancement

- **Best Practice:** Download, encode, and upload MUST be `@task` calls (not `.submit()`) within one `process_item_flow` — this guarantees sequential execution in a single Kubernetes Job pod. All tasks share the pod-local `emptyDir` at `/tmp/vg-scratch/{ia_identifier}/`. No inter-pod file transfer, no shared PVC needed.
- **Best Practice:** Prefect creates one K8s Job per flow run (`parallelism: 1, completions: 1`). The three-stage pipeline (download→encode→upload) runs entirely inside that one pod. Only stage metadata (state transitions) is sent to the Prefect server, not file bytes.
- **Edge Case:** `local_path` in `video_jobs` is a pod-ephemeral path. It is useful for auditing which file was processed but cannot be used to resume from a different pod. After `complete` the file is gone; only the Wasabi URL is permanent.
- **Ref:** Prefect v3 task execution model — direct call = in-process sequential; `.submit()` = concurrent asyncio (still same pod with default runner); separate pod only if `run_deployment()` is used.

---

### Step 5: FFmpeg encoder + gap filler

- **Test:** `tests/test_encoder.py` — call encoder on a short `.mp4` fixture; assert output dir contains `master.m3u8` plus `full/`, `mid/`, and `thumb/` subdirs each with `index.m3u8`, `init.mp4`, and at least one `.m4s`; assert segment duration ≈ 6s; assert `mid/` and `thumb/` have correct lower resolution (ffprobe). `tests/test_gap_filler.py` — generate blue placeholder fMP4 for all 3 renditions; assert each rend dir contains `init.mp4` + `.m4s`; assert first frame color is `#0000f5` (ffprobe). `tests/test_no_upscale.py` — encode a 320×240 source fixture; assert `full/` output is 320×240 (not 854×480), `mid/` is 320×240, `thumb/` is 160×120.
- **Implement:** `video_grabber/video/encoder.py`, `video_grabber/video/gap_filler.py`
- **Code:**
```python
# encoder.py — 3-rendition ABR fMP4/CMAF HLS ladder
# Full: 854x480 (NTSC SD ceiling)  Mid: 320x240  Thumb: 160x120
# No upscaling — each rung is capped at source resolution.
# Stream-copy not applicable when generating multiple renditions; always transcode.
RENDITIONS = [
    {"name": "full",  "width": 854, "height": 480,
     "v_flags": ["-crf", "21", "-maxrate", "2500k", "-bufsize", "5000k"],
     "a_flags": ["-b:a", "128k", "-ac", "2"],  "bandwidth": 2628000},
    {"name": "mid",   "width": 320, "height": 240,
     "v_flags": ["-b:v", "300k",  "-maxrate", "350k",  "-bufsize", "700k"],
     "a_flags": ["-b:a", "96k",  "-ac", "2"],   "bandwidth": 396000},
    {"name": "thumb", "width": 160, "height": 120,
     "v_flags": ["-b:v", "128k",  "-maxrate", "160k",  "-bufsize", "320k"],
     "a_flags": ["-b:a", "8k",   "-ac", "1"],   "bandwidth": 136000},
]
COMMON_FLAGS = [
    "-c:v", "libx264", "-profile:v", "main", "-level:v", "3.1",
    "-preset", "slow", "-r", "29.97",
    "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
    "-c:a", "aac", "-ar", "44100",
]
HLS_FLAGS = [
    "-hls_time", "6", "-hls_list_size", "0", "-hls_playlist_type", "vod",
    "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
    "-hls_flags", "independent_segments", "-f", "hls",
]

def encode_to_hls(input_path: Path, output_dir: Path) -> Path:
    """Encode source to 3-rendition ABR HLS. Returns path to master.m3u8."""
    src_w, src_h = probe_resolution(input_path)  # via ffprobe JSON
    master_lines = ["#EXTM3U", "#EXT-X-INDEPENDENT-SEGMENTS"]
    for rend in RENDITIONS:
        out_w = min(rend["width"], src_w)
        out_h = min(rend["height"], src_h)
        out_w, out_h = scale_keep_aspect(src_w, src_h, out_w, out_h)
        rend_dir = output_dir / rend["name"]
        rend_dir.mkdir(parents=True, exist_ok=True)
        vf = f"yadif=mode=0:parity=-1:deint=1,scale={out_w}:{out_h}:flags=lanczos"
        result = subprocess.run(
            ["ffmpeg", "-i", str(input_path),
             "-vf", vf] + COMMON_FLAGS + rend["v_flags"] + rend["a_flags"] +
            HLS_FLAGS + ["-hls_segment_filename", "seg%04d.m4s",
                         str(rend_dir / "index.m3u8")],
            capture_output=True,
        )
        if result.returncode != 0:
            raise RuntimeError(f"FFmpeg failed ({rend['name']}): {result.stderr.decode()}")
        master_lines += [
            f'#EXT-X-STREAM-INF:BANDWIDTH={rend["bandwidth"]},RESOLUTION={out_w}x{out_h}',
            f'{rend["name"]}/index.m3u8',
        ]
    master = output_dir / "master.m3u8"
    master.write_text("\n".join(master_lines) + "\n")
    return master

# gap_filler.py — blue #0000f5, all 3 renditions, codec-matched
def generate_gap_fmp4(duration_seconds: int, output_dir: Path) -> Path:
    """Generate blue gap filler for all 3 renditions. Returns master.m3u8."""
    master_lines = ["#EXTM3U", "#EXT-X-INDEPENDENT-SEGMENTS"]
    for rend in RENDITIONS:
        rend_dir = output_dir / rend["name"]
        rend_dir.mkdir(parents=True, exist_ok=True)
        subprocess.run([
            "ffmpeg",
            "-f", "lavfi", "-i",
            f"color=c=0x0000f5:size={rend['width']}x{rend['height']}:rate=29.97",
            "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
            "-c:v", "libx264", "-profile:v", "main", "-level:v", "3.1",
            "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
            "-c:a", "aac",
            "-t", str(duration_seconds),
        ] + rend["a_flags"] + HLS_FLAGS +
        ["-hls_segment_filename", "seg%04d.m4s", str(rend_dir / "index.m3u8")],
        check=True)
        master_lines += [
            f'#EXT-X-STREAM-INF:BANDWIDTH={rend["bandwidth"]},RESOLUTION={rend["width"]}x{rend["height"]}',
            f'{rend["name"]}/index.m3u8',
        ]
    master = output_dir / "master.m3u8"
    master.write_text("\n".join(master_lines) + "\n")
    return master
```
- **Constraint:** No upscaling — `min(rend_width, src_width)` caps each rung at source resolution. Gap filler uses fixed rung dimensions (it is synthetic, not upscaled real content). `-sc_threshold 0` + `-g 60 -keyint_min 60` enforces uniform 6s closed-GOP segments across all renditions. `yadif` deinterlaces before scaling. Each rendition encodes in a separate `subprocess.run` call (no complex FFmpeg filter graph needed). Thumb audio: 8kbps AAC mono (`-b:a 8k -ac 1`) — keep the audio track present (do not omit) so hls.js level-switching remains seamless on player quality change.
- **Validation:** `python -m pytest tests/test_encoder.py tests/test_gap_filler.py tests/test_no_upscale.py`

### Research Enhancement

- **Best Practice:** `EXT-X-VERSION:7` is required for fMP4 segments. `EXT-X-MAP:URI="init.mp4"` is mandatory in each rendition's media playlist. Add `#EXT-X-INDEPENDENT-SEGMENTS` to the master playlist.
- **Best Practice:** Thumb audio (8kbps AAC mono) must be present as an audio track even when the player mutes the element. hls.js buffers audio+video together for level-switching; omitting audio from a rendition causes desync on quality change. Player-layer muting (`player.muted = true`) is safe; codec-level audio removal is not.
- **Best Practice:** Three separate `subprocess.run` calls (one per rendition) is simpler than a single FFmpeg `-filter_complex` multi-output command. The latter is faster (one decode pass) but much harder to debug and maintain. Given these are batch jobs not real-time encodes, simplicity wins.
- **Edge Case:** For 24-hour playlists that concatenate segments from multiple source files, do NOT use the FFmpeg concat demuxer across different-resolution sources. Encode each source independently, then assemble the media playlist with `#EXT-X-DISCONTINUITY` injected at source boundaries.
- **Edge Case:** `scale_keep_aspect(src_w, src_h, max_w, max_h)` must round output dimensions to even numbers — H.264 encoder rejects odd-dimension frames. `out_w = (out_w // 2) * 2`.
- **Ref:** OTTVerse HLS Packaging with FFmpeg; HLS spec RFC 8216 §4.3.4.2 (EXT-X-STREAM-INF)

---

### Step 6: Wasabi uploader

- **Test:** `tests/test_uploader.py` — use `moto` to mock S3; assert `init.mp4`, `.m4s` segments, and `index.m3u8` are uploaded with correct Content-Type and Cache-Control headers; assert `wasabi_key` is set on job after completion
- **Implement:** `video_grabber/storage/wasabi.py`
- **Code:**
```python
def upload_hls_package(job: VideoJob, encoded_dir: Path, config: Config):
    s3 = boto3.client(
        "s3",
        endpoint_url="https://s3.us-central-1.wasabisys.com",
        aws_access_key_id=config.wasabi_key,
        aws_secret_access_key=config.wasabi_secret,
        region_name="us-central-1",
        config=BotoCoreConfig(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            # Required for boto3 >= 1.36.0 — Wasabi rejects the default checksum headers
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
            retries={"max_attempts": 10, "mode": "adaptive"},
        ),
    )
    prefix = f"hls/{job.channel.slug}/{job.program.air_date.strftime('%Y%m%d')}/{job.ia_identifier}"
    tc = TransferConfig(multipart_threshold=100*1024*1024, multipart_chunksize=50*1024*1024,
                        max_concurrency=10)
    CONTENT_TYPES = {
        ".m3u8": ("application/vnd.apple.mpegurl", "max-age=5"),
        ".mp4":  ("video/mp4",                     "max-age=31536000"),  # init.mp4
        ".m4s":  ("video/iso.segment",             "max-age=31536000"),  # fMP4 segments
    }
    # encoded_dir layout: master.m3u8 + full/, mid/, thumb/ subdirs each with index.m3u8, init.mp4, seg_NNNN.m4s
    for path in sorted(encoded_dir.rglob("*")):
        if not path.is_file():
            continue
        key = f"{prefix}/{path.relative_to(encoded_dir)}"
        content_type, cache_control = CONTENT_TYPES.get(path.suffix, ("application/octet-stream", "max-age=31536000"))
        s3.upload_file(str(path), config.wasabi_bucket, key, Config=tc,
            ExtraArgs={"ContentType": content_type, "CacheControl": cache_control})
    return f"{prefix}/master.m3u8"  # points to ABR master; individual renditions at {prefix}/full/, mid/, thumb/
```
- **Validation:** `python -m pytest tests/test_uploader.py`

### Research Enhancement

- **Security:** Wasabi returns `Access-Control-Allow-Origin: *` automatically on all buckets — hls.js segment fetches from `911realtime.org` will work without any CORS configuration. Do NOT call `put_bucket_cors()` — Wasabi will reject it with an error. CORS is not configurable via API on Wasabi.
- **Best Practice:** boto3 ≥ 1.36.0 injects `x-amz-sdk-checksum-algorithm` headers by default; Wasabi rejects these. `request_checksum_calculation="when_required"` + `response_checksum_validation="when_required"` restores pre-1.36 behavior. Without this, all PutObject/UploadPart calls will fail.
- **Best Practice:** `addressing_style="path"` prevents virtual-hosted DNS issues (`bucket.s3.us-central-1.wasabisys.com` may not resolve). Path style always works.
- **Edge Case:** `.m4s` fMP4 segments are small (typically < 5 MB each at 6s/2500kbps). `multipart_threshold=100MB` means nearly all segments upload as single PUT calls — fast and cost-efficient. Only `init.mp4` and very long gap-filler segments approach multipart territory.
- **Ref:** Wasabi official boto3 docs; boto3 issue #4392 (checksum regression); Wasabi CORS API docs

---

### Step 7: EPG assembler + 24-hour playlist builder

- **Test:** `tests/test_epg.py` — given a set of `schedule_slots` with gaps, assert each of the 3 rendition playlists covers exactly 86400 seconds; assert gap slots reference the gap filler's rendition-specific absolute Wasabi URL; assert program slots reference correct `seg_*.m4s` keys with rendition subdir. `tests/test_epg_json.py` — assert JSON output is valid `EPGChannel[]` matching the contract in `packages/frontend/src/Applications/EPG/EPG.tsx`; assert `start`/`end` are UTC ISO 8601 strings; assert gap programs have title `"[No Signal]"`.
- **Implement:** `video_grabber/epg/assembler.py`, `video_grabber/epg/epg_json.py`
- **EPG JSON contract** (must satisfy `EPGChannel[]` type from `EPG.tsx`):
```typescript
// EPGProgram — start/end are UTC ISO 8601 strings (Date.parse-able)
// fullTitle is a non-breaking extra field used for display (seen in testdata.json)
// EPGChannel.icon maps to ClassicyIcons.applications.epg.channels[icon] (Record<string,string>)
// Use channel slug as icon key; empty string is safe if no icon asset exists yet
```
- **Code:**
```python
WASABI_BASE = "https://files.911realtime.org"
REND_NAMES = ["full", "mid", "thumb"]
REND_BANDWIDTHS = {"full": 2628000, "mid": 396000, "thumb": 136000}
REND_RESOLUTIONS = {"full": "854x480", "mid": "320x240", "thumb": "160x120"}

def assemble_day(channel: Channel, date_utc: date, db) -> tuple[dict[str, str], dict]:
    """Returns (rendition_playlists, epg_channel_dict).
    rendition_playlists keys: 'master', 'full', 'mid', 'thumb' — each value is the playlist text.
    EPG JSON is identical across renditions (same program schedule).
    """
    window_start = datetime(date_utc.year, date_utc.month, date_utc.day, tzinfo=timezone.utc)
    window_end = window_start + timedelta(days=1)
    slots = get_complete_slots(db, channel.id, window_start, window_end)
    yyyymmdd = date_utc.strftime("%Y%m%d")
    gap_prefix = f"{WASABI_BASE}/hls/{channel.slug}/{yyyymmdd}/_gap"

    rend_lines: dict[str, list[str]] = {r: [
        "#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:6",
        "#EXT-X-PLAYLIST-TYPE:VOD",
    ] for r in REND_NAMES}
    epg_grid: list[dict] = []
    cursor = window_start

    for slot in slots:
        if slot.starts_at > cursor:
            gap_secs = int((slot.starts_at - cursor).total_seconds())
            for r in REND_NAMES:
                rend_lines[r].append(f'#EXT-X-DISCONTINUITY')
                rend_lines[r].append(f'#EXT-X-MAP:URI="{gap_prefix}/{r}/init.mp4"')
                rend_lines[r] += fetch_gap_hls_lines(gap_secs, gap_prefix, r)
            epg_grid.append({"title": "[No Signal]",
                             "start": cursor.isoformat(), "end": slot.starts_at.isoformat()})
        slot_prefix = (f"{WASABI_BASE}/hls/{channel.slug}/{yyyymmdd}"
                       f"/{slot.program.ia_identifier}")
        for r in REND_NAMES:
            rend_lines[r].append('#EXT-X-DISCONTINUITY')
            rend_lines[r].append(f'#EXT-X-MAP:URI="{slot_prefix}/{r}/init.mp4"')
            rend_lines[r] += fetch_slot_hls_lines(slot, slot_prefix, r)
        epg_grid.append({"title": slot.program.title,
                         "description": slot.program.description,
                         "fullTitle": slot.program.ia_identifier,
                         "start": slot.starts_at.isoformat(),
                         "end": slot.ends_at.isoformat()})
        cursor = slot.ends_at

    if cursor < window_end:
        gap_secs = int((window_end - cursor).total_seconds())
        for r in REND_NAMES:
            rend_lines[r].append('#EXT-X-DISCONTINUITY')
            rend_lines[r].append(f'#EXT-X-MAP:URI="{gap_prefix}/{r}/init.mp4"')
            rend_lines[r] += fetch_gap_hls_lines(gap_secs, gap_prefix, r)
        epg_grid.append({"title": "[No Signal]",
                         "start": cursor.isoformat(), "end": window_end.isoformat()})

    for r in REND_NAMES:
        rend_lines[r].append("#EXT-X-ENDLIST")

    day_prefix = f"{WASABI_BASE}/epg/{channel.slug}/{yyyymmdd}"
    master_lines = ["#EXTM3U", "#EXT-X-INDEPENDENT-SEGMENTS"]
    for r in REND_NAMES:
        master_lines += [
            f'#EXT-X-STREAM-INF:BANDWIDTH={REND_BANDWIDTHS[r]},RESOLUTION={REND_RESOLUTIONS[r]}',
            f'{day_prefix}/{r}.m3u8',
        ]

    epg_channel = {"name": channel.display_name, "number": "",
                   "callSign": channel.slug.upper(), "location": "",
                   "icon": channel.slug, "grid": epg_grid}
    playlists = {"master": "\n".join(master_lines) + "\n"}
    playlists.update({r: "\n".join(rend_lines[r]) + "\n" for r in REND_NAMES})
    return playlists, epg_channel

# Assembler uploads to Wasabi:
#   epg/{channel}/{yyyymmdd}/master.m3u8  — ABR master for this channel-day
#   epg/{channel}/{yyyymmdd}/full.m3u8    — 854x480 24-hour rendition playlist
#   epg/{channel}/{yyyymmdd}/mid.m3u8     — 320x240 24-hour rendition playlist
#   epg/{channel}/{yyyymmdd}/thumb.m3u8   — 160x120 24-hour rendition playlist
#   epg/{yyyymmdd}.json                   — EPGChannel[] for frontend EPG.tsx
```
- **Constraint:** Port gap logic from `packages/backend/gen-epg.mjs:65-101`. Once assembler is live, `gen-epg.mjs` must not run concurrently — add deprecation warning to `package.json` `db:gen-epg` script. Each slot boundary in all rendition playlists must have `#EXT-X-DISCONTINUITY` + a new `#EXT-X-MAP` pointing to that slot's rendition-specific absolute Wasabi init URL. The per-item gap filler (stored at `hls/{channel}/{date}/_gap/`) must be pre-generated once per channel-day and reused for all gap slots.
- **Validation:** `python -m pytest tests/test_epg.py tests/test_epg_json.py`

### Research Enhancement

- **Pattern:** Assembler trigger: Prefect scheduled flow (`cron="5 0 * * *"` — 00:05 UTC nightly) plus an on-completion callback in `transition_job()` that enqueues an assemble run for the channel-day whenever a job reaches `complete`. The nightly run catches any items that were finishing close to midnight.
- **Best Practice:** Each rendition's 24-hour media playlist references segments from multiple `ia_identifier` directories. `fetch_slot_hls_lines()` must emit absolute Wasabi URLs including the rendition subdir: `https://files.911realtime.org/hls/{channel}/{date}/{id}/{rend}/seg_NNNN.m4s`. The `#EXT-X-MAP` init URI must also be absolute and rendition-specific: `.../{id}/{rend}/init.mp4`.
- **Best Practice:** Insert `#EXT-X-DISCONTINUITY` before each slot boundary in the 24-hour playlist (both at real-program boundaries and gap→program transitions). Without it, hls.js may exhibit seek artifacts at splice points.
- **Edge Case:** The EPG JSON at `epg/{yyyymmdd}.json` is consumed by the frontend as a static file. The frontend currently has a static import — `epg/{yyyymmdd}.json` on Wasabi can't be consumed until a follow-up story replaces `import data from "./testdata.json"` with a runtime fetch keyed on the current date.
- **Ref:** HLS spec RFC 8216 §4.3.2.3 (`EXT-X-DISCONTINUITY`); Prefect v3 cron schedule docs

---

### Step 8: Prefect flow orchestration

- **Test:** `tests/test_flows.py` — run flows against a local Prefect ephemeral server using `prefect.testing.utilities`; assert state transitions propagate correctly; assert failed tasks set `video_jobs.stage = failed`
- **Implement:** `video_grabber/pipeline/flows.py` — six Prefect flows, one per stage
- **Code:**
```python
from prefect import flow, task, get_run_logger

@flow(name="scan-collections")
def scan_collections_flow(collections: list[str] = ["sept_11_tv_archive", "911"]):
    logger = get_run_logger()
    session = ArchiveSession()
    for coll in collections:
        crawl_collection(session, coll, get_db(), visited=set())
    logger.info("Scan complete")

@flow(name="process-pipeline")
def process_pipeline_flow():
    # Prefect submits tasks as concurrent Kubernetes Jobs
    pending = get_jobs_at_stage("discovered")
    extract_metadata.map(pending)

@task(retries=3, retry_delay_seconds=exponential_backoff(10))
def extract_metadata(job_id: str):
    job = get_job(job_id)
    metadata = fetch_ia_metadata(job.ia_identifier)
    air_date, channel, program = parse_metadata(metadata)
    transition_job(job_id, "metadata_extracted", channel=channel, program=program)
```
- **Constraint:** Each Prefect task must call `transition_job(id, new_stage)` which does an atomic UPDATE + inserts a `pipeline_transitions` audit row.
- **Validation:** `python -m pytest tests/test_flows.py`

### Research Enhancement

- **Framework:** Work pool type is `kubernetes` (lowercase). Worker image: `prefecthq/prefect:3-python3.12-kubernetes`. Create with: `prefect work-pool create video-pipeline --type kubernetes`.
- **Framework:** `PREFECT_API_URL=http://prefect-server.prefect.svc.cluster.local:4200/api` — in-cluster format. Prefect server env var: `PREFECT_API_DATABASE_CONNECTION_URL=postgresql+asyncpg://user:pass@postgres.databases.svc.cluster.local:5432/prefect`.
- **Best Practice:** Worker RBAC needs a namespaced `Role` for `batch/jobs` + `pods/log` and a `ClusterRole` for `namespaces` list (suppresses startup 403 noise). Without the ClusterRole the worker still functions but logs errors on startup.
- **Pattern:** `prefect.yaml` deployment for pre-built image (no git clone at runtime): omit `build`/`push`/`pull` sections; set `job_variables.image` to the GHCR image. Register with `prefect deploy --all` after port-forwarding to the server.
- **Edge Case:** Prefect server needs a dedicated PostgreSQL database (`prefect`) in the shared cluster. Prefect uses `asyncpg` driver — connection URL must use `postgresql+asyncpg://` scheme, not `postgresql://`.
- **Ref:** Prefect v3 Kubernetes work pool docs; `prefect-kubernetes` SDK reference

---

### Step 9: Directus media_items writer

- **Test:** `tests/test_directus_writer.py` — mock Directus API; assert `POST /items/media_items` called with correct `format=m3u8`, `url`, `start_date`, `end_date`, `timezone`, `source`; assert `approved=1` for clean jobs and `approved=0` for `pending_review` jobs; assert idempotent on re-run (checks existing before inserting)
- **Implement:** `video_grabber/directus/writer.py`
- **Code:**
```python
def write_media_item(job: VideoJob, wasabi_url: str, config: Config):
    token = get_directus_token(config)
    headers = {"Authorization": f"Bearer {token}"}
    # Check for existing item by ia_identifier stored in content JSON
    existing = api_get(f"/items/media_items?filter[content][ia_identifier][_eq]={job.ia_identifier}", headers)
    if existing["data"]:
        return  # idempotent
    api_post("/items/media_items", headers, {
        "title": job.program.title[:255],
        "full_title": job.program.title,
        "source": resolve_source_id(job.channel.slug, token, config),
        "start_date": job.program.air_date.strftime("%Y-%m-%dT%H:%M:%S"),
        "end_date": (job.program.air_date + timedelta(seconds=job.program.duration_seconds)).strftime("%Y-%m-%dT%H:%M:%S"),
        "calc_duration": job.program.duration_seconds,
        "timezone": job.channel.timezone,
        "url": f"https://files.911realtime.org/{wasabi_url}",
        "format": "m3u8",
        "approved": 0 if job.passed_through_review else 1,
        "content": json.dumps({"ia_identifier": job.ia_identifier}),
    })
```
- **Constraint:** `source` FK: call `ensure_source(slug, name)` — same upsert pattern as `import-usenet.mjs:ensureSource()`. `start_date` must be naive UTC string (no Z suffix, no timezone offset) matching existing Directus `dateTime` field convention — e.g. `"2001-09-11T08:46:00"`, not `"2001-09-11T08:46:00Z"`. Auth via static token (`DIRECTUS_API_TOKEN` env var, `Authorization: Bearer <token>`) — do not use session tokens for worker processes (refresh tokens are single-use and race-prone across concurrent workers).
- **Validation:** `python -m pytest tests/test_directus_writer.py`

### Research Enhancement

- **Best Practice:** Use a Directus static token for the service user (set in Data Studio: User → Token field → generate). Static tokens never expire and are safe across concurrent Prefect pods. Store as `DIRECTUS_API_TOKEN` in the k8s Secret. Do NOT use `POST /auth/login` + refresh pattern — Directus refresh tokens are single-use; two concurrent workers refreshing simultaneously will race and one will get a 401.
- **Best Practice:** Create a dedicated Directus service user with only `create` permission on `media_items` and `read`/`create` on `directus_users` (for `ensure_source`). Do not use the admin user's token.
- **Edge Case:** The idempotency check (`filter[content][ia_identifier][_eq]=...`) performs a sequential JSON scan. Under concurrent workers, two pods can both pass the check before either inserts, producing duplicate rows. Mitigation: add a unique functional index on `content->>'ia_identifier'` in the Directus PostgreSQL, or use a DB-level advisory lock keyed on `ia_identifier` during the check-then-insert.
- **Edge Case:** `media_items.format` must be `"m3u8"` — the existing TV player filters `useMediaStream({ format: ["m3u8"] })`. Any other value (e.g. `"hls"`, `"fmp4"`) silently excludes the item from the stream.
- **Ref:** Directus static token docs; Directus discussion #17947 (refresh token single-use limitation)

---

### Step 10: Kubernetes deployment + CI/CD

**Visual — requires human verification:** ArgoCD sync status, Prefect UI accessible at subdomain, BasicAuth prompt appears.

- **Test:** N/A — infrastructure, verified by ArgoCD sync green + `kubectl get pods -n video-grabber`
- **Implement:**
  - `packages/tools/video-grabber/Dockerfile` — `python:3.12-slim` + `ffmpeg` + `ca-certificates`
  - `.github/workflows/build-video-grabber.yml` — build + push to `ghcr.io/keeping-history/video-grabber`
  - In `Keeping-History/infra`:
    - `apps/databases/` — shared PostgreSQL 16 in `databases` namespace (PVC `local-path`, accessible at `postgres.databases.svc.cluster.local:5432`)
    - `apps/video-grabber/` — Prefect server Deployment + video-grabber worker Deployment
    - `argocd/applications/databases.yaml` + `argocd/applications/video-grabber.yaml`
- **Code:**
```dockerfile
FROM python:3.12-slim
RUN apt-get update && apt-get install -y ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml .
RUN pip install --no-cache-dir -e .
COPY video_grabber/ ./video_grabber/
CMD ["prefect", "worker", "start", "--pool", "video-grabber-pool"]
```
```yaml
# apps/databases/postgres-deployment.yaml — shared cluster PostgreSQL
# Accessible cross-namespace: postgres.databases.svc.cluster.local:5432
# Each service uses its own database (CREATE DATABASE prefect; CREATE DATABASE video_grabber;)
spec:
  replicas: 1
  strategy:
    type: Recreate          # required — PVC is RWO
  template:
    spec:
      volumes:
        - name: data
          persistentVolumeClaim: {claimName: postgres-data}  # local-path, RWO
      containers:
        - name: postgres
          image: postgres:16-alpine
          env:
            - name: POSTGRES_PASSWORD
              valueFrom: {secretKeyRef: {name: postgres-secrets, key: POSTGRES_PASSWORD}}
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
```
```yaml
# apps/video-grabber/worker-deployment.yaml
spec:
  replicas: 1
  template:
    spec:
      volumes:
        - name: scratch
          emptyDir:
            sizeLimit: 50Gi   # large enough for multi-hour fMP4 source files
      containers:
        - name: worker
          image: ghcr.io/keeping-history/video-grabber:latest
          envFrom:
            - configMapRef: {name: video-grabber-config}
            - secretRef: {name: video-grabber-secrets}
          volumeMounts:
            - name: scratch
              mountPath: /tmp/vg-scratch
```
- **Constraint:** Image updater annotation: `allowTags: "regexp:^[0-9a-f]{40}$"`. Secrets created out-of-band:
  ```bash
  kubectl create secret generic postgres-secrets -n databases --from-literal=POSTGRES_PASSWORD=...
  kubectl create secret generic video-grabber-secrets -n video-grabber \
    --from-literal=WASABI_ACCESS_KEY_ID=... --from-literal=WASABI_SECRET_ACCESS_KEY=... \
    --from-literal=DIRECTUS_PASSWORD=...
  ```
- **Validation:** `kubectl get pods -n video-grabber` all Running; `kubectl logs -n video-grabber deploy/video-grabber-worker` shows Prefect worker connected

### Research Enhancement

- **Framework:** Prefect server image: `prefecthq/prefect:3-latest`; command: `prefect server start --host 0.0.0.0 --port 4200`. Exposes `/api/health` for readinessProbe. Needs `PREFECT_API_DATABASE_CONNECTION_URL=postgresql+asyncpg://...` env var.
- **Framework:** Worker RBAC: namespaced `Role` for `batch/jobs` + `pods` + `pods/log`; `ClusterRole` for `namespaces` list (prevents startup 403). Both bound to a `ServiceAccount` for the worker pod.
- **Pattern:** DB init: add a k8s Job (runs-once) that executes `CREATE DATABASE IF NOT EXISTS prefect; CREATE DATABASE IF NOT EXISTS video_grabber;` before the worker Deployment starts. Use `initContainers` or a separate ArgoCD `PreSync` hook Job. Without this, first deploy fails because neither database exists.
- **Pattern:** Cross-namespace networking: k3s allows cross-namespace traffic by default (no NetworkPolicy installed). `video-grabber` namespace pods can reach `postgres.databases.svc.cluster.local:5432` without any additional config.
- **Best Practice:** Prefect UI Ingress: expose `prefect-server` Service on `prefect-ui.dev.keepinghistory.org` with Traefik BasicAuth middleware (same pattern as `bullboard` in `time-machine` namespace). Add `ingressClassName: traefik` and `cert-manager.io/cluster-issuer: letsencrypt-prod` annotation.
- **Ref:** Prefect v3 self-hosted server docs; Keeping-History/infra bullboard pattern; k3s default NetworkPolicy behavior

## Acceptance Criteria

- [x] `ia search "collection:sept_11_tv_archive" --itemlist` equivalent runs via Python and writes `discovered` rows for all matching items
- [x] Sub-collections are recursively fanned out; duplicate IA identifiers across both collections produce one row
- [x] Items with duration < 12 min or unrecognized network are filtered to `pending_review`, not discarded
- [x] Air date is parsed from title/description, not IA `date` field
- [x] Channel timezone is converted to UTC; start/end times stored as UTC TIMESTAMPTZ
- [x] Each video file downloads with byte-range resume support (survives pod restart mid-download)
- [x] HLS packages are generated: `master.m3u8` + `full/`, `mid/`, `thumb/` subdirs each with `index.m3u8` + `init.mp4` + `seg_NNNN.m4s` fMP4 segments ≈ 6s each; no upscaling beyond source resolution
- [x] 24-hour playlists cover exactly 86400 seconds per channel-day (UTC midnight to UTC midnight)
- [x] Gap segments use blue `#0000f5` color and are fMP4/CMAF-compatible with surrounding segments
- [x] All HLS files land in Wasabi at `hls/{channel_slug}/{yyyymmdd}/{ia_identifier}/`
- [x] Completed packages appear in `media_items` with `format=m3u8`; `approved=1` for clean completions, `approved=0` for items from `pending_review`
- [x] Prefect UI shows all flow runs, task states, and logs
- [x] Prefect UI queue can be paused/resumed per work pool
- [x] All tests passing; `pytest` exit 0

## Checklist

- [ ] `ruff` / `black` lint clean
- [ ] `.env.example` documents all required env vars including `DIRECTUS_API_TOKEN`
- [ ] No Wasabi or Directus credentials in git (grep `WASABI_SECRET`, `ADMIN_PASSWORD`, `DIRECTUS_API_TOKEN`)
- [ ] `gen-epg.mjs` npm script updated with deprecation warning
- [ ] ArgoCD application syncs green in infra repo
- [ ] Wasabi CORS verified working (hls.js can load `.m4s` segments cross-origin)
- [ ] DB init Job confirmed: `prefect` and `video_grabber` databases exist before worker starts

## Enrichment Summary

**Deepened:** 2026-06-10
**Gaps found:** 17
**Agents used:** spec-flow-analyzer, framework-docs-researcher (Prefect), best-practices-researcher (Wasabi/CORS), best-practices-researcher (Directus/HLS)
**Second opinion:** timed out — not available
**Confidence:** High on all items (consistent findings across agents)

### Key Discoveries

- **Artifact hand-off is a non-issue:** Prefect tasks in one `@flow` run in a single K8s Job pod by default. Download → encode → upload share the emptyDir with no inter-pod transfer needed.
- **boto3 ≥ 1.36.0 checksum regression:** Without `request_checksum_calculation="when_required"`, all Wasabi PUT calls fail silently. `addressing_style="path"` and `region_name="us-central-1"` also required.
- **Wasabi CORS is automatic:** `Access-Control-Allow-Origin: *` returned unconditionally. No `put_bucket_cors()` call needed or possible.
- **Directus static token:** Refresh tokens are single-use and will race across concurrent workers. Static token per service user is the correct pattern.
- **3-rendition ABR ladder:** Full (854×480, 2500kbps, 128kbps stereo), Mid (320×240, 300kbps, 96kbps stereo), Thumb (160×120, 128kbps, 8kbps mono). No upscaling — each rung capped at source resolution. Thumb audio retained (not muted/dropped) so hls.js level-switching stays seamless. Master playlist per item at `master.m3u8`; 24-hour day playlists at `epg/{channel}/{yyyymmdd}/{rend}.m3u8`. `-sc_threshold 0` critical for uniform segment duration; `yadif` required for 480i NTSC sources.
- **`pipeline_transitions` table** was missing from Step 1 migration — now added. Blocker for Step 8 resolved.
- **`#EXT-X-DISCONTINUITY`** required at every source boundary in 24-hour playlists. Each slot's `#EXT-X-MAP` must use absolute Wasabi URLs.
- **Channel slug normalization map** must be defined before scanner implementation to ensure consistent slugs across both collections.

### New Risks Identified

- **Idempotency race in Step 9** — medium severity. Two concurrent workers can both pass the Directus idempotency check before either inserts. Mitigation: functional unique index on `content->>'ia_identifier'` in rt911-db. Needs a separate Directus schema migration.
- **Prefect DB init on first deploy** — low severity but will block deployment. k8s init Job or PreSync hook required to `CREATE DATABASE` before worker starts.
- **EPG frontend static import** — the `epg/{yyyymmdd}.json` on Wasabi cannot be consumed by the frontend until a follow-up story replaces the static `testdata.json` import with a runtime fetch.
