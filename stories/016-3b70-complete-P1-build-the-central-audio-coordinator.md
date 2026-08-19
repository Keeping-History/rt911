---
id: 016-3b70
title: Build the central audio coordinator
status: complete
priority: P1
type: feature
created: "2026-08-18T17:23:39.095Z"
updated: "2026-08-18T19:43:19.895Z"
dependencies: ["009"]
plan: plans/radio-traffic-redesign.md
plan_step: Step 16
started_at: "2026-08-18T19:37:23.957Z"
completed_at: "2026-08-18T19:43:19.893Z"
---

# Build the central audio coordinator

## Problem Statement

Cards mount and unmount for reasons unrelated to media - filter toggles, lane migration, drag reorder - so if audio element lifetime follows component lifetime, playback and clock sync become probabilistic. Playback must be owned centrally with cards as views.

## Acceptance Criteria

- [x] elements are keyed by item id and survive their card unmounting
- [x] ensure(itemId, url) is idempotent
- [x] release(itemId) pauses before dropping the element, since removing it from the DOM does not stop playback
- [x] autoplay retry listeners are registered once for the whole app, not per card
- [x] the retry path drives the existing audioBlocked token store
- [x] a clock jump over 5s reseeks every registered element
- [x] the 15s drift health-check iterates the registry rather than component refs
- [x] currentTime is readable for a card that is not currently rendered
- [x] vitest run audioCoordinator.test.ts passes

## Files

- packages/frontend/src/Applications/RadioTraffic/audioCoordinator.ts

## Proof

- [x] [completeness] Completeness (audioCoordinator.ts with ensure, release, positionMs, subscribe and a ClockSource seam; 37 tests in audioCoordinator.test.ts. tsc -b exit 0, vitest 2545 tests pass, lint 0 errors.)
- [x] [feature-availability] Feature availability (Criteria 1 and 8 are proven by rendering a stand-in Card that calls ensure in an effect, unmounting it, then asserting after unmount: ensure returns the same element object by identity, pause was never called during unmount, and positionMs still reads live values set after the unmount.)
- [x] [robustness] Robustness (Four mutations each failed the owning test: registry.delete moved before el.pause, jump and health thresholds inflated, global gesture listeners disabled, and gesture listeners moved into ensure to make them per-card. The ordering test spies pause with an implementation recording whether positionMs was still defined at the moment pause fired, so it asserts ordering rather than mere occurrence.)
- [x] [resilience] Resilience (release pauses before dropping, because removing an audio element from the DOM does not stop browser playback - dropping the entry first would leak audio with no handle to stop it. Both reseek paths have card-is-not-rendered variants, so an unmounted element is still corrected by the jump reseek and the 15s health check.)
- [~] [security] Security (No security surface. Client-side playback ownership over URLs already delivered by the streamer; no new input, no new network call, no persistence, no credentials.)
- [x] [defense-in-depth] Defense in depth (itemFor returning undefined means this element does not follow the clock, and reseek, health check and gesture retry all skip it. That is a second guard beyond ownership: without it a faithful port of StationPlayer gesture retry would restart any clip the listener had paused, on their next click anywhere on the desktop. StationPlayer never needed the guard because it had no back-catalogue playback.)
- [x] [input-validation] Input validation (ensure is idempotent so a repeated call cannot create a duplicate element for one id, and calcSeekSeconds is reused from radio-core rather than re-derived, so the seek arithmetic cannot diverge from the app it replaces.)
- [x] [thread-safety] Thread safety (Gesture-retry listeners are registered exactly once for the whole app rather than per card, which the per-card mutation test pins. Around ten cards each registering three document-level capture listeners would be thirty global listeners firing on every interaction.)
- [~] [configurability] Configurability (Nothing to configure. The 5s jump threshold and 15s health interval are fixed constants ported from StationPlayer; the ClockSource is a wiring seam, not a tunable.)

## QA

tsc exit 0, vitest 2545 passed, lint 0 errors. Criteria 1 and 8 proven post-unmount by element identity and live position reads. Four mutations verified the tests. radio-core untouched. PR #442.

## Work Log

