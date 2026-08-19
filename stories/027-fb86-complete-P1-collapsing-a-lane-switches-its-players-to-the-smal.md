---
id: 027-fb86
title: Collapsing a lane switches its players to the small player
status: complete
priority: P1
type: fix
created: "2026-08-18T23:45:30.520Z"
updated: "2026-08-19T02:51:23.998Z"
dependencies: []
plan: plans/radio-traffic-redesign.md
plan_step: Design parity
started_at: "2026-08-19T02:23:49.286Z"
completed_at: "2026-08-19T02:51:23.997Z"
---

# Collapsing a lane switches its players to the small player

## Problem Statement

Clicking the lane Minimize button currently hides the cards entirely. Per the Figma Upcoming Row Players Collapsed design the players should instead switch to a compact form that keeps the clip readable, showing the subject quote, colour-coded tag chips, start time, duration and link type in a single row.

## Acceptance Criteria

- [x] clicking Minimize on UPCOMING or PREVIOUS switches its players to the small player rather than hiding them
- [x] the small player shows the subject quote, tag chips, start time, duration and link type per the Figma Upcoming Row Collapsed design
- [x] tag chips in the small player are colour-coded by namespace
- [x] expanding restores the full players
- [x] LIVE still has no collapse control
- [x] the lane label remains visible while collapsed

## Files

- packages/frontend/src/Applications/RadioTraffic/LaneSection.tsx
- packages/frontend/src/Applications/RadioTraffic/TrafficCard.tsx

## Proof

- [x] [completeness] Completeness (Horizontal lanes, small collapsed players, a lane mute control and a drifting LIVE stripe. Merged; suite green at 293 files and 3145 tests, tsc and oxlint clean, vite build confirms rtStripeDrift and rtSmallPlayer reach the bundle.)
- [x] [feature-availability] Feature availability (jsdom cannot measure CSS, so the geometry was checked in headless Chrome against a throwaway harness that was then deleted: vertical overflow zero at 560, 892 and 1400 wide and at 892x400, scrollLeft preserved on shrink and clamped on grow, card width constant at 262, and two small players plus the gap exactly equalling the lane width at all three widths.)
- [x] [robustness] Robustness (A mutation check caught one of the agent own tests being worthless - silences a clip that arrives after the press passed even with lane muting disabled, because auto-solo had already muted the newcomer. It was rewritten so the arrival would otherwise be the audible card, and now fails under that mutation, as do two others.)
- [x] [resilience] Resilience (The stripe animation was proven rather than asserted: one animation on LIVE, zero on the other two lanes, zero under prefers-reduced-motion, and frames at t=0 and t=8s byte-identical while t=4s differs - a seamless loop by exactly one tile.)
- [~] [security] Security (No security surface. Layout, presentation and client-side audio routing over already-delivered data.)
- [x] [defense-in-depth] Defense in depth (An auto-merge defect was caught that no conflict marker would have shown: toolMode.ts merged cleanly, but story 039 had added soloReleasedByMute to AudioState and the new releaseLaneMute returned an object omitting it. Falsy-by-omission behaved correctly by luck; it is now set explicitly to false, which ARMS the hand-over - the opposite of what the mute tool does with the same field, because naming a card to hear is a request for focus. Two tests pin that.)
- [x] [input-validation] Input validation (Lane membership rather than filtered visibility drives the mute, so a clip hidden by a tag filter cannot be the one thing left audible.)
- [~] [thread-safety] Thread safety (No concurrency surface. CSS animation plus a pure reducer over lane membership.)
- [x] [configurability] Configurability (Nothing in the layout names a height: flex-wrap nowrap is the whole of the horizontal change, so a card measures against whatever the row model hands the lane and the 3:2:1 ratio composes with the 3+2+1 row model rather than competing. overflow-y hidden is deliberate - a vertical scrollbar would mean a lane got less height than one card, which is a fault for story 034 to fix rather than hide. Small players are calc 50% minus half the gap, exact at every width, no px.)

