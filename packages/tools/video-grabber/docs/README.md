# video-grabber

Internet Archive broadcast → HLS pipeline for the 911realtime.org TV recordings.

This package crawls the Internet Archive's 9/11 broadcast collections, downloads the best-quality source file for each candidate item, transcodes it to 3-rendition ABR HLS (CMAF/fMP4), uploads the package to Wasabi S3, and registers the finished asset with Directus. A separate **channel-stitching** tier assembles those per-program packages into one continuous, seekable HLS stream per channel across the Sep 9–18 2001 timeline, with blue "no signal" gap fillers between programs so the media timeline stays isochronous with wall-clock.

## When to use this package

You're working with video-grabber if you need to:

- Discover new IA items for the `sept_11_tv_archive` / `911` collections.
- Reprocess a job that failed mid-pipeline.
- Regenerate a channel's day-of EPG and HLS playlists.
- Diagnose why an HLS stream plays incorrectly (gap encoding, master playlist, S3 cache headers).
- Promote a `pending_review` item to `complete` after manually classifying the channel.

## Quick start

Local development is Python 3.12+ with ffmpeg installed system-wide.

```bash
cd packages/tools/video-grabber
cp .env.example .env       # fill in Wasabi + Directus credentials
pip install -e ".[dev]"
pytest                     # all components mock IA/S3/Directus — no live deps
```

Run a Prefect worker against a deployed server:

```bash
export PREFECT_API_URL=http://localhost:4200/api
prefect worker start --pool video-grabber-pool
```

## Document index

- [Architecture overview](./architecture.md) — components, end-to-end flow, why the boundaries are where they are.
- [Pipeline stages](./pipeline.md) — the Prefect flows (scan, process-item, dispatch, build-channel) and the `pipeline_stage` state machine.
- [Data model](./data-model.md) — Postgres tables, the `pipeline_stage` enum, and the audit log.
- [Module guide](./modules.md) — per-package responsibilities (`ia`, `video`, `storage`, `directus`).
- [EPG assembler](./epg.md) — HLS playlist + EPG JSON mechanics (discontinuities, gap inserts, master playlist).
- [Channel stitching](./channel-stitching.md) — continuous per-channel streams: scheduler, isochronous timeline, `PROGRAM-DATE-TIME`, gap package, `build-channel` flow.
- [Deployment](./deployment.md) — Kubernetes manifests, Docker image, ArgoCD pre-sync.
- [Configuration](./configuration.md) — environment variables, secrets, ConfigMap.
- [Runbook](./runbook.md) — common ops: rescan, retry, manual review, broken playlists.
- [Testing](./testing.md) — test layout and the mocking strategy.

## Status

`v0.1.0`. Schema migration `001_initial_schema` is the only revision; the pipeline writes to Directus' `media_items` collection, which already exists in the rt911 instance.