### 2026-08-18T19:37:36.272Z - Implemented packages/frontend/src/Applications/RadioTraffic/audioCoordinator.ts + audioCoordinator.test.ts on branch story/016-audio-coordinator (from feat/radio-traffic-redesign). TDD: 37 tests written first, verified RED (module absent), then GREEN. Module-level registry of detached HTMLAudioElements keyed by item id; ensure/release/positionMs/subscribe plus connectClock/clockMoved/releaseAll. release() removes its own pause listener, pauses, then drops the entry. Gesture-retry listeners (click/keydown/pointerdown, capture) registered once at module load, driving radio-core/audioBlocked with the element itself as token. 15s drift health-check and >5s jump reseek ported from StationPlayer, iterating the registry and reusing radio-core/stationGrouping calcSeekSeconds. StationPlayer.tsx and radio-core untouched. Mutation-tested each key criterion: reordering pause/delete, widening the jump threshold, lengthening the health-check interval, and moving the gesture listeners into ensure() each fail the corresponding test. Full frontend suite 264 files / 2545 tests pass; tsc -b clean; oxlint exit 0.

### 2026-08-18T19:42:39.529Z - Merged into feat/radio-traffic-redesign, PR #442, commit 51d44779. radio-core verified byte-identical to base - StationPlayer and everything RadioTuner depends on untouched. Extended the pinned API with a ClockSource seam the shell installs once: nowMs, clockPaused, itemFor, connectClock, clockMoved. The reseek and health check need start_date and jump for calcSeekSeconds and ensure carries neither, so the alternative was a second item catalogue inside the coordinator; itemFor reads the map story 009 rememberItems already maintains, keeping one source of item truth. itemFor returning undefined is load-bearing: it means this element does not follow the clock, and reseek, health check and gesture retry all skip it - that is how a listener-started PREVIOUS clip opts out. Without it a faithful port of StationPlayer gesture retry would restart any paused clip on the next click anywhere on the desktop. Four mutations verified the tests.


### 2026-08-18T19:43:09.030Z - Proof completeness set PROVEN: audioCoordinator.ts with ensure, release, positionMs, subscribe and a ClockSource seam; 37 tests in audioCoordinator.test.ts. tsc -b exit 0, vitest 2545 tests pass, lint 0 errors.

### 2026-08-18T19:43:09.122Z - Proof feature-availability set PROVEN: Criteria 1 and 8 are proven by rendering a stand-in Card that calls ensure in an effect, unmounting it, then asserting after unmount: ensure returns the same element object by identity, pause was never called during unmount, and positionMs still reads live values set after the unmount.

### 2026-08-18T19:43:09.214Z - Proof robustness set PROVEN: Four mutations each failed the owning test: registry.delete moved before el.pause, jump and health thresholds inflated, global gesture listeners disabled, and gesture listeners moved into ensure to make them per-card. The ordering test spies pause with an implementation recording whether positionMs was still defined at the moment pause fired, so it asserts ordering rather than mere occurrence.

### 2026-08-18T19:43:09.320Z - Proof resilience set PROVEN: release pauses before dropping, because removing an audio element from the DOM does not stop browser playback - dropping the entry first would leak audio with no handle to stop it. Both reseek paths have card-is-not-rendered variants, so an unmounted element is still corrected by the jump reseek and the 15s health check.

### 2026-08-18T19:43:09.414Z - Proof security set NOT_APPLICABLE: No security surface. Client-side playback ownership over URLs already delivered by the streamer; no new input, no new network call, no persistence, no credentials.

### 2026-08-18T19:43:09.506Z - Proof defense-in-depth set PROVEN: itemFor returning undefined means this element does not follow the clock, and reseek, health check and gesture retry all skip it. That is a second guard beyond ownership: without it a faithful port of StationPlayer gesture retry would restart any clip the listener had paused, on their next click anywhere on the desktop. StationPlayer never needed the guard because it had no back-catalogue playback.

### 2026-08-18T19:43:09.601Z - Proof input-validation set PROVEN: ensure is idempotent so a repeated call cannot create a duplicate element for one id, and calcSeekSeconds is reused from radio-core rather than re-derived, so the seek arithmetic cannot diverge from the app it replaces.

### 2026-08-18T19:43:09.714Z - Proof thread-safety set PROVEN: Gesture-retry listeners are registered exactly once for the whole app rather than per card, which the per-card mutation test pins. Around ten cards each registering three document-level capture listeners would be thirty global listeners firing on every interaction.

### 2026-08-18T19:43:09.807Z - Proof configurability set NOT_APPLICABLE: Nothing to configure. The 5s jump threshold and 15s health interval are fixed constants ported from StationPlayer; the ClockSource is a wiring seam, not a tunable.
