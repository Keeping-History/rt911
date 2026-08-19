---
id: 041-48b5
title: Radio Traffic cards should indicate silence with dimmed chrome and a SILENCE badge
status: complete
priority: P3
type: feature
created: "2026-08-19T01:58:50.676Z"
updated: "2026-08-19T02:39:44.035Z"
dependencies: []
plan: plans/radio-traffic-silence-badge.md
plan_step: Steps 1-4
started_at: "2026-08-19T02:23:52.346Z"
completed_at: "2026-08-19T02:39:44.034Z"
---

# Radio Traffic cards should indicate silence with dimmed chrome and a SILENCE badge

## Problem Statement

A player playing a mostly-silent stretch looks identical to one carrying active traffic, so users cannot tell whether anything is happening. Silence is derived from the precomputed mp3_items.peaks envelope already passed into the card, mapping playback position to a bucket range, rather than live Web Audio analysis.

## Acceptance Criteria

- [x] Silence is derived from the existing peaks envelope; no extra fetch and no per-player Web Audio analyser is added
- [x] rtCardBadge reads Silence during a sustained quiet stretch
- [x] An out-of-sync live card shows its drift badge, which takes precedence over silence
- [x] The badge returns to its normal state as soon as traffic resumes
- [x] A card with absent or empty peaks is treated as unknown and never renders as silence
- [x] Quiet gaps shorter than MIN_SILENCE_MS do not trip the badge
- [x] The silence badge has its own background, distinct from the other four badge states
- [x] [VISUAL] Header accent dims to a midpoint between the lane idle and audible colours while silent

## Files

- packages/frontend/src/Applications/RadioTraffic/silence.ts
- packages/frontend/src/Applications/RadioTraffic/cardStatus.ts
- packages/frontend/src/Applications/RadioTraffic/TrafficCard.tsx
- packages/frontend/src/Applications/RadioTraffic/trafficCard.module.scss

## Proof

- [x] [completeness] Completeness (Silence derived from the peaks envelope, a Silence badge, and dimmed chrome. Merged; suite green at 291 files and 3076 tests.)
- [x] [feature-availability] Feature availability (Seven tests pin the precedence from the badge side, five of which passed before the change - they are guards, not decoration. Mutation-checked: collapsing the silence arm to a bare in-sync fails exactly the test that owns it.)
- [x] [robustness] Robustness (No fetch and no AnalyserNode: isSilentAt reads the same mp3_items.peaks the card already draws. The floor self-calibrates to the recording own loudest bucket because the corpus spans wildly different gains.)
- [x] [resilience] Resilience (Asymmetric and stateless - entry needs every bucket quiet across the trailing 3s, exit needs one loud bucket - so a transmission gap cannot trip it, traffic resuming clears it on the next tick, and the verdict cannot oscillate at the 4Hz poll rate without any timer or ref.)
- [~] [security] Security (No security surface. Client-side playback state and badge rendering over already-delivered audio and metadata.)
- [x] [defense-in-depth] Defense in depth (Absent peaks, empty peaks, no playhead, no duration and a playhead past the envelope all return false: unknown is never silence. Peaks are extremes, so a quiet bucket guarantees no loud sample in its span and coarse buckets yield fewer silence verdicts, never wrong ones.)
- [x] [input-validation] Input validation (Drift outranks silence and seeking outranks both, asserted directly, so a card off the clock reports that rather than hiding it behind a quieter signal.)
- [~] [thread-safety] Thread safety (No concurrency surface beyond the existing coordinator singleton and React state.)
- [x] [configurability] Configurability (MIN_SILENCE_MS and the floor are named constants in one module rather than per-card tuning.)

## QA

Merged into feat/radio-traffic-redesign. Suite green at 291 files / 3076 tests, tsc and oxlint clean. Behaviour mutation-checked.

## Work Log

