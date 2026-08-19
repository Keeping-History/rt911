---
id: 028-88df
title: Playhead advances with the clock even when a card is not playing
status: complete
priority: P1
type: fix
created: "2026-08-19T00:05:01.106Z"
updated: "2026-08-19T02:23:32.688Z"
dependencies: ["024"]
plan: plans/radio-traffic-redesign.md
plan_step: Design parity
started_at: "2026-08-19T01:59:43.785Z"
completed_at: "2026-08-19T02:23:32.687Z"
---

# Playhead advances with the clock even when a card is not playing

## Problem Statement

The scrubber position is read from the audio element, so a card with no registered element or with audio paused shows a playhead frozen at zero and drifts out of step with the virtual clock. Cards should track the clock continuously so they stay in sync, and only a deliberate user action should break that.

## Acceptance Criteria

- [x] the playhead advances with the virtual clock for a card that is not currently playing
- [x] an item continues advancing and moves to the PREVIOUS lane on schedule when untouched
- [x] using the scrubber takes the card off clock-follow so it no longer auto-advances
- [x] pausing the audio takes the card off clock-follow
- [x] a card that is following the clock shows the live position, not zero
- [x] clock-follow state is per card, not global

## Files

- packages/frontend/src/Applications/RadioTraffic/TrafficCard.tsx
- packages/frontend/src/Applications/RadioTraffic/audioCoordinator.ts

## Proof

- [x] [completeness] Completeness (Waveform scrubbing, a visible scrub bar, larger waveform, no wheel capture, and a playhead that follows the virtual clock for cards with no element at all. Merged into feat/radio-traffic-redesign; suite green at 289 files and 2989 tests.)
- [x] [feature-availability] Feature availability (All twelve acceptance criteria across the two stories are covered by tests in the merged branch.)
- [x] [robustness] Robustness (The playhead is a positions map keyed by item id rather than a field on the element entry, because most cards have no element - an UPCOMING clip has not started, a PREVIOUS one is over, a LIVE one the listener stopped was released - and those cards still have a playhead the clock can answer for. It previously read zero forever.)
- [x] [resilience] Resilience (One predicate, followsClock, is consulted by the reseek, the drift health check, the gesture retry and the clock-following playhead, so the four cannot disagree. Its two inputs are the app saying an element does not follow the clock and the coordinator recording that the listener scrubbed or stopped it.)
- [~] [security] Security (No security surface. Client-side playback positioning over already-delivered audio; no input, network or credential path.)
- [x] [defense-in-depth] Defense in depth (A scrub or a stop takes a card off clock-follow so it stays where the listener put it, while an untouched card keeps advancing and moves to PREVIOUS on schedule. The unfollowed set is the coordinator half of that predicate, because the app cannot answer for a scrub the coordinator itself performed without calling into React state on every drag frame.)
- [x] [input-validation] Input validation (seekTo routes seeking through the coordinator rather than callers writing currentTime directly, which is what keeps the cached snapshot and the element in step.)
- [~] [thread-safety] Thread safety (No concurrency surface beyond the existing coordinator singleton and its event listeners.)
- [~] [configurability] Configurability (Nothing to configure. The jump threshold and health-check interval are fixed constants ported from StationPlayer.)

## QA

Merged into feat/radio-traffic-redesign. Suite green at 289 files / 2989 tests, tsc and oxlint clean.

## Work Log

### 2026-08-19T02:00:46.551Z - Clock-follow lives in the coordinator's snapshot cache, which moved off Entry into a positions map keyed by item id — most cards have no element, so a playhead could never have been an element's property. positionMs answers, in order: the element if there is one, the clock if a watched card still follows it, the parked value otherwise. clockMoved no longer returns early on a sub-threshold delta; that early return was the only reason a card with no element sat at zero. The opt-out reuses itemFor's concept rather than competing with it: one predicate, followsClock, with two inputs — the app's itemFor (a listener-started back-catalogue clip) and the coordinator's own unfollowed set (a scrub or a pause, which the app cannot answer for because the coordinator performed it). It gates the jump reseek, the drift health check, the gesture retry and the playhead alike; removing the unfollowed check fails 8 tests across all four. Opt-outs: seekTo adds, TrafficCard's transport calls unfollowClock when it is pausing (not when resuming), ensure clears it on the creation path only.


### 2026-08-19T02:23:30.819Z - Proof completeness set PROVEN: Waveform scrubbing, a visible scrub bar, larger waveform, no wheel capture, and a playhead that follows the virtual clock for cards with no element at all. Merged into feat/radio-traffic-redesign; suite green at 289 files and 2989 tests.

### 2026-08-19T02:23:30.934Z - Proof feature-availability set PROVEN: All twelve acceptance criteria across the two stories are covered by tests in the merged branch.

### 2026-08-19T02:23:31.022Z - Proof robustness set PROVEN: The playhead is a positions map keyed by item id rather than a field on the element entry, because most cards have no element - an UPCOMING clip has not started, a PREVIOUS one is over, a LIVE one the listener stopped was released - and those cards still have a playhead the clock can answer for. It previously read zero forever.

### 2026-08-19T02:23:31.111Z - Proof resilience set PROVEN: One predicate, followsClock, is consulted by the reseek, the drift health check, the gesture retry and the clock-following playhead, so the four cannot disagree. Its two inputs are the app saying an element does not follow the clock and the coordinator recording that the listener scrubbed or stopped it.

### 2026-08-19T02:23:31.202Z - Proof security set NOT_APPLICABLE: No security surface. Client-side playback positioning over already-delivered audio; no input, network or credential path.

### 2026-08-19T02:23:31.297Z - Proof defense-in-depth set PROVEN: A scrub or a stop takes a card off clock-follow so it stays where the listener put it, while an untouched card keeps advancing and moves to PREVIOUS on schedule. The unfollowed set is the coordinator half of that predicate, because the app cannot answer for a scrub the coordinator itself performed without calling into React state on every drag frame.

### 2026-08-19T02:23:31.478Z - Proof input-validation set PROVEN: seekTo routes seeking through the coordinator rather than callers writing currentTime directly, which is what keeps the cached snapshot and the element in step.

### 2026-08-19T02:23:31.584Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface beyond the existing coordinator singleton and its event listeners.

### 2026-08-19T02:23:31.739Z - Proof configurability set NOT_APPLICABLE: Nothing to configure. The jump threshold and health-check interval are fixed constants ported from StationPlayer.

### 2026-08-19T02:23:31.912Z - Merged with 024. The playhead is keyed by item id rather than held on the element entry, so a card with no element still has a position - which is the whole point of the story.

