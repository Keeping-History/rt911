---
id: 036-ba34
title: Radio Traffic lanes should scroll horizontally instead of vertically
status: complete
priority: P2
type: feature
created: "2026-08-19T01:27:09.638Z"
updated: "2026-08-19T02:51:24.264Z"
dependencies: []
started_at: "2026-08-19T02:23:49.903Z"
completed_at: "2026-08-19T02:51:24.264Z"
---

# Radio Traffic lanes should scroll horizontally instead of vertically

## Problem Statement

The Radio Traffic lanes containing the player cards currently scroll vertically, so lanes grow downward off-screen as cards accumulate. Lanes should lay out and scroll horizontally instead.

## Acceptance Criteria

- [x] Each lane lays its player cards out horizontally
- [x] Overflowing cards are reachable via horizontal scrolling within the lane
- [x] Vertical scrolling within a lane is removed
- [x] Lane scroll position and card sizing behave correctly on window resize

## Files

- packages/frontend/src

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

### 2026-08-19T02:47:39.704Z - Lanes lay out in one nowrap row with overflow-x auto / overflow-y hidden; slots stretch to the lane height so cards size off the row rather than a px literal. Verified in Chrome at 560/892/1400 wide: vertical overflow 0 at every size, scrollLeft preserved on shrink and clamped on grow, card width constant, small players exactly two-up.


### 2026-08-19T02:51:21.338Z - Proof completeness set PROVEN: Horizontal lanes, small collapsed players, a lane mute control and a drifting LIVE stripe. Merged; suite green at 293 files and 3145 tests, tsc and oxlint clean, vite build confirms rtStripeDrift and rtSmallPlayer reach the bundle.

### 2026-08-19T02:51:21.441Z - Proof feature-availability set PROVEN: jsdom cannot measure CSS, so the geometry was checked in headless Chrome against a throwaway harness that was then deleted: vertical overflow zero at 560, 892 and 1400 wide and at 892x400, scrollLeft preserved on shrink and clamped on grow, card width constant at 262, and two small players plus the gap exactly equalling the lane width at all three widths.

### 2026-08-19T02:51:21.530Z - Proof robustness set PROVEN: A mutation check caught one of the agent own tests being worthless - silences a clip that arrives after the press passed even with lane muting disabled, because auto-solo had already muted the newcomer. It was rewritten so the arrival would otherwise be the audible card, and now fails under that mutation, as do two others.

### 2026-08-19T02:51:21.617Z - Proof resilience set PROVEN: The stripe animation was proven rather than asserted: one animation on LIVE, zero on the other two lanes, zero under prefers-reduced-motion, and frames at t=0 and t=8s byte-identical while t=4s differs - a seamless loop by exactly one tile.

### 2026-08-19T02:51:21.702Z - Proof security set NOT_APPLICABLE: No security surface. Layout, presentation and client-side audio routing over already-delivered data.

### 2026-08-19T02:51:21.784Z - Proof defense-in-depth set PROVEN: An auto-merge defect was caught that no conflict marker would have shown: toolMode.ts merged cleanly, but story 039 had added soloReleasedByMute to AudioState and the new releaseLaneMute returned an object omitting it. Falsy-by-omission behaved correctly by luck; it is now set explicitly to false, which ARMS the hand-over - the opposite of what the mute tool does with the same field, because naming a card to hear is a request for focus. Two tests pin that.

### 2026-08-19T02:51:21.873Z - Proof input-validation set PROVEN: Lane membership rather than filtered visibility drives the mute, so a clip hidden by a tag filter cannot be the one thing left audible.

### 2026-08-19T02:51:21.957Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface. CSS animation plus a pure reducer over lane membership.

### 2026-08-19T02:51:22.042Z - Proof configurability set PROVEN: Nothing in the layout names a height: flex-wrap nowrap is the whole of the horizontal change, so a card measures against whatever the row model hands the lane and the 3:2:1 ratio composes with the 3+2+1 row model rather than competing. overflow-y hidden is deliberate - a vertical scrollbar would mean a lane got less height than one card, which is a fault for story 034 to fix rather than hide. Small players are calc 50% minus half the gap, exact at every width, no px.
