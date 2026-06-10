---
id: 004-3857
title: "video-grabber: resumable download worker"
status: complete
priority: P1
type: feature
created: "2026-06-10T01:39:51.100Z"
updated: "2026-06-10T02:50:31.602Z"
dependencies: []
plan: plans/video-grabber.md
plan_step: Step 4
started_at: "2026-06-10T02:49:22.404Z"
completed_at: "2026-06-10T02:50:31.602Z"
---

# video-grabber: resumable download worker

## Problem Statement

IA source files can be several GB. Need byte-range resumable HTTP download so Kubernetes pod restarts mid-download do not require restarting from zero.

## Acceptance Criteria

- [x] Download uses HTTP Range header to resume from bytes_downloaded offset
- [x] bytes_downloaded updated in video_jobs during streaming
- [x] State transitions correctly: downloading -> downloaded
- [x] 503 from IA triggers tenacity exponential backoff retry
- [x] pytest tests/test_downloader.py passes with mocked IA endpoint

## QA

None — covered by automated tests

## Work Log

### 2026-06-10T02:50:26.835Z - Completed: downloader.py with byte-range resume, select_best_file (mp4>mpg>ogv priority), httpx streaming. 9 tests pass.

