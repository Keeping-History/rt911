---
id: 003-791a
title: "video-grabber: metadata extractor"
status: complete
priority: P1
type: feature
created: "2026-06-10T01:39:50.850Z"
updated: "2026-06-10T02:49:18.716Z"
dependencies: []
plan: plans/video-grabber.md
plan_step: Step 3
started_at: "2026-06-10T02:45:51.691Z"
completed_at: "2026-06-10T02:49:18.715Z"
---

# video-grabber: metadata extractor

## Problem Statement

IA item date field is upload date, not air date. Need to parse actual air date, channel name, program title, and timezone from IA title/description fields, then convert to UTC.

## Acceptance Criteria

- [x] Air date parsed from title/description using ported seed.mjs parseTitleDate patterns
- [x] Channel slug normalized from creator/subject/title
- [x] Timezone resolved per-item; falls back to America/New_York when absent
- [x] All datetimes stored as UTC TIMESTAMPTZ
- [x] pytest tests/test_metadata.py passes against 20+ real IA title fixtures

## QA

None — covered by automated tests

## Work Log

### 2026-06-10T02:49:14.740Z - Completed: metadata.py with named-group regex patterns ported from seed.mjs, timezone resolution map (EDT/CDT/PDT/BST/etc), channel slug extraction, duration extraction. 27 tests pass.

