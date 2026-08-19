---
id: "044-b0a3"
title: "Lock the playing card position; new audio enters at the left of the lane"
status: in_progress
priority: P2
type: fix
created: 2026-08-19T02:06:04.104Z
updated: 2026-08-19T03:33:13.000Z
dependencies: []
---

# Lock the playing card position; new audio enters at the left of the lane

## Problem Statement

In Radio Traffic, a card that is highlighted and playing can be shifted around as the lane re-sorts when new audio arrives, which yanks the user focus mid-listen. New items should enter at the left edge of the lane and push older items right, leaving the active cards position untouched.

## Acceptance Criteria

- [ ] New audio items are inserted at the leftmost position in their lane (newest first)
- [ ] A card that is highlighted and/or playing never changes its rendered position due to automatic lane updates
- [ ] Lane scroll offset compensates for left-side insertions so the visible cards do not jump
- [ ] Cards other than the active one still reorder normally as new items arrive
- [ ] laneOrder unit tests cover: insertion at left, active-card position stability, and reorder while nothing is playing
- [ ] [VISUAL] Playing a card while new traffic streams in shows no visible jump of the active card

## Files

- packages/frontend/src/Applications/RadioTraffic/laneOrder.ts
- packages/frontend/src/Applications/RadioTraffic/laneOrder.test.ts
- packages/frontend/src/Applications/RadioTraffic/LaneSection.tsx

## Proof

- [ ] [completeness] Completeness
- [ ] [feature-availability] Feature availability
- [ ] [robustness] Robustness
- [ ] [resilience] Resilience
- [ ] [security] Security
- [ ] [defense-in-depth] Defense in depth
- [ ] [input-validation] Input validation
- [ ] [thread-safety] Thread safety
- [ ] [configurability] Configurability

## Work Log

