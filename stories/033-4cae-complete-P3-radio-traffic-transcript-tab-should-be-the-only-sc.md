---
id: 033-4cae
title: Radio Traffic transcript tab should be the only scrollable tab and match tab height
status: complete
priority: P3
type: fix
created: "2026-08-19T01:06:37.271Z"
updated: "2026-08-19T02:31:06.309Z"
dependencies: []
started_at: "2026-08-19T02:23:49.599Z"
completed_at: "2026-08-19T02:31:06.308Z"
---

# Radio Traffic transcript tab should be the only scrollable tab and match tab height

## Problem Statement

In the Radio Traffic player cards, tab panels do not share a consistent height and scrolling is not confined to the transcript. The transcript tab should be the only panel with its own scroll area, and every tab panel should occupy the same height so the card does not resize when switching tabs.

## Acceptance Criteria

- [x] All Radio Traffic card tab panels render at the same fixed height
- [x] Switching tabs does not change the card height
- [x] Only the transcript tab panel scrolls; other panels have no scrollbar
- [x] Transcript content longer than the panel scrolls within the panel, not the card

## Files

- packages/frontend/src

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

### 2026-08-19T02:27:49.538Z - Fixed every card tab panel to one height (--window-control-size * 6 * --rt-card-scale = 90px at the default theme) in cardTabs.module.scss, with overflow hidden, and gave only .rtTabPanel[data-tab=transcript] overflow-y: auto. Verified in real Chromium against the built components/stylesheets: card 294px and panel 90px on all six tabs, transcript scrollHeight 1787 vs clientHeight 90, scrolling it moves scrollTop to 1697 with the card height unchanged, and two cards in one stretched row both 294px. Commit a477737b on story/tab-work.


### 2026-08-19T02:31:04.391Z - Proof completeness set PROVEN: Fixed tab panel height with transcript-only scrolling, plus a separate Summary tab. Merged; suite green at 291 files and 3045 tests, tsc and oxlint clean.

### 2026-08-19T02:31:04.489Z - Proof feature-availability set PROVEN: Geometry was measured in a real browser rather than claimed: a temporary Vite page mounting the real TrafficCard with the real stylesheets, driven through Chromium via Playwright, then deleted. Across all six tabs card height was a constant 294 and panel height a constant 90; only transcript reported overflowY auto with scrollHeight 1787 against clientHeight 90, and scrolling it moved scrollTop 0 to 1697 while card height stayed 294.

### 2026-08-19T02:31:04.586Z - Proof robustness set PROVEN: Two cards side by side in a stretched row both measured 294, so panels on one row share a height.

### 2026-08-19T02:31:04.692Z - Proof resilience set PROVEN: The fixed height did not have to live in the contended trafficCard.module.scss after all: giving rtTabPanel a definite height makes the existing flex-basis auto constant, so the constraint was satisfied inside the agent own file. The fence held rather than being negotiated away.

### 2026-08-19T02:31:04.791Z - Proof security set NOT_APPLICABLE: No security surface. Presentational panels over data already delivered.

### 2026-08-19T02:31:04.893Z - Proof defense-in-depth set PROVEN: The Summary tab is hidden rather than disabled when an item has no summary, and whitespace-only subjects count as none. The bar and the panel render from one filtered list with active bound to the rendered panel, so they cannot disagree if an item loses its summary while that tab is open.

### 2026-08-19T02:31:04.986Z - Proof input-validation set PROVEN: noMetadata coverage still asserts every panel renders for an item with no metadata at all, which is 59 of 814 items.

### 2026-08-19T02:31:05.093Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface. Presentational components over props.

### 2026-08-19T02:31:05.192Z - Proof configurability set PROVEN: Panel height is a calc over classicy window variables and the card scale rather than a px literal, so it tracks the theme and the card scale instead of pinning a pixel grid.

### 2026-08-19T02:31:06.088Z - Merged at a477737b. Agent rebased onto 13510f67 and resolved the conflict with my heading fix in favour of its own rewrite, which is correct - story 035 removes Summary from Details, so the three-heading assertion legitimately became a two-column one plus separate Summary-tab assertions. FLAG: non-transcript panels now hard-clip at 90px, which is exactly what criterion 3 asks for, but a pathological item - many wrapping tag chips, or a long mentions list - would lose content with no affordance. Real data averages about 1.4 tags per item and the worst realistic Details case measured well inside 90px. If it bites, the fix is a taller --rt-tab-panel-height, not per-panel scrollbars.