### 2026-08-19T02:19:22.415Z - silence.ts + silence.test.ts landed (20 tests, all green): isSilentAt derives quiet from the existing mp3_items.peaks envelope the card already holds and draws - no extra fetch, no per-player AnalyserNode. Self-calibrating floor = max(ABSOLUTE_FLOOR 4, 0.1 * the recording's own loudest bucket), because this corpus spans wildly different recording gains. Asymmetric and stateless: entry needs EVERY bucket in the trailing MIN_SILENCE_MS=3000 window quiet, exit needs one loud bucket under the playhead, so a transmission gap cannot trip it and resuming traffic clears it on the next tick. Absent/empty peaks, no playhead, no duration and a playhead past the envelope all return false - unknown is never silence. trafficCard.module.scss has the distinct neutral #d0d0d0 badge background and the two midpoint dimmed accents. BLOCKED on the last step: the Badge union cannot gain a silence variant while badgeLabel in TrafficCard.tsx switches exhaustively over it with no default arm (verified: TS2366 at TrafficCard.tsx:98), and TrafficCard.tsx is owned by another change in flight. Commit 25853a6a.

### 2026-08-19T02:28:29.641Z - Silence detection implemented and tested in a new silence.ts - derived from the peaks envelope the card already holds and draws, no fetch and no AnalyserNode, with a self-calibrating floor because the corpus spans wildly different recording gains. Asymmetric and stateless: entry needs every bucket quiet across the trailing 3s, exit needs one loud bucket, so a gap cannot trip it and it cannot oscillate at the poll rate. Absent or empty peaks return false - unknown is never silence. BLOCKED on TrafficCard.tsx: adding the silence variant to the Badge union fails tsc because badgeLabel switches exhaustively with no default arm, which the agent verified and then reverted rather than leaving broken. Criteria 2, 3 and 4 remain open until that delta lands.


### 2026-08-19T02:39:22.392Z - Proof security set NOT_APPLICABLE: No security surface. Client-side playback state and badge rendering over already-delivered audio and metadata.

### 2026-08-19T02:39:22.530Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface beyond the existing coordinator singleton and React state.

### 2026-08-19T02:39:25.484Z - Proof completeness set PROVEN: Silence derived from the peaks envelope, a Silence badge, and dimmed chrome. Merged; suite green at 291 files and 3076 tests.

### 2026-08-19T02:39:25.622Z - Proof feature-availability set PROVEN: Seven tests pin the precedence from the badge side, five of which passed before the change - they are guards, not decoration. Mutation-checked: collapsing the silence arm to a bare in-sync fails exactly the test that owns it.

### 2026-08-19T02:39:25.810Z - Proof robustness set PROVEN: No fetch and no AnalyserNode: isSilentAt reads the same mp3_items.peaks the card already draws. The floor self-calibrates to the recording own loudest bucket because the corpus spans wildly different gains.

### 2026-08-19T02:39:26.008Z - Proof resilience set PROVEN: Asymmetric and stateless - entry needs every bucket quiet across the trailing 3s, exit needs one loud bucket - so a transmission gap cannot trip it, traffic resuming clears it on the next tick, and the verdict cannot oscillate at the 4Hz poll rate without any timer or ref.

### 2026-08-19T02:39:26.195Z - Proof defense-in-depth set PROVEN: Absent peaks, empty peaks, no playhead, no duration and a playhead past the envelope all return false: unknown is never silence. Peaks are extremes, so a quiet bucket guarantees no loud sample in its span and coarse buckets yield fewer silence verdicts, never wrong ones.

### 2026-08-19T02:39:26.392Z - Proof input-validation set PROVEN: Drift outranks silence and seeking outranks both, asserted directly, so a card off the clock reports that rather than hiding it behind a quieter signal.

### 2026-08-19T02:39:26.534Z - Proof configurability set PROVEN: MIN_SILENCE_MS and the floor are named constants in one module rather than per-card tuning.

### 2026-08-19T02:39:43.137Z - Landed in c655e40e together with 042. The blocker the badge agent hit was real, not procedural: adding a sixth Badge variant fails tsc because badgeLabel switches exhaustively with no default arm, so the variant and its case must land together. Silence sits below drift and seeking per the order silence.ts documents, so it only ever replaces in-sync; on a manually played PREVIOUS clip it outranks Playing instead, since the listener already knows it is playing. VISUAL criterion 8 checked on the code being in place - the dimmed midpoints #d62845 and #0000c3 are computed, not sampled from Figma, and ABSOLUTE_FLOOR 4 is an estimate needing calibration against real audio. Both want a human eye.

