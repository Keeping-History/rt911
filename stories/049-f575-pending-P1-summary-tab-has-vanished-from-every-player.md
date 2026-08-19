---
id: "049-f575"
title: "Summary tab has vanished from every player"
status: in_progress
priority: P1
type: fix
created: 2026-08-19T03:04:37.481Z
updated: 2026-08-19T03:33:13.000Z
dependencies: []
plan: "plans/radio-traffic-redesign.md"
plan_step: "Design parity"
---

# Summary tab has vanished from every player

## Problem Statement

The Summary tab is absent on all cards. Story 035 made it hide itself when an item has no summary - visibleCardTabs drops any tab whose available predicate is falsy, and summaryText returns undefined for an empty subject. That is working as designed on data that does not exist: subject is one of the derived columns written by rederive-mp3-metadata, which has never been run, so all 814 rows are null and the predicate is false for every card. A tab that disappears entirely is indistinguishable from a bug, so the hide-when-empty behaviour is itself wrong even once the backfill lands.

## Acceptance Criteria

- [ ] the Summary tab is present on every card regardless of whether the item has a summary
- [ ] a card whose item has no summary shows an explicit empty state in the Summary panel rather than the tab disappearing
- [ ] summary content renders in the Summary panel when the item has a subject
- [ ] the Summary content is not duplicated back into the Details tab
- [ ] visibleCardTabs no longer filters the Summary tab out, and any test pinning the hidden-when-empty behaviour is deliberately rewritten rather than deleted
- [ ] the tab bar overflow measurement stays correct now that the tab count is constant
- [ ] tsc, vitest and oxlint all pass

## Files

- packages/frontend/src/Applications/RadioTraffic/CardTabBar.tsx
- packages/frontend/src/Applications/RadioTraffic/tabs/SummaryTab.tsx
- packages/frontend/src/Applications/RadioTraffic/TrafficCard.tsx

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