## QA

Merged into feat/radio-traffic-redesign. Suite green at 293 files / 3145 tests, tsc and oxlint clean; geometry and animation verified in headless Chrome.

## Work Log

### 2026-08-19T02:47:45.945Z - New LaneSmallPlayer + smallPlayerLabels modules; LaneSection now takes a required renderCollapsedCard and swaps renderer by collapse rather than unmounting the cards. Chips reuse tabs/tagPalette chipColor, with the palette hoisted to .rtShell so both the Details panel and the small player inherit one set of values.


### 2026-08-19T02:51:20.509Z - Proof completeness set PROVEN: Horizontal lanes, small collapsed players, a lane mute control and a drifting LIVE stripe. Merged; suite green at 293 files and 3145 tests, tsc and oxlint clean, vite build confirms rtStripeDrift and rtSmallPlayer reach the bundle.

### 2026-08-19T02:51:20.603Z - Proof feature-availability set PROVEN: jsdom cannot measure CSS, so the geometry was checked in headless Chrome against a throwaway harness that was then deleted: vertical overflow zero at 560, 892 and 1400 wide and at 892x400, scrollLeft preserved on shrink and clamped on grow, card width constant at 262, and two small players plus the gap exactly equalling the lane width at all three widths.

### 2026-08-19T02:51:20.693Z - Proof robustness set PROVEN: A mutation check caught one of the agent own tests being worthless - silences a clip that arrives after the press passed even with lane muting disabled, because auto-solo had already muted the newcomer. It was rewritten so the arrival would otherwise be the audible card, and now fails under that mutation, as do two others.

### 2026-08-19T02:51:20.779Z - Proof resilience set PROVEN: The stripe animation was proven rather than asserted: one animation on LIVE, zero on the other two lanes, zero under prefers-reduced-motion, and frames at t=0 and t=8s byte-identical while t=4s differs - a seamless loop by exactly one tile.

### 2026-08-19T02:51:20.863Z - Proof security set NOT_APPLICABLE: No security surface. Layout, presentation and client-side audio routing over already-delivered data.

### 2026-08-19T02:51:20.953Z - Proof defense-in-depth set PROVEN: An auto-merge defect was caught that no conflict marker would have shown: toolMode.ts merged cleanly, but story 039 had added soloReleasedByMute to AudioState and the new releaseLaneMute returned an object omitting it. Falsy-by-omission behaved correctly by luck; it is now set explicitly to false, which ARMS the hand-over - the opposite of what the mute tool does with the same field, because naming a card to hear is a request for focus. Two tests pin that.

### 2026-08-19T02:51:21.038Z - Proof input-validation set PROVEN: Lane membership rather than filtered visibility drives the mute, so a clip hidden by a tag filter cannot be the one thing left audible.

### 2026-08-19T02:51:21.127Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface. CSS animation plus a pure reducer over lane membership.

### 2026-08-19T02:51:21.249Z - Proof configurability set PROVEN: Nothing in the layout names a height: flex-wrap nowrap is the whole of the horizontal change, so a card measures against whatever the row model hands the lane and the 3:2:1 ratio composes with the 3+2+1 row model rather than competing. overflow-y hidden is deliberate - a vertical scrollbar would mean a lane got less height than one card, which is a fault for story 034 to fix rather than hide. Small players are calc 50% minus half the gap, exact at every width, no px.

### 2026-08-19T02:51:23.786Z - Merged at 0ee65235. Small player is a dark card on the lane grey with the quoted subject, one clipped row of namespace-coloured chips, start and duration bottom-left and link type bottom-right - no transport, waveform or tabs. Chips reuse tagPalette.chipColor, hoisted to .rtShell so the Details panel and the small player share one palette; the duplicate in cardTabs.module.scss is now redundant and is flagged in a comment for whoever next owns tabs/.

