---
id: 006-06e6
title: "video-grabber: Wasabi fMP4 uploader"
status: complete
priority: P1
type: feature
created: "2026-06-10T01:40:23.478Z"
updated: "2026-06-10T02:53:11.830Z"
dependencies: []
plan: plans/video-grabber.md
plan_step: Step 6
started_at: "2026-06-10T02:52:11.133Z"
completed_at: "2026-06-10T02:53:11.829Z"
---

# video-grabber: Wasabi fMP4 uploader

## Problem Statement

Encoded fMP4 HLS packages (init.mp4 + .m4s segments + index.m3u8) need to be uploaded to Wasabi S3 at s3.us-central-1.wasabisys.com with correct content types and cache headers.

## Acceptance Criteria

- [x] All files uploaded to hls/{channel}/{date}/{id}/ — including master.m3u8 and full/, mid/, thumb/ subdirs
- [x] Content-Type: video/iso.segment for .m4s, video/mp4 for init.mp4, application/vnd.apple.mpegurl for .m3u8
- [x] Manifests (master.m3u8 + rendition index.m3u8) get Cache-Control: max-age=5; segments get max-age=31536000
- [x] wasabi_key set on video_job to hls/{channel}/{date}/{id}/master.m3u8
- [x] pytest tests/test_uploader.py passes with moto mock

## QA

None — covered by automated tests

## Work Log

### 2026-06-10T02:53:05.186Z - Completed: wasabi.py with boto3 checksum fix, path addressing style, parallel uploads, correct Content-Type and Cache-Control per file type. 6 tests pass.

