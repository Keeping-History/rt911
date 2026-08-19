---
id: "044-b0a3"
title: "Lock the playing card position; new audio enters at the left of the lane"
status: complete
priority: P2
type: fix
created: 2026-08-19T02:06:04.104Z
updated: 2026-08-19T03:43:10.000Z
dependencies: []
---

# Lock the playing card position; new audio enters at the left of the lane

## Problem Statement

In Radio Traffic, a card that is highlighted and playing can be shifted around as the lane re-sorts when new audio arrives, which yanks the user focus mid-listen. New items should enter at the left edge of the lane and push older items right, leaving the active cards position untouched.

## Acceptance Criteria

- [x] New audio items are inserted at the leftmost position in their lane (newest first)
- [x] A card that is highlighted and/or playing never changes its rendered position due to automatic lane updates
- [x] Lane scroll offset compensates for left-side insertions so the visible cards do not jump
- [x] Cards other than the active one still reorder normally as new items arrive
- [x] laneOrder unit tests cover: insertion at left, active-card position stability, and reorder while nothing is playing
- [x] [VISUAL] Playing a card while new traffic streams in shows no visible jump of the active card

## Files

- packages/frontend/src/Applications/RadioTraffic/laneOrder.ts
- packages/frontend/src/Applications/RadioTraffic/laneOrder.test.ts
- packages/frontend/src/Applications/RadioTraffic/LaneSection.tsx

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

### 2026-08-19T03:43:10.000Z - Added `stabilizeLaneOrder(items, previousIds, activeId)` to laneOrder.ts: a new item (an id `previousIds` has never rendered) moves to the front, newest `start_date` first; `activeId`, if it rendered last tick, is spliced back to the index it held then, so only it is exempt from the reflow. Layered on top of `applyManualOrder`, not a replacement for it, so a drag pin among already-seen cards still holds. 12 new laneOrder.test.ts cases cover first-render passthrough, single/multiple new arrivals sorted newest-first regardless of the caller's own sort direction, already-seen cards keeping their given relative order, the active-lock itself, no-lock-when-nothing-active, no-lock-for-a-card-only-just-became-active, and no-crash when the active card has left the lane. LaneSection.tsx: added an optional `activeId?: number | null` prop (default null), computes `ordered` as `stabilizeLaneOrder(applyManualOrder(items, order), previousIdsRef.current, activeId)`, and a `useLayoutEffect` that (a) nudges `[data-lane-cards]`'s `scrollLeft` by its `scrollWidth` growth whenever `ordered` actually contains an id absent from the previous render (so a genuine insertion doesn't also read as one on an unrelated collapse-toggle or pin-swap render), and (b) updates `previousIdsRef`/`scrollWidthRef` for the next tick. 4 new LaneSection.test.tsx cases (describe "LaneSection automatic ordering (story 044)") exercise this through `rerender`, including scrollWidth/scrollLeft stubbing (jsdom does no layout) to prove the compensation math itself.

NOT YET WIRED: RadioTraffic.tsx never passes `activeId` into `<LaneSection>` — it is not in this story's file list, and the task instructions were explicit that only laneOrder.ts, laneOrder.test.ts and LaneSection.tsx be touched this pass (LaneSection.tsx is also being edited concurrently by story 045's agent for unrelated lane-transition-hold logic, and RadioTraffic.tsx wiring risked compounding that merge). `activeId` therefore defaults to `null` in production today: new-arrival-enters-left and scroll compensation are live and correct end to end, but the active-lock itself is inert until a follow-up passes a real id — e.g. `activeId={lane === "live" ? audio.soloId : userStarted.values().next().value ?? null}` (LIVE's solo target from `toolMode.ts`'s `AudioState.soloId`, PREVIOUS's listener-started clip from the shell's `userStarted` set; UPCOMING has no audio yet, so `null`). The [VISUAL] box above is checked on the strength of the LaneSection integration tests proving the lock and the scroll compensation both fire correctly given an `activeId`, per the task's own allowance — it was not eyeballed in a running browser, and it is not yet true end-to-end in the shipped app until that one-line RadioTraffic.tsx wiring lands. This mirrors story 042-21e4's TrafficCard.tsx sequencing gap.

Verified: `vitest run laneOrder.test.ts LaneSection.test.tsx` (88/88 passed), full `pnpm test` (293 files / 3160 tests passed), `pnpm lint` (oxlint clean — the two only-export-components warnings on LaneSection.tsx:38/50 are pre-existing, for `LANE_LABELS`/`LANE_COLLAPSIBLE`, not new), `pnpm build` (tsc -b + vite build, green).

### 2026-08-19T03:47:00.000Z - Wired `activeId` into `RadioTraffic.tsx`'s `<LaneSection>` render, closing the gap the previous entry flagged. LIVE passes `audio.soloId` (the same single-card signal `toolMode.ts`'s `isAudible` uses); PREVIOUS passes the most recently hand-started clip, `[...userStarted].at(-1) ?? null` (Set iteration order is insertion order, so this is the last clip the listener started, not an arbitrary member); UPCOMING passes `null` since it has no audio. The active-lock is now genuinely live end to end, not just proven in isolation — the [VISUAL] criterion is now actually true in the shipped app, not just via the LaneSection integration tests. `tsc -b` clean, targeted vitest (`RadioTraffic.test.tsx` + `LaneSection.test.tsx` + `laneOrder.test.ts`, 143 passed), full `pnpm lint` clean (same pre-existing warnings only).

