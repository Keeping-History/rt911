---
id: 018-1c27
title: Build the lane sections with collapse and drag-reorder
status: complete
priority: P2
type: feature
created: "2026-08-18T17:24:01.054Z"
updated: "2026-08-18T20:55:35.359Z"
dependencies: ["014", "017"]
plan: plans/radio-traffic-redesign.md
plan_step: Step 18
completed_at: "2026-08-18T20:55:35.358Z"
---

# Build the lane sections with collapse and drag-reorder

## Problem Statement

The three lanes stack vertically with a vertical label strip. UPCOMING and PREVIOUS collapse; LIVE does not. With the hand tool active, cards drag to reorder within their own lane.

## Acceptance Criteria

- [x] LIVE renders no collapse control while UPCOMING and PREVIOUS do
- [x] collapsing hides the cards and keeps the label
- [x] with the hand tool a card drag reorders within its lane
- [x] a card cannot be dragged across lanes
- [x] with any other tool dragging is inert
- [x] manual order is sparse - only dragged ids are pinned, the rest stay chronological
- [x] a pin is scoped to lane plus item id and is dropped when the item changes lane
- [x] the pin map is pruned to currently-present ids on write so it cannot grow unbounded
- [x] a manually-reordered card is tested crossing a lane boundary in both directions
- [x] vitest run LaneSection.test.tsx passes

## Files

- packages/frontend/src/Applications/RadioTraffic/LaneSection.tsx
- packages/frontend/src/Applications/RadioTraffic/laneOrder.ts

## Proof

- [x] [completeness] Completeness (laneOrder.ts and LaneSection.tsx with styles, 37 plus 23 tests. tsc exit 0, vitest 2843 pass, lint exit 0.)
- [x] [feature-availability] Feature availability (LIVE renders no collapse control while UPCOMING and PREVIOUS do, collapse hides cards and keeps the label, hand-tool drag reorders within a lane, cross-lane is refused, other tools are inert - all behavioural, with slot boxes stubbed using the same technique TV.reorder.test.tsx already uses.)
- [x] [robustness] Robustness (Mutation verified on the two criteria most at risk of passing vacuously: forcing canDrag true failed exactly the 3 tool-gating tests, and widening the hit test to document failed exactly the 2 cross-lane tests.)
- [x] [resilience] Resilience (One clip is walked by a clock at three instants, pinned at each and reconciled at the next, asserting the pin dies at all four crossings: forward UPCOMING to LIVE and LIVE to PREVIOUS, and backward-seek PREVIOUS to LIVE and LIVE to UPCOMING. A non-vacuous end-to-end case proves the pin genuinely reorders its lane first and the lane returns to chronological after.)
- [~] [security] Security (No security surface. Client-side ordering of already-delivered items; no input leaves the browser.)
- [x] [defense-in-depth] Defense in depth (reorderLane is the only write path and runs reconcileLaneOrder itself, so pruning cannot be forgotten. A pin requested in a lane the item is not in is pruned straight back out, enforcing no-cross-lanes at the data layer as well as in the DOM - two independent guards.)
- [x] [input-validation] Input validation (reconcileLaneOrder keeps a pin only where membership matches the lane, so a pin whose item changed lane or left every lane is dropped rather than migrated. A six-step clock walk asserts the map never exceeds one pin, so it cannot grow unbounded across a long session with backward seeks.)
- [~] [thread-safety] Thread safety (No concurrency surface. Pure reducer plus a pointer state machine on the main thread.)
- [~] [configurability] Configurability (Nothing to configure. The 5px drag threshold and which lanes collapse are fixed by the design.)

## QA

tsc exit 0, vitest 2843 passed, lint 0 errors. Merged into feat/radio-traffic-redesign, PR #442. Only failure repo-wide is basemapStyles.test.ts, pre-existing and environmental.

## Work Log

### 2026-08-18T20:50:35.726Z - Implemented LaneSection.tsx + laneOrder.ts + laneSection.module.scss on story/018-lane-sections. Pins are a flat (itemId, slot) pair list per lane so a drag names an exact slot, not just 'nearer the front'. reconcileLaneOrder drops any pin whose item is no longer in the lane it was pinned in — that single pass covers both the lane-crossing hazard and the unbounded-growth hazard, and reorderLane is the only write path so pruning cannot be skipped. 37 pure tests + 23 component tests, all green; mutation-checked the cross-lane and tool-gating tests.


### 2026-08-18T20:55:29.768Z - Proof completeness set PROVEN: laneOrder.ts and LaneSection.tsx with styles, 37 plus 23 tests. tsc exit 0, vitest 2843 pass, lint exit 0.

### 2026-08-18T20:55:29.864Z - Proof feature-availability set PROVEN: LIVE renders no collapse control while UPCOMING and PREVIOUS do, collapse hides cards and keeps the label, hand-tool drag reorders within a lane, cross-lane is refused, other tools are inert - all behavioural, with slot boxes stubbed using the same technique TV.reorder.test.tsx already uses.

### 2026-08-18T20:55:29.957Z - Proof robustness set PROVEN: Mutation verified on the two criteria most at risk of passing vacuously: forcing canDrag true failed exactly the 3 tool-gating tests, and widening the hit test to document failed exactly the 2 cross-lane tests.

### 2026-08-18T20:55:30.053Z - Proof resilience set PROVEN: One clip is walked by a clock at three instants, pinned at each and reconciled at the next, asserting the pin dies at all four crossings: forward UPCOMING to LIVE and LIVE to PREVIOUS, and backward-seek PREVIOUS to LIVE and LIVE to UPCOMING. A non-vacuous end-to-end case proves the pin genuinely reorders its lane first and the lane returns to chronological after.

### 2026-08-18T20:55:30.149Z - Proof security set NOT_APPLICABLE: No security surface. Client-side ordering of already-delivered items; no input leaves the browser.

### 2026-08-18T20:55:30.248Z - Proof defense-in-depth set PROVEN: reorderLane is the only write path and runs reconcileLaneOrder itself, so pruning cannot be forgotten. A pin requested in a lane the item is not in is pruned straight back out, enforcing no-cross-lanes at the data layer as well as in the DOM - two independent guards.

### 2026-08-18T20:55:30.335Z - Proof input-validation set PROVEN: reconcileLaneOrder keeps a pin only where membership matches the lane, so a pin whose item changed lane or left every lane is dropped rather than migrated. A six-step clock walk asserts the map never exceeds one pin, so it cannot grow unbounded across a long session with backward seeks.

### 2026-08-18T20:55:30.426Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface. Pure reducer plus a pointer state machine on the main thread.

### 2026-08-18T20:55:30.516Z - Proof configurability set NOT_APPLICABLE: Nothing to configure. The 5px drag threshold and which lanes collapse are fixed by the design.
