---
id: 002-9cb7
title: "video-grabber: IA collection scanner"
status: complete
priority: P1
type: feature
created: "2026-06-10T01:39:50.599Z"
updated: "2026-06-10T02:45:48.715Z"
dependencies: []
plan: plans/video-grabber.md
plan_step: Step 2
started_at: "2026-06-10T02:44:30.963Z"
completed_at: "2026-06-10T02:45:48.715Z"
---

# video-grabber: IA collection scanner

## Problem Statement

Need to recursively crawl sept_11_tv_archive and 911 IA collections, fan out sub-collections, filter by duration >= 12 min + network name, and write discovered rows to video_jobs with deduplication.

## Acceptance Criteria

- [x] Recursive fan-out handles sub-collections with visited-set cycle prevention
- [x] Items outside Sep 9-17 2001 UTC are excluded
- [x] Duration < 12 min or unrecognized network go to pending_review stage
- [x] ia_identifier is unique; re-scans do not create duplicate rows
- [x] pytest tests/test_scanner.py passes

## QA

None — covered by automated tests

## Work Log

### 2026-06-10T02:45:44.436Z - Completed: scanner.py with recursive crawl, visited-set cycle prevention, is_candidate(), upsert_job() with pending_review for unknown networks. channel_map.py with canonical slug map + local callsign regex. 12 tests pass.

