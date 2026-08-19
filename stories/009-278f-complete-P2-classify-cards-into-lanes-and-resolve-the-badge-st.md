---
id: 009-278f
title: Classify cards into lanes and resolve the badge state
status: complete
priority: P2
type: feature
created: "2026-08-18T17:23:19.844Z"
updated: "2026-08-18T18:41:52.101Z"
dependencies: ["008"]
plan: plans/radio-traffic-redesign.md
plan_step: Step 9
completed_at: "2026-08-18T18:41:52.100Z"
---

# Classify cards into lanes and resolve the badge state

## Problem Statement

Each clip is LIVE, UPCOMING or PREVIOUS relative to the virtual clock, and the card header shows one of five badge states including a drift readout derived from the gap between where the clock says we should be and where the audio element actually is.

## Acceptance Criteria

- [x] laneFor handles before, during, after, open-ended and missing end_date cases
- [x] PREVIOUS uses end <= now, matching the existing previousSegments predicate
- [x] badgeFor returns in-sync when absolute drift is at most 1s
- [x] badgeFor returns a drift badge reading -6 seconds at 6s behind
- [x] badgeFor returns seeking while a seek is in flight
- [x] badgeFor returns a countdown for UPCOMING and playing for a user-started PREVIOUS clip
- [x] a seek-in-flight signal is exposed from the MediaStream context, since none exists today
- [x] an item that ends between mp3_history snapshots still appears in PREVIOUS via a seen-items accumulator
- [x] the existing radio-core segment predicates are reused rather than re-derived
- [x] vitest run cardStatus.test.ts passes

## Files

- packages/frontend/src/Applications/RadioTraffic/cardStatus.ts
- packages/frontend/src/Applications/RadioTraffic/cardStatus.test.ts

## Proof

- [x] [completeness] Completeness (cardStatus.ts with laneFor and badgeFor, 28 tests, plus the seek signal across MediaStreamContext and MediaStreamProvider with 8 further tests. tsc -b exit 0, vitest 2508 tests pass, lint 0 errors.)
- [x] [feature-availability] Feature availability (All three lanes, all five badge states, the seek signal and the seen-items accumulator are covered by behavioural tests using fixed ISO timestamps, following the existing pure-logic test style in radio-core/stationGrouping.test.ts.)
- [x] [robustness] Robustness (The accumulator test asserts the bare gap first - that an item ending between snapshots appears in no history frame - so the reason the mechanism exists is encoded, not just its behaviour. The seek-clear is tested against mp3_history and against an empty mp3 frame, the two cases that would otherwise strand the badge.)
- [x] [resilience] Resilience (badgeFor returns Badge|null rather than inventing a state for an idle PREVIOUS card, and seeking outranks only the LIVE lane: an UPCOMING countdown comes from the clock and is already at the new instant, and a user-started PREVIOUS clip was never following the clock.)
- [~] [security] Security (No security surface. Pure client-side classification over data already delivered; no new input, no new network call, no persistence.)
- [x] [defense-in-depth] Defense in depth (The seek flag is cleared by two independent frame handlers, mp3 and mp3_history, so a seek into a silent stretch that produces no mp3 frame still resolves rather than leaving the UI stuck reading SEEKING indefinitely. The mp3 clear also sits ahead of that handler empty-batch early return, which is the same trap one level down.)
- [x] [input-validation] Input validation (Inputs are clock values and MediaItem fields. laneFor handles missing end_date and open-ended items explicitly; badgeFor takes a discriminated union return so no caller can read a field that does not apply to the returned state.)
- [~] [thread-safety] Thread safety (No concurrency surface. cardStatus is pure functions over values; the seek flag is a single React state value on an existing provider.)
- [~] [configurability] Configurability (Nothing to configure. Lane boundaries come from the shared radio-core predicates and the drift tolerance is a fixed 1s threshold matching the design.)

## QA

tsc -b exit 0, vitest 2508 passed, lint 0 errors. Seek signal and seen-items accumulator both test-locked. Merged into feat/radio-traffic-redesign, PR #442.

## Work Log

### 2026-08-18T18:41:05.263Z - Merged into feat/radio-traffic-redesign, PR #442, commit b7d49fac. Added the seek-in-flight signal that did not exist: connection-level seekInFlight on the MediaStream context, raised at the seek dispatch and cleared by the answering frame. Cleared on mp3_history as well as mp3, because mp3_history is sent on every seek even when empty and seeking into a silent stretch produces no mp3 frame at all - without that the badge would read SEEKING until the next clip hours later. Ported rememberItems/historyPool from RadioScanner so an item ending between history snapshots still reaches PREVIOUS. Two signature changes from the brief: badgeFor returns Badge|null (an idle PREVIOUS card matches no variant truthfully) and takes an optional countdown string (calcSeekSeconds clamps at 0, so time-to-start is not recoverable from the five specified args). 2508 tests pass.


### 2026-08-18T18:41:32.938Z - Proof completeness set PROVEN: cardStatus.ts with laneFor and badgeFor, 28 tests, plus the seek signal across MediaStreamContext and MediaStreamProvider with 8 further tests. tsc -b exit 0, vitest 2508 tests pass, lint 0 errors.

### 2026-08-18T18:41:33.021Z - Proof feature-availability set PROVEN: All three lanes, all five badge states, the seek signal and the seen-items accumulator are covered by behavioural tests using fixed ISO timestamps, following the existing pure-logic test style in radio-core/stationGrouping.test.ts.

### 2026-08-18T18:41:33.104Z - Proof robustness set PROVEN: The accumulator test asserts the bare gap first - that an item ending between snapshots appears in no history frame - so the reason the mechanism exists is encoded, not just its behaviour. The seek-clear is tested against mp3_history and against an empty mp3 frame, the two cases that would otherwise strand the badge.

### 2026-08-18T18:41:33.189Z - Proof resilience set PROVEN: badgeFor returns Badge|null rather than inventing a state for an idle PREVIOUS card, and seeking outranks only the LIVE lane: an UPCOMING countdown comes from the clock and is already at the new instant, and a user-started PREVIOUS clip was never following the clock.

### 2026-08-18T18:41:33.278Z - Proof security set NOT_APPLICABLE: No security surface. Pure client-side classification over data already delivered; no new input, no new network call, no persistence.

### 2026-08-18T18:41:33.446Z - Proof input-validation set PROVEN: Inputs are clock values and MediaItem fields. laneFor handles missing end_date and open-ended items explicitly; badgeFor takes a discriminated union return so no caller can read a field that does not apply to the returned state.

### 2026-08-18T18:41:33.540Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface. cardStatus is pure functions over values; the seek flag is a single React state value on an existing provider.

### 2026-08-18T18:41:33.635Z - Proof configurability set NOT_APPLICABLE: Nothing to configure. Lane boundaries come from the shared radio-core predicates and the drift tolerance is a fixed 1s threshold matching the design.

### 2026-08-18T18:41:51.513Z - Proof defense-in-depth set PROVEN: The seek flag is cleared by two independent frame handlers, mp3 and mp3_history, so a seek into a silent stretch that produces no mp3 frame still resolves rather than leaving the UI stuck reading SEEKING indefinitely. The mp3 clear also sits ahead of that handler empty-batch early return, which is the same trap one level down.
