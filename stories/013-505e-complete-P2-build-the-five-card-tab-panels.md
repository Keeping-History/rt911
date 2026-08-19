---
id: 013-505e
title: Build the five card tab panels
status: complete
priority: P2
type: feature
created: "2026-08-18T17:23:20.059Z"
updated: "2026-08-18T20:55:32.544Z"
dependencies: ["007"]
plan: plans/radio-traffic-redesign.md
plan_step: Step 13
started_at: "2026-08-18T20:05:01.215Z"
completed_at: "2026-08-18T20:55:32.544Z"
---

# Build the five card tab panels

## Problem Statement

Each card exposes Details, Mentions, Parties, Transcript and Source tabs driven by the derived public fields, the tag m2m and the existing subtitle URL. 59 of 814 items have no metadata at all and must still render.

## Acceptance Criteria

- [x] Details renders start, end, duration and link plus tag chips and the subject
- [x] Mentions renders four columns from mentions.facilities, mentions.aircraft, mentions.people and topic tags
- [x] empty Mentions columns are omitted
- [x] Parties renders one column per participant with a confidence badge tracking high, medium and low
- [x] Transcript renders cues from the vtt and shows a placeholder when subtitles is absent
- [x] Source renders provenance
- [x] an item with no metadata renders all five tabs without throwing
- [x] chip colour keys off namespace since mp3_tags.color is null on every row
- [x] TranscriptTab reuses vttUrl and useQuickTimeSubtitles rather than re-parsing cues
- [x] vitest run tabs/ passes

## Files

- packages/frontend/src/Applications/RadioTraffic/tabs/

## Proof

- [x] [completeness] Completeness (Five tab panels plus shared props, timing, palette and provenance helpers, with 80 tests across 9 files. tsc exit 0, vitest 2843 pass, lint 0 errors.)
- [x] [feature-availability] Feature availability (Each panel is tested behaviourally against real ItemMeta shapes: Details timings and chips, Mentions four columns with empty ones omitted, Parties per-participant confidence badges, Transcript cue and placeholder, Source provenance.)
- [x] [robustness] Robustness (Mutation verified: forcing chipColor to ignore namespace and removing the Mentions empty-column filter failed 7 tests across 3 files.)
- [x] [resilience] Resilience (noMetadata.test.tsx renders all five panels across three distinct shapes of absent metadata - id missing from the frame, derivation over no parties, and every key present but empty - and asserts textContent is non-empty rather than merely that render did not throw, because a tab painting an empty box is a dead tab for 7 percent of the corpus.)
- [x] [security] Security (provenance is typed unknown so provenance.ts narrows at runtime and degrades to a placeholder for any other blob, tested against strings, numbers, arrays and wrong-typed sub-objects. A producer changing the shape costs a blank panel inside one card, never a thrown render.)
- [x] [defense-in-depth] Defense in depth (Two layers against bad data: every panel has a real empty state, and the runtime narrowing in provenance.ts refuses shapes it does not recognise rather than reading through them.)
- [x] [input-validation] Input validation (All five panels validate their inputs rather than assuming shape; Mentions omits empty columns; Transcript shows a placeholder when subtitles is absent.)
- [~] [thread-safety] Thread safety (No concurrency surface. Presentational components over props.)
- [~] [configurability] Configurability (Nothing to configure. The namespace palette is a fixed map and the tab set is closed.)

## QA

tsc exit 0, vitest 2843 passed, lint 0 errors. Merged into feat/radio-traffic-redesign, PR #442. Only failure repo-wide is basemapStyles.test.ts, pre-existing and environmental.

## Work Log

### 2026-08-18T20:16:37.687Z - Built the five card tab panels under Applications/RadioTraffic/tabs/ with TDD (80 tests, 9 files). Details/Mentions/Parties/Transcript/Source plus three pure modules (itemTiming, tagPalette, provenance) and cardTabs.module.scss. Chip colour keys off namespace; Mentions topics column reads topic: tags; Mentions and Parties read structured fields not tags; TranscriptTab reuses vttUrl + useQuickTimeSubtitles. noMetadata.test.tsx renders all five panels across three no-metadata shapes. Mutation-checked the namespace-palette and empty-column assertions.

### 2026-08-18T20:19:40.394Z - Merged into feat/radio-traffic-redesign, PR #442, commit 58639ad5. useQuickTimeSubtitles exposes only activeCueText(seconds), not the parsed cue list - confirmed against classicy 0.76.0 d.ts and bundle - so Transcript renders the cue at the playhead via an optional currentTimeSec prop that 014 and 016 supply, not a scrolling transcript. IMPROVEMENT: a full scrolling transcript needs classicy to export its parsed cues. provenance is typed unknown so provenance.ts narrows at runtime and degrades to a placeholder for any other blob - tested against strings, numbers, arrays and wrong-typed sub-objects, so a producer changing shape costs a blank panel in one card, never a thrown render. noMetadata.test.tsx covers five panels by three shapes of absent metadata and asserts textContent is non-empty, since a tab painting an empty box is a dead tab for 7 percent of the corpus. stationGrouping gained an additive effectiveEndMs export so Details timings and lane classification share one definition.


### 2026-08-18T20:54:50.612Z - Proof completeness set PROVEN: Five tab panels plus shared props, timing, palette and provenance helpers, with 80 tests across 9 files. tsc exit 0, vitest 2843 pass, lint 0 errors.

### 2026-08-18T20:54:50.703Z - Proof feature-availability set PROVEN: Each panel is tested behaviourally against real ItemMeta shapes: Details timings and chips, Mentions four columns with empty ones omitted, Parties per-participant confidence badges, Transcript cue and placeholder, Source provenance.

### 2026-08-18T20:54:50.795Z - Proof robustness set PROVEN: Mutation verified: forcing chipColor to ignore namespace and removing the Mentions empty-column filter failed 7 tests across 3 files.

### 2026-08-18T20:54:50.884Z - Proof resilience set PROVEN: noMetadata.test.tsx renders all five panels across three distinct shapes of absent metadata - id missing from the frame, derivation over no parties, and every key present but empty - and asserts textContent is non-empty rather than merely that render did not throw, because a tab painting an empty box is a dead tab for 7 percent of the corpus.

### 2026-08-18T20:54:50.970Z - Proof security set PROVEN: provenance is typed unknown so provenance.ts narrows at runtime and degrades to a placeholder for any other blob, tested against strings, numbers, arrays and wrong-typed sub-objects. A producer changing the shape costs a blank panel inside one card, never a thrown render.

### 2026-08-18T20:54:51.061Z - Proof defense-in-depth set PROVEN: Two layers against bad data: every panel has a real empty state, and the runtime narrowing in provenance.ts refuses shapes it does not recognise rather than reading through them.

### 2026-08-18T20:54:51.154Z - Proof input-validation set PROVEN: All five panels validate their inputs rather than assuming shape; Mentions omits empty columns; Transcript shows a placeholder when subtitles is absent.

### 2026-08-18T20:54:51.244Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface. Presentational components over props.

### 2026-08-18T20:54:51.331Z - Proof configurability set NOT_APPLICABLE: Nothing to configure. The namespace palette is a fixed map and the tab set is closed.
