---
id: "045-636a"
title: "Keep an audible LIVE player in the Live lane until muted or unselected"
status: complete
priority: P2
type: fix
created: 2026-08-19T02:48:20.224Z
updated: "2026-08-19T03:35:00.000Z"
dependencies: []
started_at: "2026-08-19T03:20:00.000Z"
completed_at: "2026-08-19T03:35:00.000Z"
---

# Keep an audible LIVE player in the Live lane until muted or unselected

## Problem Statement

In the Radio Traffic app, a LIVE player that is actively playing and unmuted can be moved out of the Live lane automatically. If the listener can hear it, it should stay put; only once it is muted or unselected may it move to the PREVIOUS lane.

## Acceptance Criteria

- [x] A LIVE player that is playing and unmuted is never auto-removed from the Live lane
- [x] Muting an audible LIVE player allows it to transition to the PREVIOUS lane
- [x] Unselecting an audible LIVE player allows it to transition to the PREVIOUS lane
- [x] Muted or unselected LIVE players continue to move to PREVIOUS as they do today
- [x] Unit tests cover the audible-hold and the mute/unselect release paths

## Files

- packages/frontend/src/Applications/RadioTraffic/liveHold.ts (new)
- packages/frontend/src/Applications/RadioTraffic/liveHold.test.ts (new)
- packages/frontend/src/Applications/RadioTraffic/RadioTraffic.tsx
- packages/frontend/src/Applications/RadioTraffic/RadioTraffic.test.tsx

## Proof

- [x] [completeness] Completeness (Wired into the running app: `partitionLanes` in RadioTraffic.tsx now redirects a PREVIOUS verdict back to LIVE for held ids, and a `heldLiveIds` state + effect keeps that memory current every tick. Full suite green: 294 files / 3162 tests, tsc and oxlint clean.)
- [x] [feature-availability] Feature availability (5 new integration tests in RadioTraffic.test.tsx exercise the hold surviving a clock-window end, and its release via mute, via stop/unselect, via an already-muted card, and via the LIVE lane's mute-all control — plus 12 new pure unit tests in liveHold.test.ts.)
- [x] [robustness] Robustness (The hold decision is a pure function, `withAudibleHold`, of the raw lane, the item id and the held-id set — no hidden module state, same pattern cardStatus.ts's own badgeFor uses for its previousKind argument.)
- [x] [resilience] Resilience (`nextHeldLiveIds` only ever draws from items already in `lanes.live`, so a never-live history item can never be manufactured into a hold; `sameIdSet` bails the state update when nothing changed, so the once-a-second clock tick that recomputes `lanes` cannot loop.)
- [~] [security] Security (No security surface. Client-side lane classification and audio-element lifetime over already-delivered mp3 metadata.)
- [x] [defense-in-depth] Defense in depth (The hold reads `stopped`, `audio` and `liveLaneMuted` — the SAME three inputs TrafficCard's own `muted`/`paused` props already compute from — so the lane a card renders in can never disagree with whether the card looks audible.)
- [x] [input-validation] Input validation (`withAudibleHold` only ever overrides a PREVIOUS verdict, never UPCOMING or LIVE, both by construction and pinned by a dedicated test.)
- [~] [thread-safety] Thread safety (No concurrency surface beyond the existing coordinator singleton and React state.)
- [x] [configurability] Configurability (cardStatus.ts's `laneFor` is untouched and stays a pure, clock-only classifier per its own header; the reconciliation lives entirely in RadioTraffic.tsx / liveHold.ts, so a future change to the hold rule cannot alter what "LIVE" means to the ten other consumers of laneFor.)

## QA

Implemented on top of `checkout` (merged in via `feat/radio-traffic-redesign`'s content). `pnpm lint`, `pnpm build`, and `pnpm test` all green: 294 test files / 3162 tests, tsc and oxlint clean.

## Work Log

### 2026-08-19T03:35:00.000Z - Implemented the audible hold as a reconciliation layer between cardStatus.laneFor's pure clock classification and RadioTraffic.tsx's audio/tool state, rather than making cardStatus.ts audio-aware. New pure module liveHold.ts exports `withAudibleHold` (overrides a PREVIOUS verdict to LIVE for a held id) and `nextHeldLiveIds` (derives which of this render's LIVE items should still be held next render, from an isAudible predicate combining `stopped`, `audio` and `liveLaneMuted` — the same three inputs already feeding TrafficCard's own muted/paused props). RadioTraffic.tsx's `partitionLanes` now takes a `heldLiveIds` set and redirects PREVIOUS→LIVE before the previous-lane's 12-item cap, so a long-held item cannot be pushed out of the unsliced candidate list by other clips ending later. A new `heldLiveIds` state, populated one render behind by an effect mirroring the existing reconcileSolo/reconcileLaneOrder pattern in the same file, closes the loop. Did not touch cardStatus.ts, laneOrder.ts or LaneSection.tsx. 12 new unit tests in liveHold.test.ts plus 5 new integration tests in RadioTraffic.test.tsx (describe "the audible hold (story 045)") cover the hold surviving past the clock window and its release via mute, stop/unselect, an already-muted card, and the lane mute-all control. Full suite green: 294 files / 3162 tests; lint and build clean.

