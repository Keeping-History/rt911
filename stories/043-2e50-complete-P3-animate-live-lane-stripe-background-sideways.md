---
id: 043-2e50
title: Animate LIVE lane stripe background sideways
status: complete
priority: P3
type: feature
created: "2026-08-19T02:00:11.633Z"
updated: "2026-08-19T02:56:03.947Z"
dependencies: []
plan: plans/radio-traffic-redesign.md
plan_step: LIVE lane animation
started_at: "2026-08-19T02:23:55.383Z"
completed_at: "2026-08-19T02:56:03.946Z"
---

# Animate LIVE lane stripe background sideways

## Problem Statement

The Radio Traffic LIVE lane uses a static stripe.svg mask tile as its background. A slow sideways scroll would give the LIVE lane a sense of motion, visually distinguishing it as the active live lane from the static past lanes.

## Acceptance Criteria

- [x] The LIVE lane background stripe tile animates horizontally at a slow, continuous rate
- [x] Animation loops seamlessly
- [x] Only the LIVE lane animates; other lanes keep a static stripe background
- [x] Animation is disabled under prefers-reduced-motion
- [x] Animation uses CSS transform/background-position (GPU-friendly), not JS per-frame updates
- [x] [VISUAL] Motion reads as subtle ambience, not distracting

## Files

- packages/frontend/src/Applications/RadioTraffic/laneSection.module.scss
- packages/frontend/src/Applications/RadioTraffic/stripe.svg

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

Visual criterion approved by Robbie. Suite green; vite build confirms rtStripeDrift reaches the bundle.

## Work Log

### 2026-08-19T02:47:54.724Z - CSS @keyframes translateX on the LIVE lane's ::before mask overlay, one tile (44px) per 8s, with a one-tile left overhang clipped by overflow:hidden so the travel never uncovers an edge. Chrome check: 1 animation on LIVE and 0 on the other two lanes, 0 under prefers-reduced-motion, and the t=0 and t=8s frames are pixel-identical while t=4s differs. Criterion 6 [VISUAL] left for a human.


### 2026-08-19T02:51:22.911Z - Proof completeness set PROVEN: Horizontal lanes, small collapsed players, a lane mute control and a drifting LIVE stripe. Merged; suite green at 293 files and 3145 tests, tsc and oxlint clean, vite build confirms rtStripeDrift and rtSmallPlayer reach the bundle.

### 2026-08-19T02:51:22.996Z - Proof feature-availability set PROVEN: jsdom cannot measure CSS, so the geometry was checked in headless Chrome against a throwaway harness that was then deleted: vertical overflow zero at 560, 892 and 1400 wide and at 892x400, scrollLeft preserved on shrink and clamped on grow, card width constant at 262, and two small players plus the gap exactly equalling the lane width at all three widths.

### 2026-08-19T02:51:23.082Z - Proof robustness set PROVEN: A mutation check caught one of the agent own tests being worthless - silences a clip that arrives after the press passed even with lane muting disabled, because auto-solo had already muted the newcomer. It was rewritten so the arrival would otherwise be the audible card, and now fails under that mutation, as do two others.

### 2026-08-19T02:51:23.174Z - Proof resilience set PROVEN: The stripe animation was proven rather than asserted: one animation on LIVE, zero on the other two lanes, zero under prefers-reduced-motion, and frames at t=0 and t=8s byte-identical while t=4s differs - a seamless loop by exactly one tile.

### 2026-08-19T02:51:23.268Z - Proof security set NOT_APPLICABLE: No security surface. Layout, presentation and client-side audio routing over already-delivered data.

### 2026-08-19T02:51:23.359Z - Proof defense-in-depth set PROVEN: An auto-merge defect was caught that no conflict marker would have shown: toolMode.ts merged cleanly, but story 039 had added soloReleasedByMute to AudioState and the new releaseLaneMute returned an object omitting it. Falsy-by-omission behaved correctly by luck; it is now set explicitly to false, which ARMS the hand-over - the opposite of what the mute tool does with the same field, because naming a card to hear is a request for focus. Two tests pin that.

### 2026-08-19T02:51:23.454Z - Proof input-validation set PROVEN: Lane membership rather than filtered visibility drives the mute, so a clip hidden by a tag filter cannot be the one thing left audible.

### 2026-08-19T02:51:23.546Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface. CSS animation plus a pure reducer over lane membership.

### 2026-08-19T02:51:23.642Z - Proof configurability set PROVEN: Nothing in the layout names a height: flex-wrap nowrap is the whole of the horizontal change, so a card measures against whatever the row model hands the lane and the 3:2:1 ratio composes with the 3+2+1 row model rather than competing. overflow-y hidden is deliberate - a vertical scrollbar would mean a lane got less height than one card, which is a fault for story 034 to fix rather than hide. Small players are calc 50% minus half the gap, exact at every width, no px.

### 2026-08-19T02:51:23.859Z - Merged at 0ee65235. Criterion 6 is VISUAL and deliberately left unchecked: 8s per 44px tile is about 5.5px/s, but whether that reads as subtle ambience is a human call.

### 2026-08-19T02:56:03.308Z - VISUAL criterion approved by Robbie, who also tuned the animation himself in 291b76f1: drift direction reversed and the cycle shortened from 8s to 5s. Still exactly one tile of travel so the loop stays seamless; verified tsc, LaneSection tests, oxlint and vite build after the tweak. That commit deliberately carries no Co-Authored-By trailer - it is his edit, and the trailer would have recorded human work as AI work.

