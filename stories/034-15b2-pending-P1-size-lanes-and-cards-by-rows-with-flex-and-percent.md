---
id: 034-15b2
title: Size lanes and cards by rows with flex and percentages, not fixed px
status: pending
priority: P1
type: refactor
created: "2026-08-19T01:24:25.088Z"
updated: "2026-08-19T01:24:42.058Z"
dependencies: ["024", "027"]
plan: plans/radio-traffic-redesign.md
plan_step: Design parity
---

# Size lanes and cards by rows with flex and percentages, not fixed px

## Problem Statement

Lane heights and card size are currently pinned to pixel numbers - lane fractions applied to a fixed 124px card scaled by a hardcoded 1.25 multiplier. That is why PREVIOUS could never show a whole card: the lane fraction and the card scale were computed independently and disagreed. The design is really expressed in player rows - LIVE is 3 players deep, UPCOMING 2, PREVIOUS 1, totalling 6 rows that fill the window exactly - so the card should derive its height from the row it occupies rather than the other way round.

## Acceptance Criteria

- [ ] the lane column is divided into 6 player rows, LIVE taking 3, UPCOMING 2 and PREVIOUS 1
- [ ] lane heights are expressed with flex and percentages rather than pixel values
- [ ] a card fills the height of one player row, so LIVE shows 3 rows of cards, UPCOMING 2 and PREVIOUS 1
- [ ] the hardcoded 1.25 card scale multiplier is removed, since the card now derives its size from its row
- [ ] no lane scrolls internally at the default window size, because a row is by definition tall enough for its card
- [ ] card width is driven by the grid rather than a fixed pixel width
- [ ] resizing the window rescales lanes and cards proportionally with no internal scrollbars appearing
- [ ] chrome values that are genuinely fixed, such as borders, use classicy CSS variables rather than px literals
- [ ] tsc, vitest and oxlint all pass

## Files

- packages/frontend/src/Applications/RadioTraffic/laneSection.module.scss
- packages/frontend/src/Applications/RadioTraffic/trafficCard.module.scss
- packages/frontend/src/Applications/RadioTraffic/radioTraffic.module.scss

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

