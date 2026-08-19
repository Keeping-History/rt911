---
id: 035-af66
title: Move Radio Traffic Summary box out of Details tab into its own tab
status: complete
priority: P3
type: refactor
created: "2026-08-19T01:25:54.436Z"
updated: "2026-08-19T02:31:06.609Z"
dependencies: []
started_at: "2026-08-19T02:23:49.754Z"
completed_at: "2026-08-19T02:31:06.609Z"
---

# Move Radio Traffic Summary box out of Details tab into its own tab

## Problem Statement

The Summary box currently lives inside the Details tab of the Radio Traffic player card, crowding the details content. It should be promoted to a dedicated Summary tab.

## Acceptance Criteria

- [x] Radio Traffic card has a distinct Summary tab
- [x] Summary content is no longer rendered in the Details tab
- [x] Summary tab is hidden or disabled when no summary exists for the item

## Files

- packages/frontend/src

## Related

- 033-4cae

## Proof

- [x] [completeness] Completeness (Fixed tab panel height with transcript-only scrolling, plus a separate Summary tab. Merged; suite green at 291 files and 3045 tests, tsc and oxlint clean.)
- [x] [feature-availability] Feature availability (Geometry was measured in a real browser rather than claimed: a temporary Vite page mounting the real TrafficCard with the real stylesheets, driven through Chromium via Playwright, then deleted. Across all six tabs card height was a constant 294 and panel height a constant 90; only transcript reported overflowY auto with scrollHeight 1787 against clientHeight 90, and scrolling it moved scrollTop 0 to 1697 while card height stayed 294.)
- [x] [robustness] Robustness (Two cards side by side in a stretched row both measured 294, so panels on one row share a height.)
- [x] [resilience] Resilience (The fixed height did not have to live in the contended trafficCard.module.scss after all: giving rtTabPanel a definite height makes the existing flex-basis auto constant, so the constraint was satisfied inside the agent own file. The fence held rather than being negotiated away.)
- [~] [security] Security (No security surface. Presentational panels over data already delivered.)
- [x] [defense-in-depth] Defense in depth (The Summary tab is hidden rather than disabled when an item has no summary, and whitespace-only subjects count as none. The bar and the panel render from one filtered list with active bound to the rendered panel, so they cannot disagree if an item loses its summary while that tab is open.)
- [x] [input-validation] Input validation (noMetadata coverage still asserts every panel renders for an item with no metadata at all, which is 59 of 814 items.)
- [~] [thread-safety] Thread safety (No concurrency surface. Presentational components over props.)
- [x] [configurability] Configurability (Panel height is a calc over classicy window variables and the card scale rather than a px literal, so it tracks the theme and the card scale instead of pinning a pixel grid.)

## QA

Merged. Suite green at 291 files / 3045 tests, tsc and oxlint clean. Geometry browser-verified.

## Work Log

### 2026-08-19T02:28:12.607Z - Summary is now its own tab: new tabs/SummaryTab.tsx (plus summaryText, the single answer to 'does this item have a summary'), removed from DetailsTab which is now two columns, and a row in CARD_TABS between Details and Transcript. Hidden rather than disabled when there is no summary — visibleCardTabs(meta) filters the table and TrafficCard renders the bar and the panel from that one list. Browser-checked: the card with a summary shows Details/Summary/Transcript/Parties/Mentions/Source, the one without shows the same list minus Summary. Commit a477737b on story/tab-work.


### 2026-08-19T02:31:05.284Z - Proof completeness set PROVEN: Fixed tab panel height with transcript-only scrolling, plus a separate Summary tab. Merged; suite green at 291 files and 3045 tests, tsc and oxlint clean.

### 2026-08-19T02:31:05.380Z - Proof feature-availability set PROVEN: Geometry was measured in a real browser rather than claimed: a temporary Vite page mounting the real TrafficCard with the real stylesheets, driven through Chromium via Playwright, then deleted. Across all six tabs card height was a constant 294 and panel height a constant 90; only transcript reported overflowY auto with scrollHeight 1787 against clientHeight 90, and scrolling it moved scrollTop 0 to 1697 while card height stayed 294.

### 2026-08-19T02:31:05.474Z - Proof robustness set PROVEN: Two cards side by side in a stretched row both measured 294, so panels on one row share a height.

### 2026-08-19T02:31:05.566Z - Proof resilience set PROVEN: The fixed height did not have to live in the contended trafficCard.module.scss after all: giving rtTabPanel a definite height makes the existing flex-basis auto constant, so the constraint was satisfied inside the agent own file. The fence held rather than being negotiated away.

### 2026-08-19T02:31:05.651Z - Proof security set NOT_APPLICABLE: No security surface. Presentational panels over data already delivered.

### 2026-08-19T02:31:05.741Z - Proof defense-in-depth set PROVEN: The Summary tab is hidden rather than disabled when an item has no summary, and whitespace-only subjects count as none. The bar and the panel render from one filtered list with active bound to the rendered panel, so they cannot disagree if an item loses its summary while that tab is open.

### 2026-08-19T02:31:05.841Z - Proof input-validation set PROVEN: noMetadata coverage still asserts every panel renders for an item with no metadata at all, which is 59 of 814 items.

### 2026-08-19T02:31:05.926Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface. Presentational components over props.

### 2026-08-19T02:31:06.012Z - Proof configurability set PROVEN: Panel height is a calc over classicy window variables and the card scale rather than a px literal, so it tracks the theme and the card scale instead of pinning a pixel grid.

### 2026-08-19T02:31:06.163Z - Merged with 033. Summary is hidden rather than disabled when absent: the tab strip is 207px and already pages with arrows, so a permanently dead label would cost a live tab its place on screen and would corrupt the overflow measurement. FLAG: the panel height reads --rt-card-scale, which is declared in trafficCard.module.scss with a fallback of 1 - renaming that variable would silently drop the panel to 72px.

