---
id: "049-f575"
title: "Summary tab has vanished from every player"
status: complete
priority: P1
type: fix
created: 2026-08-19T03:04:37.481Z
updated: 2026-08-19T03:27:45.000Z
dependencies: []
plan: "plans/radio-traffic-redesign.md"
plan_step: "Design parity"
---

# Summary tab has vanished from every player

## Problem Statement

The Summary tab is absent on all cards. Story 035 made it hide itself when an item has no summary - visibleCardTabs drops any tab whose available predicate is falsy, and summaryText returns undefined for an empty subject. That is working as designed on data that does not exist: subject is one of the derived columns written by rederive-mp3-metadata, which has never been run, so all 814 rows are null and the predicate is false for every card. A tab that disappears entirely is indistinguishable from a bug, so the hide-when-empty behaviour is itself wrong even once the backfill lands.

## Acceptance Criteria

- [x] the Summary tab is present on every card regardless of whether the item has a summary
- [x] a card whose item has no summary shows an explicit empty state in the Summary panel rather than the tab disappearing
- [x] summary content renders in the Summary panel when the item has a subject
- [x] the Summary content is not duplicated back into the Details tab
- [x] visibleCardTabs no longer filters the Summary tab out, and any test pinning the hidden-when-empty behaviour is deliberately rewritten rather than deleted
- [x] the tab bar overflow measurement stays correct now that the tab count is constant
- [x] tsc, vitest and oxlint all pass

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

### 2026-08-19T03:27:45.000Z - Always show Summary tab with an explicit empty state

Removed the `available` predicate from the Summary row in `CARD_TABS`
(`CardTabBar.tsx`), so `visibleCardTabs` no longer drops it when
`summaryText(meta)` is undefined — the `available` mechanism itself stays on
`CardTab` for a future tab that genuinely needs gating, but nothing uses it
now. `SummaryTab.tsx` already rendered an explicit `"No summary."` empty state
(`styles.rtEmpty`, the same convention PartiesTab/MentionsTab use) behind the
`subject ? ... : ...` branch from story 035 — that code needed no behavioural
change, just its stale doc comment describing the tab as hidden-by-default.
Confirmed `DetailsTab.tsx` never rendered `subject` (it only reads timings and
tags), so there was no duplication to remove. `TrafficCard.tsx`'s
`title = meta?.subject?.trim() || item.full_title` is the card header
fallback, unrelated to the Details/Summary split, and was left alone.

Rewrote the tests that pinned the old hide-when-empty behaviour rather than
deleting them: `CardTabBar.test.tsx`'s "drops Summary, and only Summary, when
there is no summary" and "renders exactly the tabs it hands the bar" now
assert all six tabs stay visible for `undefined`/blank-subject meta;
`TrafficCard.test.tsx`'s "does not offer a Summary tab to an item with no
summary" is now "still offers a Summary tab ... with an explicit empty state"
and clicks through to check the panel text. Updated stale comments in
`SummaryTab.test.tsx`, `TrafficCard.test.tsx` (the no-metadata sweep over
`visibleCardTabs(undefined)`), and `tabs/noMetadata.test.tsx` that described
Summary as hidden.

`useHorizontalOverflow` (CardTabBar's overflow/arrow logic) measures the
rendered strip's actual `scrollWidth` via `ResizeObserver`, not the tab count,
so the "stays correct" acceptance criterion required no code change there —
verified `CardTabBar.test.tsx`'s arrow-visibility tests still pass unchanged.

Verified: `pnpm --filter @rt911/frontend exec vitest run
src/Applications/RadioTraffic/CardTabBar.test.tsx
src/Applications/RadioTraffic/tabs/SummaryTab.test.tsx
src/Applications/RadioTraffic/TrafficCard.test.tsx
src/Applications/RadioTraffic/tabs/noMetadata.test.tsx` (85 passed), full
`pnpm lint` (oxlint, exit 0, only pre-existing warnings elsewhere), `tsc -b`
(clean), and full `pnpm test` (293 files / 3145 tests passed).

