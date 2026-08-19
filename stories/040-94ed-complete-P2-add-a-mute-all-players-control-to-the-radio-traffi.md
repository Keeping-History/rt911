---
id: 040-94ed
title: Add a mute-all-players control to the Radio Traffic Live lane header
status: complete
priority: P2
type: feature
created: "2026-08-19T01:39:52.137Z"
updated: "2026-08-19T02:51:24.510Z"
dependencies: []
started_at: "2026-08-19T02:23:52.149Z"
completed_at: "2026-08-19T02:51:24.509Z"
---

# Add a mute-all-players control to the Radio Traffic Live lane header

## Problem Statement

There is no way to silence the whole Live lane at once. Users must mute players individually, which is impractical as new items arrive. The lane needs a mute control alongside the existing expand/collapse button, with lane-level mute state that survives a page refresh.

## Acceptance Criteria

- [x] A mute button sits next to the expand/collapse control in the Live lane header
- [x] Clicking mute immediately mutes every player currently in the lane
- [x] Clicking a player while the lane is muted clears the lane mute and unmutes only the clicked player; all other players stay muted
- [x] The mute control reflects current lane state
- [x] Lane mute state is stored in the app context and persists across page refreshes

## Files

- packages/frontend/src

## Related

- 039-f799

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

### 2026-08-19T02:47:49.369Z - Lane mute is a flag (liveLaneMuted) rather than a bulk edit of the per-card mutes, so it also silences clips that arrive after the press. ClassicyBevelButton mode=toggle on the LIVE strip; releaseLaneMute in toolMode materialises the flag into per-card mutes when a card is clicked. Persisted through RadioTrafficContext alongside story 031's playOriginalAudio.


### 2026-08-19T02:51:22.128Z - Proof completeness set PROVEN: Horizontal lanes, small collapsed players, a lane mute control and a drifting LIVE stripe. Merged; suite green at 293 files and 3145 tests, tsc and oxlint clean, vite build confirms rtStripeDrift and rtSmallPlayer reach the bundle.

### 2026-08-19T02:51:22.212Z - Proof feature-availability set PROVEN: jsdom cannot measure CSS, so the geometry was checked in headless Chrome against a throwaway harness that was then deleted: vertical overflow zero at 560, 892 and 1400 wide and at 892x400, scrollLeft preserved on shrink and clamped on grow, card width constant at 262, and two small players plus the gap exactly equalling the lane width at all three widths.

### 2026-08-19T02:51:22.298Z - Proof robustness set PROVEN: A mutation check caught one of the agent own tests being worthless - silences a clip that arrives after the press passed even with lane muting disabled, because auto-solo had already muted the newcomer. It was rewritten so the arrival would otherwise be the audible card, and now fails under that mutation, as do two others.

### 2026-08-19T02:51:22.388Z - Proof resilience set PROVEN: The stripe animation was proven rather than asserted: one animation on LIVE, zero on the other two lanes, zero under prefers-reduced-motion, and frames at t=0 and t=8s byte-identical while t=4s differs - a seamless loop by exactly one tile.

### 2026-08-19T02:51:22.474Z - Proof security set NOT_APPLICABLE: No security surface. Layout, presentation and client-side audio routing over already-delivered data.

### 2026-08-19T02:51:22.563Z - Proof defense-in-depth set PROVEN: An auto-merge defect was caught that no conflict marker would have shown: toolMode.ts merged cleanly, but story 039 had added soloReleasedByMute to AudioState and the new releaseLaneMute returned an object omitting it. Falsy-by-omission behaved correctly by luck; it is now set explicitly to false, which ARMS the hand-over - the opposite of what the mute tool does with the same field, because naming a card to hear is a request for focus. Two tests pin that.

### 2026-08-19T02:51:22.657Z - Proof input-validation set PROVEN: Lane membership rather than filtered visibility drives the mute, so a clip hidden by a tag filter cannot be the one thing left audible.

### 2026-08-19T02:51:22.741Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface. CSS animation plus a pure reducer over lane membership.

### 2026-08-19T02:51:22.828Z - Proof configurability set PROVEN: Nothing in the layout names a height: flex-wrap nowrap is the whole of the horizontal change, so a card measures against whatever the row model hands the lane and the 3:2:1 ratio composes with the 3+2+1 row model rather than competing. overflow-y hidden is deliberate - a vertical scrollbar would mean a lane got less height than one card, which is a fault for story 034 to fix rather than hide. Small players are calc 50% minus half the gap, exact at every width, no px.

### 2026-08-19T02:51:23.714Z - Merged at 0ee65235. The agent did touch RadioTrafficContext.ts, against the fence: criterion 5 demands persistence and the problem statement demands a flag rather than a bulk mute, so it could not be done lane-side only. Additive at six sites and merged cleanly with story 031.

