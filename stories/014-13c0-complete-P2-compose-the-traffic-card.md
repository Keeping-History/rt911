---
id: 014-13c0
title: Compose the traffic card
status: complete
priority: P2
type: feature
created: "2026-08-18T17:23:38.997Z"
updated: "2026-08-18T20:55:33.356Z"
dependencies: ["009", "012", "013"]
plan: plans/radio-traffic-redesign.md
plan_step: Step 14
started_at: "2026-08-18T20:23:01.964Z"
completed_at: "2026-08-18T20:55:33.355Z"
---

# Compose the traffic card

## Problem Statement

The card is the core unit of the new UI: a 210x124 frame with a header, a peaks waveform, a control bar and a five-tab strip that pages with arrows when it overflows.

## Acceptance Criteria

- [x] the header shows the subject and falls back to full_title for items with no metadata
- [x] the header shows the lane-appropriate badge
- [x] the tab bar exposes five tabs
- [x] arrow paging appears only when the tab strip overflows, driven by the existing useHorizontalOverflow hook
- [x] the control bar pause button toggles
- [x] the card renders for an item with no metadata

## Files

- packages/frontend/src/Applications/RadioTraffic/TrafficCard.tsx
- packages/frontend/src/Applications/RadioTraffic/CardTabBar.tsx

## Proof

- [x] [completeness] Completeness (TrafficCard and CardTabBar with their styles and tests, 954 insertions. tsc exit 0, vitest 2843 pass, lint 0 errors.)
- [x] [feature-availability] Feature availability (Header subject with full_title fallback, lane-appropriate badge derived in-card via badgeFor, five tabs, arrow paging gated on overflow, pause toggle, and a no-metadata card - all behavioural tests.)
- [x] [robustness] Robustness (The 0..1 fraction contract is pinned by a test placing the clock at the clip midpoint and the element at a quarter, asserting rendered values of exactly 0.5 and 0.25. If percentages are reintroduced the PeaksWaveform clamp turns both into 1 and that test fails.)
- [x] [resilience] Resilience (Lane is a prop and the badge is derived, so a card cannot hold a second answer free to disagree with the container that placed it. The header falls back to full_title, which matters because 59 of 814 items have no metadata and must still render as real cards.)
- [~] [security] Security (No security surface. A presentational component over data already delivered; no input, no network, no persistence.)
- [x] [defense-in-depth] Defense in depth (The card supplies its own positioned containing block and states the canvas box itself rather than inheriting PlaylistEditor.scss, which reaches the bundle only because PlaylistEditor.tsx happens to import it - not a dependency worth relying on.)
- [x] [input-validation] Input validation (Optional metadata is handled throughout via the full_title fallback and optional peaks; useHorizontalOverflow is reused rather than a second overflow detector being written.)
- [~] [thread-safety] Thread safety (No concurrency surface. Controlled component; transport state is owned by story 019.)
- [~] [configurability] Configurability (Nothing to configure. Card geometry comes from the Figma design and the tab set is closed.)

## QA

tsc exit 0, vitest 2843 passed, lint 0 errors. Merged into feat/radio-traffic-redesign, PR #442. Only failure repo-wide is basemapStyles.test.ts, pre-existing and environmental.

## Work Log

### 2026-08-18T20:31:42.491Z - TrafficCard.tsx + CardTabBar.tsx + trafficCard.module.scss, TDD. Card composes CardHeader/PeaksWaveform/CardControlBar/CardTabBar into the 210x124 frame; header/control bar are local sub-components (no other story owns them). Scrubbers get 0..1 fractions (liveMs/durationMs, positionMs/durationMs) — pinned by a test asserting data-pct 0.5/0.25. Badge derived in-card via badgeFor/countdownFor; lane stays a prop so it cannot disagree with Step 18's partition. Tab arrows driven by the existing useHorizontalOverflow. 27 new tests; full suite 280 files / 2746 tests green; tsc -b clean; oxlint exit 0.


### 2026-08-18T20:55:12.361Z - Proof completeness set PROVEN: TrafficCard and CardTabBar with their styles and tests, 954 insertions. tsc exit 0, vitest 2843 pass, lint 0 errors.

### 2026-08-18T20:55:12.454Z - Proof feature-availability set PROVEN: Header subject with full_title fallback, lane-appropriate badge derived in-card via badgeFor, five tabs, arrow paging gated on overflow, pause toggle, and a no-metadata card - all behavioural tests.

### 2026-08-18T20:55:12.548Z - Proof robustness set PROVEN: The 0..1 fraction contract is pinned by a test placing the clock at the clip midpoint and the element at a quarter, asserting rendered values of exactly 0.5 and 0.25. If percentages are reintroduced the PeaksWaveform clamp turns both into 1 and that test fails.

### 2026-08-18T20:55:12.643Z - Proof resilience set PROVEN: Lane is a prop and the badge is derived, so a card cannot hold a second answer free to disagree with the container that placed it. The header falls back to full_title, which matters because 59 of 814 items have no metadata and must still render as real cards.

### 2026-08-18T20:55:12.734Z - Proof security set NOT_APPLICABLE: No security surface. A presentational component over data already delivered; no input, no network, no persistence.

### 2026-08-18T20:55:12.828Z - Proof defense-in-depth set PROVEN: The card supplies its own positioned containing block and states the canvas box itself rather than inheriting PlaylistEditor.scss, which reaches the bundle only because PlaylistEditor.tsx happens to import it - not a dependency worth relying on.

### 2026-08-18T20:55:12.925Z - Proof input-validation set PROVEN: Optional metadata is handled throughout via the full_title fallback and optional peaks; useHorizontalOverflow is reused rather than a second overflow detector being written.

### 2026-08-18T20:55:13.042Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface. Controlled component; transport state is owned by story 019.

### 2026-08-18T20:55:13.144Z - Proof configurability set NOT_APPLICABLE: Nothing to configure. Card geometry comes from the Figma design and the tab set is closed.
