---
id: 042-21e4
title: Radio Traffic in-sync badge should tolerate drift with hysteresis before showing an offset
status: complete
priority: P2
type: fix
created: "2026-08-19T01:59:31.542Z"
updated: "2026-08-19T02:39:46.465Z"
dependencies: []
started_at: "2026-08-19T02:23:52.589Z"
completed_at: "2026-08-19T02:39:46.464Z"
---

# Radio Traffic in-sync badge should tolerate drift with hysteresis before showing an offset

## Problem Statement

For live cards the badge flips between In sync and a small drift value such as -1s on almost every timeupdate (~4Hz), producing constant flicker. IN_SYNC_TOLERANCE_MS is currently 1000 at cardStatus.ts:29. Widening it alone still flickers when drift hovers at the boundary, so a hysteresis pair is needed. Note the badge label is In sync, not LIVE.

## Acceptance Criteria

- [x] Badge stays In sync while absolute drift is within the wider enter threshold
- [x] Badge switches to the drift offset once absolute drift exceeds the enter threshold
- [x] Once showing an offset the badge only returns to In sync when drift falls below a lower exit threshold, so drift hovering at the boundary does not flicker
- [x] badgeFor is currently a pure stateless function; hysteresis needs the previous badge, so either pass the previous kind in as an argument or hold it in TrafficCard - decide and document which
- [x] The existing test at cardStatus.test.ts:167-182 pins a continuous handoff from in-sync to a 1s drift; a wider deadband necessarily makes the first number shown larger, so that test must be deliberately rewritten rather than deleted
- [x] Unit tests cover the enter threshold, the exit threshold, and drift oscillating between them in both directions

## Files

- packages/frontend/src/Applications/RadioTraffic/cardStatus.ts
- packages/frontend/src/Applications/RadioTraffic/cardStatus.test.ts

## Related

- 041-48b5

## Proof

- [x] [completeness] Completeness (The deadband is engaged in the running app, not just implemented. Merged; suite green at 291 files and 3076 tests.)
- [x] [feature-availability] Feature availability (The pre-existing handoff test was rewritten rather than deleted, still pinning a gapless handoff at the new edge with a comment explaining why the number moved, plus a mirror test for the exit edge and an oscillation sweep asserting exactly two flips in both directions.)
- [x] [robustness] Robustness (previousKind is an argument rather than module state, so the whole deadband is testable as a pure function of drift and previous kind - no React, no fake timers, no per-card entry that nothing evicts, and no order-dependence between two cards test cases.)
- [x] [resilience] Resilience (The card holds the history in a ref written in an effect rather than during render, so badgeFor sees the value from the previous committed render rather than one this render already moved.)
- [~] [security] Security (No security surface. Client-side playback state and badge rendering over already-delivered audio and metadata.)
- [x] [defense-in-depth] Defense in depth (Exit keeps the original 1s figure, so the badge means exactly what it always did and is only harder to dislodge.)
- [x] [input-validation] Input validation (Anything that is not already a drift badge - the first tick, a card leaving SEEKING, a card just started - must clear the wide edge to become one.)
- [~] [thread-safety] Thread safety (No concurrency surface beyond the existing coordinator singleton and React state.)
- [x] [configurability] Configurability (Both edges are named constants, DRIFT_ENTER_MS and DRIFT_EXIT_MS, documented together with why one threshold flickers by construction.)

## QA

Merged into feat/radio-traffic-redesign. Suite green at 291 files / 3076 tests, tsc and oxlint clean. Behaviour mutation-checked.

## Work Log

### 2026-08-19T02:18:56.655Z - Replaced the single IN_SYNC_TOLERANCE_MS=1000 with an asymmetric deadband: DRIFT_ENTER_MS=3000 to leave in-sync, DRIFT_EXIT_MS=1000 to return. DECISION: previous badge kind is passed IN as BadgeArgs.previousKind rather than held in cardStatus - keeps badgeFor pure and testable in isolation, no per-card state to leak, no order-dependence between tests. TrafficCard still needs a one-line useRef to feed it; that file is off-limits this pass and is reported for sequencing. The test at cardStatus.test.ts:167-182 was rewritten to pin the handoff at the new 3s edge (-3s at 3001ms) rather than deleted; a matching test pins the exit handoff at -1s/1000ms. Oscillation is covered by feeding badgeFor's own output back in and asserting exactly two flips per sweep, both directions. Commit 25853a6a.

### 2026-08-19T02:28:29.561Z - Deadband implemented and tested as a pure function - DRIFT_ENTER_MS 3000, DRIFT_EXIT_MS 1000, previous kind passed in as a BadgeArgs argument so badgeFor stays pure and testable without React or fake timers. The rewritten test at cardStatus.test.ts still pins a gapless handoff, now at the new edge, with a mirror test for the exit edge and an oscillation sweep asserting exactly two flips. NOT YET WIRED: TrafficCard.tsx must hold a ref feeding previousKind, so in the running app the asymmetry is currently inert. That file is held by another agent this round; applying the delta is the remaining work.


### 2026-08-19T02:39:22.723Z - Proof security set NOT_APPLICABLE: No security surface. Client-side playback state and badge rendering over already-delivered audio and metadata.

### 2026-08-19T02:39:23.006Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface beyond the existing coordinator singleton and React state.

### 2026-08-19T02:39:26.665Z - Proof completeness set PROVEN: The deadband is engaged in the running app, not just implemented. Merged; suite green at 291 files and 3076 tests.

### 2026-08-19T02:39:26.796Z - Proof feature-availability set PROVEN: The pre-existing handoff test was rewritten rather than deleted, still pinning a gapless handoff at the new edge with a comment explaining why the number moved, plus a mirror test for the exit edge and an oscillation sweep asserting exactly two flips in both directions.

### 2026-08-19T02:39:26.937Z - Proof robustness set PROVEN: previousKind is an argument rather than module state, so the whole deadband is testable as a pure function of drift and previous kind - no React, no fake timers, no per-card entry that nothing evicts, and no order-dependence between two cards test cases.

### 2026-08-19T02:39:27.086Z - Proof resilience set PROVEN: The card holds the history in a ref written in an effect rather than during render, so badgeFor sees the value from the previous committed render rather than one this render already moved.

### 2026-08-19T02:39:27.238Z - Proof defense-in-depth set PROVEN: Exit keeps the original 1s figure, so the badge means exactly what it always did and is only harder to dislodge.

### 2026-08-19T02:39:27.408Z - Proof input-validation set PROVEN: Anything that is not already a drift badge - the first tick, a card leaving SEEKING, a card just started - must clear the wide edge to become one.

### 2026-08-19T02:39:27.567Z - Proof configurability set PROVEN: Both edges are named constants, DRIFT_ENTER_MS and DRIFT_EXIT_MS, documented together with why one threshold flickers by construction.

### 2026-08-19T02:39:43.206Z - Landed in c655e40e. The deadband was implemented and tested by the badge agent but inert in the running app because nothing passed previousKind; TrafficCard now carries it in a ref written in an effect rather than during render, so badgeFor reads the previous committed render rather than one this render already moved.

