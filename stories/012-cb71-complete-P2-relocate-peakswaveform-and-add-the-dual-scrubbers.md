---
id: 012-cb71
title: Relocate PeaksWaveform and add the dual scrubbers
status: complete
priority: P2
type: refactor
created: "2026-08-18T17:23:20.005Z"
updated: "2026-08-18T20:55:32.094Z"
dependencies: ["007"]
plan: plans/radio-traffic-redesign.md
plan_step: Step 12
completed_at: "2026-08-18T20:55:32.093Z"
---

# Relocate PeaksWaveform and add the dual scrubbers

## Problem Statement

A static peaks waveform component already exists in PlaylistEditor with the exact signature the cards need. It should be shared rather than duplicated, and extended with the two scrubbers that visualise clock-versus-audio drift.

## Acceptance Criteria

- [x] the component and its test move to a shared location
- [x] PlaylistEditor imports keep working via a re-export from the old path
- [x] the existing behaviour still passes: canvas sized from layout, redraw on resize, no-op without a 2D context
- [x] currentColor is still resolved before assigning fillStyle
- [x] peaks absent or empty renders a flat skeleton without throwing
- [x] livePct and currentPct are optional and exposed on the DOM for assertion
- [x] the scrubbers are positioned divs, not drawn into the canvas
- [x] no requestAnimationFrame, AudioContext or createMediaElementSource is introduced
- [x] vitest run PlaylistEditor and RadioTraffic suites pass

## Files

- packages/frontend/src/Applications/PlaylistEditor/PeaksWaveform.tsx
- packages/frontend/src/Applications/radio-core/PeaksWaveform.tsx

## Proof

- [x] [completeness] Completeness (PeaksWaveform relocated to radio-core with 15 tests, PlaylistEditor path reduced to a one-line re-export, scrubber styles added. tsc exit 0, vitest 2843 pass, lint 0 errors.)
- [x] [feature-availability] Feature availability (PlaylistEditor rendering proven unchanged three ways: LanePreview.tsx, PlaylistEditor.scss and usePeaksForSpan.ts are byte-identical; the component returns a fragment so with neither scrubber passed the output is the bare canvas it always was, asserted by childNodes length; and all LanePreview, PlaylistTimeline and integration suites pass untouched.)
- [x] [robustness] Robustness (Mutation verified: removing the skeleton fillRect and adding the scrubber props to the effect deps failed 3 tests, including one asserting the scrubbers move without redrawing the envelope.)
- [x] [resilience] Resilience (Deliberately no wrapper div, because this app has no global box-sizing border-box and PlaylistEditor.scss already carries a comment about a padding bug caused by exactly that. The skeleton branch is unreachable from PlaylistEditor since overlappingSpans already drops rows with missing or empty peaks.)
- [~] [security] Security (No security surface. A canvas renderer over numeric peak data already delivered; no input, no network.)
- [x] [defense-in-depth] Defense in depth (livePct and currentPct are 0..1 fractions matching radio-core existing onSeekPct and seekToPct, and are clamped, so a unit mismatch in a consumer parks the marker at a visible edge rather than drawing off-box.)
- [x] [input-validation] Input validation (Absent or empty peaks renders a flat skeleton rather than throwing or returning null; the no-2D-context path stubs getContext to null explicitly rather than relying on jsdom stderr.)
- [~] [thread-safety] Thread safety (No concurrency surface. A render-time canvas draw plus a ResizeObserver callback, both on the main thread.)
- [~] [configurability] Configurability (Nothing to configure. Bucket count and scaling are fixed by the peaks data format; height and scrubber positions are props.)

## QA

tsc exit 0, vitest 2843 passed, lint 0 errors. Merged into feat/radio-traffic-redesign, PR #442. Only failure repo-wide is basemapStyles.test.ts, pre-existing and environmental.

## Work Log

### 2026-08-18T20:12:14.567Z - Relocated PeaksWaveform + its test to Applications/radio-core/; PlaylistEditor/PeaksWaveform.tsx is now a one-line re-export so LanePreview.tsx and usePeaksForSpan.ts are untouched. Added optional livePct/currentPct as absolutely-positioned divs (radio.module.scss .peaksScrubber*), rendered from a fragment so the timeline's DOM stays a bare canvas. Empty/absent peaks now draw a flat mid-line skeleton instead of returning null. Verified: tsc -b exit 0, vitest run 268 files / 2624 tests passed, oxlint exit 0. Mutation-checked the two new behaviours (skeleton removal and adding livePct to the effect deps both fail the suite). Commit c32e7dc5, GPG good signature.

### 2026-08-18T20:19:40.319Z - Merged into feat/radio-traffic-redesign, PR #442, commit c32e7dc5. livePct and currentPct are 0..1 fractions, not 0..100 percentages, matching radio-core existing onSeekPct and seekToPct; clamped so a unit mismatch parks the marker at an edge rather than drawing off-box. Story 014 must know this. Component returns a fragment with no wrapper element, so with neither scrubber passed the output is the bare canvas PlaylistEditor always had - deliberately no wrapper div, since this app has no global box-sizing border-box and PlaylistEditor.scss already carries a comment about a padding bug from exactly that. The card must supply the positioned containing block.


### 2026-08-18T20:54:49.437Z - Proof completeness set PROVEN: PeaksWaveform relocated to radio-core with 15 tests, PlaylistEditor path reduced to a one-line re-export, scrubber styles added. tsc exit 0, vitest 2843 pass, lint 0 errors.

### 2026-08-18T20:54:49.530Z - Proof feature-availability set PROVEN: PlaylistEditor rendering proven unchanged three ways: LanePreview.tsx, PlaylistEditor.scss and usePeaksForSpan.ts are byte-identical; the component returns a fragment so with neither scrubber passed the output is the bare canvas it always was, asserted by childNodes length; and all LanePreview, PlaylistTimeline and integration suites pass untouched.

### 2026-08-18T20:54:49.947Z - Proof robustness set PROVEN: Mutation verified: removing the skeleton fillRect and adding the scrubber props to the effect deps failed 3 tests, including one asserting the scrubbers move without redrawing the envelope.

### 2026-08-18T20:54:50.035Z - Proof resilience set PROVEN: Deliberately no wrapper div, because this app has no global box-sizing border-box and PlaylistEditor.scss already carries a comment about a padding bug caused by exactly that. The skeleton branch is unreachable from PlaylistEditor since overlappingSpans already drops rows with missing or empty peaks.

### 2026-08-18T20:54:50.124Z - Proof security set NOT_APPLICABLE: No security surface. A canvas renderer over numeric peak data already delivered; no input, no network.

### 2026-08-18T20:54:50.214Z - Proof defense-in-depth set PROVEN: livePct and currentPct are 0..1 fractions matching radio-core existing onSeekPct and seekToPct, and are clamped, so a unit mismatch in a consumer parks the marker at a visible edge rather than drawing off-box.

### 2026-08-18T20:54:50.307Z - Proof input-validation set PROVEN: Absent or empty peaks renders a flat skeleton rather than throwing or returning null; the no-2D-context path stubs getContext to null explicitly rather than relying on jsdom stderr.

### 2026-08-18T20:54:50.394Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface. A render-time canvas draw plus a ResizeObserver callback, both on the main thread.

### 2026-08-18T20:54:50.485Z - Proof configurability set NOT_APPLICABLE: Nothing to configure. Bucket count and scaling are fixed by the peaks data format; height and scrubber positions are props.
