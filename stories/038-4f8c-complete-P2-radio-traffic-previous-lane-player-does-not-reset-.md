---
id: 038-4f8c
title: Radio Traffic Previous Lane player does not reset when manual playback finishes
status: complete
priority: P2
type: fix
created: "2026-08-19T01:35:58.730Z"
updated: "2026-08-19T02:39:43.495Z"
dependencies: []
started_at: "2026-08-19T02:23:50.066Z"
completed_at: "2026-08-19T02:39:43.494Z"
---

# Radio Traffic Previous Lane player does not reset when manual playback finishes

## Problem Statement

Clicking Play on a card in the Previous Lane starts audio, but when the clip reaches its end the player stays in the playing state indefinitely. It never handles playback completion, so the card keeps showing playing chrome and cannot be replayed cleanly.

## Acceptance Criteria

- [x] Reaching the end of a manually played Previous Lane clip returns the card to its idle state
- [x] Play/pause control reverts to the play affordance and progress resets
- [x] The same clip can be played again immediately after it finishes
- [x] Manually stopping playback before the end resets the card the same way

## Files

- packages/frontend/src

## Proof

- [x] [completeness] Completeness (A finished or manually stopped PREVIOUS clip returns to idle. Merged; suite green at 291 files and 3076 tests.)
- [x] [feature-availability] Feature availability (TDD was genuine - 2 red in toolMode.test.ts and 15 red across audioCoordinator and TrafficCard before any implementation.)
- [x] [robustness] Robustness (Mutation-checked: dropping unfollowed.delete from resetPlayback fails the test that hands a scrubbed card back to the clock.)
- [x] [resilience] Resilience (resetPlayback clears the element, the unfollowed-clock opt-out and the cached playhead, in that order. Order is load-bearing: the element must go before the playhead is resampled or the resample reads the element position straight back in. Clearing the opt-out is the subtle part - a listener who scrubbed took the card off clock-follow, and that outlives both the element and the card, so a reset that dropped only the element would freeze the card on their parked playhead for the rest of the session.)
- [~] [security] Security (No security surface. Client-side playback state and badge rendering over already-delivered audio and metadata.)
- [x] [defense-in-depth] Defense in depth (The end-of-clip hand-back is latched in a ref because the shell action is a toggle - a second call would stop the clip and immediately restart it.)
- [x] [input-validation] Input validation (A LIVE card still parks where it was stopped rather than resetting, preserving story 028.)
- [~] [thread-safety] Thread safety (No concurrency surface beyond the existing coordinator singleton and React state.)
- [~] [configurability] Configurability (Nothing to configure. Reset is unconditional once a clip ends or is stopped.)

## QA

Merged into feat/radio-traffic-redesign. Suite green at 291 files / 3076 tests, tsc and oxlint clean. Behaviour mutation-checked.

## Work Log

### 2026-08-19T02:30:55.451Z - TDD on branch story/playback-fixes (a8778473). RED first: 15 failing tests across audioCoordinator.test.ts and TrafficCard.test.tsx. audioCoordinator gained hasEnded() and resetPlayback(); resetPlayback releases the element, clears the unfollowed-clock opt-out and drops the parked playhead, so a finished or stopped clip is indistinguishable from one never played. TrafficCard subscribes to hasEnded through the existing subscription and hands the clip back once (ref latch, since the shell action is a toggle); the transport does the same reset for a PREVIOUS card while a LIVE card still parks where it was stopped (story 028). Full suite 290 files / 3055 tests green; tsc -b and oxlint clean.


### 2026-08-19T02:39:21.757Z - Proof security set NOT_APPLICABLE: No security surface. Client-side playback state and badge rendering over already-delivered audio and metadata.

### 2026-08-19T02:39:21.912Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface beyond the existing coordinator singleton and React state.

### 2026-08-19T02:39:23.174Z - Proof completeness set PROVEN: A finished or manually stopped PREVIOUS clip returns to idle. Merged; suite green at 291 files and 3076 tests.

### 2026-08-19T02:39:23.334Z - Proof feature-availability set PROVEN: TDD was genuine - 2 red in toolMode.test.ts and 15 red across audioCoordinator and TrafficCard before any implementation.

### 2026-08-19T02:39:23.507Z - Proof robustness set PROVEN: Mutation-checked: dropping unfollowed.delete from resetPlayback fails the test that hands a scrubbed card back to the clock.

### 2026-08-19T02:39:23.660Z - Proof resilience set PROVEN: resetPlayback clears the element, the unfollowed-clock opt-out and the cached playhead, in that order. Order is load-bearing: the element must go before the playhead is resampled or the resample reads the element position straight back in. Clearing the opt-out is the subtle part - a listener who scrubbed took the card off clock-follow, and that outlives both the element and the card, so a reset that dropped only the element would freeze the card on their parked playhead for the rest of the session.

### 2026-08-19T02:39:23.822Z - Proof defense-in-depth set PROVEN: The end-of-clip hand-back is latched in a ref because the shell action is a toggle - a second call would stop the clip and immediately restart it.

### 2026-08-19T02:39:23.965Z - Proof input-validation set PROVEN: A LIVE card still parks where it was stopped rather than resetting, preserving story 028.

### 2026-08-19T02:39:24.145Z - Proof configurability set NOT_APPLICABLE: Nothing to configure. Reset is unconditional once a clip ends or is stopped.

### 2026-08-19T02:39:43.275Z - Merged at a8778473 with 039.

