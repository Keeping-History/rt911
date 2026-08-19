---
id: 025-256f
title: "Card tab panels: Details layout, Transcript, and panel sizing"
status: complete
priority: P1
type: fix
created: "2026-08-18T23:45:10.178Z"
updated: "2026-08-19T00:53:51.345Z"
dependencies: []
plan: plans/radio-traffic-redesign.md
plan_step: Design parity
completed_at: "2026-08-19T00:53:51.345Z"
---

# Card tab panels: Details layout, Transcript, and panel sizing

## Problem Statement

The Details pane does not match the Figma Details Tab design, the Transcript pane shows nothing for any player, and rtCardPanel scrolls internally instead of growing to fit, leaving panels on the same row at inconsistent heights.

## Acceptance Criteria

- [x] the Details pane matches the Figma Details Tab: Call Details, Tags and Summary columns
- [x] the Transcript pane shows transcript content for a player that has subtitles
- [x] rtCardPanel does not scroll internally
- [x] rtCardPanel grows to fit its content
- [x] all panels on the same row render at the same height
- [x] an item with no metadata still renders every panel without throwing

## Files

- packages/frontend/src/Applications/RadioTraffic/tabs/
- packages/frontend/src/Applications/RadioTraffic/tabs/cardTabs.module.scss

## Proof

- [x] [completeness] Completeness (Details reworked to the three-column Call Details, Tags and Summary layout; Transcript fixed; rtCardPanel sized to content. tsc exit 0, 288 files and 2906 tests pass, oxlint 0 errors.)
- [x] [feature-availability] Feature availability (Each panel is covered behaviourally, including a no-metadata case across all five panels and three shapes of absent metadata.)
- [x] [robustness] Robustness (The empty-transcript cause was found rather than guessed: the vtt files serve correctly at HTTP 200, but positionMs returns undefined for any card with no registered audio element, so currentTimeSec was undefined and the panel asked for second 0 - which classicy activeCueText matches with two strict comparisons, and the first real cue starts at 0.800s.)
- [x] [resilience] Resilience (classicy exposes only activeCueText and no cue list, so a local VTT parser was added rather than reusing a hook that cannot answer the question. It also accepts the SRT decimal comma, so a missing vtt degrades to the srt the wire actually carries.)
- [~] [security] Security (No security surface. Client-side presentation and playback control over data already delivered; no new input, network call, credential or persistence path.)
- [x] [defense-in-depth] Defense in depth (Two layers for absent data: every panel has a real empty state, and provenance narrowing refuses shapes it does not recognise. The no-metadata suite asserts textContent is non-empty rather than merely that render did not throw.)
- [x] [input-validation] Input validation (Panel inputs are validated rather than assumed; Mentions omits empty columns and Transcript falls back when subtitles are absent.)
- [~] [thread-safety] Thread safety (No concurrency surface beyond existing React state and the coordinator singleton, neither of which this story changes.)
- [~] [configurability] Configurability (Nothing to configure. Column layout and the namespace palette are fixed by the design.)

## QA

tsc exit 0, vitest green, oxlint 0 errors. Merged into feat/radio-traffic-redesign at 289 files / 2944 tests.

## Work Log

### 2026-08-19T00:02:45.479Z - Reworked DetailsTab into Figma's three columns (Call Details / Tags / Summary); tags grouped per namespace with an Other row for unknown namespaces. Fixed the empty Transcript: root cause was currentTimeSec being undefined for any card with no registered <audio> element (audioCoordinator.positionMs), falling back to second 0, which classicy's activeCueText can never match (strict comparisons; real clips start their first cue at 0.800). The .vtt files exist and serve 200 text/vtt - not a pipeline gap. Panel now parses the VTT itself (classicy exposes no cue list) and renders the whole transcript with the playhead cue marked. Panels no longer scroll and size to content; cards level to the tallest in a wrapped row. Verified in Chromium: 3 cards on one row at 294px, 208px panels, overflow-y visible, scrollHeight == clientHeight.


### 2026-08-19T00:53:33.025Z - Proof security set NOT_APPLICABLE: No security surface. Client-side presentation and playback control over data already delivered; no new input, network call, credential or persistence path.

### 2026-08-19T00:53:33.139Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface beyond existing React state and the coordinator singleton, neither of which this story changes.

### 2026-08-19T00:53:33.421Z - Proof completeness set PROVEN: Details reworked to the three-column Call Details, Tags and Summary layout; Transcript fixed; rtCardPanel sized to content. tsc exit 0, 288 files and 2906 tests pass, oxlint 0 errors.

### 2026-08-19T00:53:33.519Z - Proof feature-availability set PROVEN: Each panel is covered behaviourally, including a no-metadata case across all five panels and three shapes of absent metadata.

### 2026-08-19T00:53:33.615Z - Proof robustness set PROVEN: The empty-transcript cause was found rather than guessed: the vtt files serve correctly at HTTP 200, but positionMs returns undefined for any card with no registered audio element, so currentTimeSec was undefined and the panel asked for second 0 - which classicy activeCueText matches with two strict comparisons, and the first real cue starts at 0.800s.

### 2026-08-19T00:53:33.744Z - Proof resilience set PROVEN: classicy exposes only activeCueText and no cue list, so a local VTT parser was added rather than reusing a hook that cannot answer the question. It also accepts the SRT decimal comma, so a missing vtt degrades to the srt the wire actually carries.

### 2026-08-19T00:53:33.850Z - Proof defense-in-depth set PROVEN: Two layers for absent data: every panel has a real empty state, and provenance narrowing refuses shapes it does not recognise. The no-metadata suite asserts textContent is non-empty rather than merely that render did not throw.

### 2026-08-19T00:53:33.964Z - Proof input-validation set PROVEN: Panel inputs are validated rather than assumed; Mentions omits empty columns and Transcript falls back when subtitles are absent.

### 2026-08-19T00:53:34.056Z - Proof configurability set NOT_APPLICABLE: Nothing to configure. Column layout and the namespace palette are fixed by the design.
