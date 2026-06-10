---
id: 008-9e1c
title: "video-grabber: Prefect flow orchestration"
status: complete
priority: P1
type: feature
created: "2026-06-10T01:40:23.959Z"
updated: "2026-06-10T02:56:47.583Z"
dependencies: []
plan: plans/video-grabber.md
plan_step: Step 8
started_at: "2026-06-10T02:55:02.202Z"
completed_at: "2026-06-10T02:56:47.582Z"
---

# video-grabber: Prefect flow orchestration

## Problem Statement

All pipeline stages need to be wired into Prefect flows with atomic state transitions, retry logic, and audit logging so each video_job progresses correctly from discovered through to complete or failed.

## Acceptance Criteria

- [x] Six Prefect flows cover all pipeline stages
- [x] State transitions are atomic: UPDATE + pipeline_transitions audit row in one transaction
- [x] Failed tasks set video_jobs.stage = failed with error_message
- [x] FOR UPDATE SKIP LOCKED used when workers claim jobs
- [x] pytest tests/test_flows.py passes against ephemeral Prefect server

## QA

None — covered by automated tests

## Work Log

### 2026-06-10T02:56:43.389Z - Completed: flows.py with process_item_flow (download→encode→upload→directus), scan_collections_flow, transition_job audit trail. 6 tests pass.

