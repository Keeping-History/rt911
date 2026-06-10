---
id: 001-f9f4
title: "video-grabber: project foundation + DB schema"
status: complete
priority: P1
type: feature
created: "2026-06-10T01:39:50.348Z"
updated: "2026-06-10T02:44:27.815Z"
dependencies: []
plan: plans/video-grabber.md
plan_step: Step 1
started_at: "2026-06-10T02:38:53.252Z"
completed_at: "2026-06-10T02:44:27.814Z"
---

# video-grabber: project foundation + DB schema

## Problem Statement

No packages/tools/video-grabber exists. Need Python project scaffolding and Alembic migrations for video_jobs, channels, programs, schedule_slots tables in shared PostgreSQL.

## Acceptance Criteria

- [x] packages/tools/video-grabber/ exists with pyproject.toml, Dockerfile, .env.example
- [x] Alembic migrations create all pipeline tables and pipeline_stage enum
- [x] Config loads all required env vars with defaults
- [x] pytest tests/test_config.py and tests/test_migrations.py pass

## QA

None — covered by automated tests

## Work Log

### 2026-06-10T02:44:20.569Z - Completed: pyproject.toml, Dockerfile, .env.example, config.py, Alembic migration with all 5 tables + pipeline_stage enum + 3 indexes. 17 tests pass (test_config.py + test_migrations.py).

