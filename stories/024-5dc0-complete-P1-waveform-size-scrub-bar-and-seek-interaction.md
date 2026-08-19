---
id: 024-5dc0
title: Waveform size, scrub bar and seek interaction
status: complete
priority: P1
type: fix
created: "2026-08-18T23:45:10.120Z"
updated: "2026-08-19T02:23:32.095Z"
dependencies: []
plan: plans/radio-traffic-redesign.md
plan_step: Design parity
started_at: "2026-08-19T01:59:43.105Z"
completed_at: "2026-08-19T02:23:32.093Z"
---

# Waveform size, scrub bar and seek interaction

## Problem Statement

The waveform is too small for the enlarged player, the scrub bar is not rendered at all, clicking the waveform does not move the playhead, and the waveform captures mouse wheel events so users cannot scroll a lane with the pointer over a card.

## Acceptance Criteria

- [x] the waveform is larger, in proportion to the 1.25x player
- [x] the scrub bar is displayed on the waveform
- [x] clicking or dragging the waveform moves the playhead to that position
- [x] seeking updates the audio element position through the coordinator, not by remounting
- [x] the waveform does not capture mouse wheel events, so scrolling over a card scrolls its lane
- [x] PlaylistEditor timeline rendering is unaffected, since PeaksWaveform is shared

## Files

- packages/frontend/src/Applications/radio-core/PeaksWaveform.tsx
- packages/frontend/src/Applications/RadioTraffic/TrafficCard.tsx

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

### 2026-08-19T02:00:37.036Z - Waveform height is now an aspect-ratio (206:54, twice Figma's 27) and the canvas measures its own clientHeight, so no number in the component tree sizes the bitmap; the card's header/waveform/control bar moved from absolute positioning into flow, which is what let the waveform change height without three y-coordinates being edited to match. PeaksWaveform gained onSeekPct — pointer down plus window-level move/up, so a drag survives leaving the canvas — and TrafficCard routes it to the new audioCoordinator.seekTo. No wheel listener in either mode, and the scrubbers now stretch to their slot instead of carrying a stale pixel height that gave the overflow:hidden slot a scrollable region for the wheel to latch onto. PlaylistEditor untouched: no file of its changed, it still passes an explicit height, and passing no onSeekPct still renders the bare canvas with no handlers.


### 2026-08-19T02:23:29.893Z - Proof completeness set PROVEN: Waveform scrubbing, a visible scrub bar, larger waveform, no wheel capture, and a playhead that follows the virtual clock for cards with no element at all. Merged into feat/radio-traffic-redesign; suite green at 289 files and 2989 tests.

### 2026-08-19T02:23:30.004Z - Proof feature-availability set PROVEN: All twelve acceptance criteria across the two stories are covered by tests in the merged branch.

### 2026-08-19T02:23:30.114Z - Proof robustness set PROVEN: The playhead is a positions map keyed by item id rather than a field on the element entry, because most cards have no element - an UPCOMING clip has not started, a PREVIOUS one is over, a LIVE one the listener stopped was released - and those cards still have a playhead the clock can answer for. It previously read zero forever.

### 2026-08-19T02:23:30.226Z - Proof resilience set PROVEN: One predicate, followsClock, is consulted by the reseek, the drift health check, the gesture retry and the clock-following playhead, so the four cannot disagree. Its two inputs are the app saying an element does not follow the clock and the coordinator recording that the listener scrubbed or stopped it.

### 2026-08-19T02:23:30.333Z - Proof security set NOT_APPLICABLE: No security surface. Client-side playback positioning over already-delivered audio; no input, network or credential path.

### 2026-08-19T02:23:30.434Z - Proof defense-in-depth set PROVEN: A scrub or a stop takes a card off clock-follow so it stays where the listener put it, while an untouched card keeps advancing and moves to PREVIOUS on schedule. The unfollowed set is the coordinator half of that predicate, because the app cannot answer for a scrub the coordinator itself performed without calling into React state on every drag frame.

### 2026-08-19T02:23:30.533Z - Proof input-validation set PROVEN: seekTo routes seeking through the coordinator rather than callers writing currentTime directly, which is what keeps the cached snapshot and the element in step.

### 2026-08-19T02:23:30.626Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface beyond the existing coordinator singleton and its event listeners.

### 2026-08-19T02:23:30.723Z - Proof configurability set NOT_APPLICABLE: Nothing to configure. The jump threshold and health-check interval are fixed constants ported from StationPlayer.

### 2026-08-19T02:23:31.821Z - Merged into feat/radio-traffic-redesign at 69ca63ee, together with 028 - same scrubber subsystem, so splitting them would have meant two passes over the same files.

