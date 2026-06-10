---
id: 009-513c
title: "video-grabber: Directus media_items writer"
status: complete
priority: P2
type: feature
created: "2026-06-10T01:40:24.199Z"
updated: "2026-06-10T02:57:37.641Z"
dependencies: []
plan: plans/video-grabber.md
plan_step: Step 9
started_at: "2026-06-10T02:56:47.873Z"
completed_at: "2026-06-10T02:57:37.640Z"
---

# video-grabber: Directus media_items writer

## Problem Statement

Completed HLS packages need to be registered in the existing rt911 media_items table via Directus REST API. Items that completed all pipeline stages cleanly are auto-approved; items that passed through pending_review remain unapproved for manual triage.

## Acceptance Criteria

- [x] POST /items/media_items called with correct format=m3u8, url, start_date, end_date, timezone, source; approved=1 for clean completions, approved=0 for pending_review items
- [x] Idempotent: checks for existing ia_identifier in content JSON before inserting
- [x] source FK resolved via ensure_source upsert matching import-usenet.mjs pattern
- [x] start_date stored as naive UTC string (no Z suffix) matching Directus dateTime convention
- [x] pytest tests/test_directus_writer.py passes with mocked Directus API

## QA

None — covered by automated tests

## Work Log

### 2026-06-10T02:57:37.454Z - Completed: writer.py with static token auth, idempotency check, approved flag, naive UTC start_date, source FK resolution. 5 tests pass.

