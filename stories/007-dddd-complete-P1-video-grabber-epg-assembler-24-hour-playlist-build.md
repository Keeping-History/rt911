---
id: 007-dddd
title: "video-grabber: EPG assembler + 24-hour playlist builder"
status: complete
priority: P1
type: feature
created: "2026-06-10T01:40:23.717Z"
updated: "2026-06-10T02:55:01.900Z"
dependencies: []
plan: plans/video-grabber.md
plan_step: Step 7
started_at: "2026-06-10T02:53:12.166Z"
completed_at: "2026-06-10T02:55:01.899Z"
---

# video-grabber: EPG assembler + 24-hour playlist builder

## Problem Statement

Need to assemble one 24-hour HLS VOD playlist per channel per UTC day, filling gaps between programs with the blue #0000f5 fMP4 placeholder. Output covers exactly 86400 seconds.

## Acceptance Criteria

- [x] All 3 rendition playlists (full/mid/thumb) cover exactly 86400 seconds each
- [x] Per-day master playlist at epg/{channel}/{yyyymmdd}/master.m3u8 references full.m3u8, mid.m3u8, thumb.m3u8 with correct BANDWIDTH and RESOLUTION attributes
- [x] Gap slots reference blue placeholder fMP4 rendition-specific absolute Wasabi URLs; each slot boundary has #EXT-X-DISCONTINUITY + rendition-specific #EXT-X-MAP
- [x] `EPGChannel[]` JSON output matches `EPG.tsx` contract: `start`/`end` as UTC ISO 8601, gap programs titled `"[No Signal]"`, `fullTitle` field included
- [x] EPG JSON uploaded to Wasabi at `epg/{yyyymmdd}.json`
- [x] pytest tests/test_epg.py and tests/test_epg_json.py pass

## QA

None — covered by automated tests

## Work Log

### 2026-06-10T02:54:27.045Z - Completed: assembler.py with 24-hour playlist builder, gap filling, EXT-X-DISCONTINUITY+MAP at every boundary, EPG JSON output. 12 tests pass.

