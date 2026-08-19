---
id: "048-6cef"
title: "Live lane shows two stacked players and scrolls horizontally"
status: complete
priority: P2
type: feature
created: 2026-08-19T02:55:02.814Z
updated: 2026-08-19T05:16:46.000Z
dependencies: []
started_at: 2026-08-19T03:33:13.000Z
completed_at: 2026-08-19T05:16:46.000Z
---

# Live lane shows two stacked players and scrolls horizontally

## Problem Statement

In the Radio Traffic app, the Live lane renders a single vertically stretched player. It should instead show two players stacked vertically per column and overflow horizontally.

## Acceptance Criteria

- [x] The Live lane lays out players two-per-column, stacked vertically
- [x] Players do not stretch to fill the full lane height
- [x] Overflow beyond two players scrolls horizontally, not vertically
- [x] [VISUAL] Layout holds at narrow and wide window widths

## Related

- 036-ba34

## Proof

- [x] [completeness] Completeness
- [x] [feature-availability] Feature availability
- [x] [robustness] Robustness
- [~] [resilience] Resilience
- [~] [security] Security
- [x] [defense-in-depth] Defense in depth
- [~] [input-validation] Input validation
- [~] [thread-safety] Thread safety
- [x] [configurability] Configurability

## Work Log

### 2026-08-19T05:16:46.000Z - Reconciled against story 034's row model, then shipped a CSS-only two-per-column grid for LIVE

**Reading the actual current state first.** After landing on the correct base (`feat/radio-traffic-redesign` tip `87e997289`), I read the real, current `laneSection.module.scss`/`trafficCard.module.scss` rather than trusting either story's prose. Story 034 (landed 2026-08-19T04:53, i.e. AFTER 036 and after this story was filed) made `--rt-lane-rows` a value independently set per `[data-lane]` (LIVE 3, UPCOMING 2, PREVIOUS 1) that drives `.rtLane`'s `flex: var(--rt-lane-rows) 1 0` — a **height split between the three lanes**, still 3:2:1 today. What 034 did NOT do is stack multiple cards inside a lane: `.rtLaneCards` was (and for UPCOMING/PREVIOUS still is) `flex-direction: row; flex-wrap: nowrap` — ONE horizontal row of slots — and `TrafficCard`'s `.rtCard` gets `height: 100%` of that row plus `aspect-ratio: 210/150`. For LIVE specifically that meant one card, `height: 100%` of LIVE's entire 3/6-of-window share, both taller AND wider than the others by the aspect ratio — i.e. exactly the "single vertically stretched player" this story's Problem Statement describes. I confirmed this by inspecting the live dev server before making any change (see below) rather than assuming from the stylesheet alone.

**The reconciliation.** This is the second bullet from the task brief: 034's row model is a LANE-height allocation (how much of the window LIVE gets relative to UPCOMING/PREVIOUS), not a statement about how many players stand side by side within a lane's own share — nothing in 034's rules or its own Work Log claims the latter. So story 048 layers a NEW, LIVE-only rule on top without touching `--rt-lane-rows` or the 3:2:1 split at all: `.rtLane[data-lane="live"] .rtLaneCards` gets `display: grid; grid-auto-flow: column; grid-template-rows: repeat(2, 1fr); grid-auto-columns: max-content; justify-items: start;`, and its `.rtLaneSlot` gets `min-height: 0` (the same "load-bearing zero" `.rtLaneCards` already carries, needed here because a `1fr` grid row can otherwise be pushed past half the lane by a slot's implicit min-content height). `grid-auto-flow: column` fills two rows top-to-bottom before starting a new column — "two players stacked vertically per column, overflow horizontal" — using the EXACT SAME flat list of `.rtLaneSlot`s `LaneSection.tsx` already renders (story 036's list; unchanged, zero React/TS edits). UPCOMING and PREVIOUS keep the plain flex-row rule untouched, so their layout, their `--rt-lane-rows` share, and their single-row-of-cards behaviour are unaffected — the selector is scoped to `[data-lane="live"]` and nothing else references it. TrafficCard's own container-query-driven sizing (`container-type: size` + cqw/cqh throughout, story 034) needed no changes: a card at half the row's height just shrinks proportionally through the same mechanism that already made 034's resize story work at any card size.

No conflict was found that required breaking either story: 034's height ratio and 048's two-per-column grouping compose the same way 034 and 036 already do (034 itself says as much for its own case — "the two compose rather than compete"). I updated `laneSection.module.scss`'s comments (top-of-file row-model note, the "Cards" section header, and inline comments on the new rules) to say this explicitly, so a future reader hits the reconciliation in the stylesheet itself rather than having to reconstruct it from two story files.

**Verification.** `pnpm --filter @rt911/frontend exec vitest run src/Applications/RadioTraffic` (668 tests), the full `vitest run` (292 files / 3147 tests), `tsc -b`, and `pnpm lint` (oxlint) all pass clean — lint's only output is pre-existing warnings in unrelated files. No test asserts on `.rtLaneCards`/`.rtLaneSlot` CSS, so this is a pure-stylesheet, zero-regression-risk change per the existing suite, but per this story's own [VISUAL] criterion and the noted layout-interaction risk with 034, I did not stop at that: I ran the real dev server and drove it with Playwright. Seeded `classicyDesktopState.System.Manager.DateAndTime.dateTime` to `2001-09-11T13:00:00.000Z` (ET ~9:00 AM, a data-rich window) to populate LIVE with real items, then measured `[data-lane="live"] [data-lane-cards]` directly: `display: grid`, `gridAutoFlow: column`, `gridTemplateRows: "151.891px 151.906px"` (two equal rows), `overflowX: auto` / `overflowY: hidden`, `scrollWidth 2026 > clientWidth 801` (horizontal overflow present) and `scrollHeight === clientHeight` (318 === 318, zero vertical overflow) at the default window size. Slot geometry confirmed real stacking: two slots at `left: -840` sitting at `top: 64`/`top: 230` (152px apart, i.e. one column, two rows), the next pair at `left: -614` (the next column). UPCOMING/PREVIOUS were unaffected in the same screenshots.

Then, because the browser viewport does not resize the classicy window itself (its size lives in `Applications.apps['RadioTraffic.app'].windows[0].size`, independent of the outer viewport — confirmed the hard way when a viewport-only resize left `clientWidth` unchanged), I resized the actual window via that state and reloaded: at `[560, 400]` (near its `minimumSize` floor of `[520, 320]`) the LIVE lane still showed clean two-per-column pairs with horizontal overflow and no vertical scrollbar; at `[1900, 850]` it showed six-plus full pairs across the width, same behaviour. Screenshots at both sizes visually confirm the grid holds — no stretching, no vertical scroll, horizontal overflow available — at both ends of the window's size range. All temporary Playwright artifacts (`.playwright-mcp/`, screenshots) and the worktree's dev-only `.env` were removed afterward; only `laneSection.module.scss` is staged for commit.

Proof notes: [resilience] and [thread-safety] are `~` NOT_APPLICABLE — this is layout CSS over already-rendered items, no new failure mode or concurrency surface. [security] is `~` NOT_APPLICABLE for the same reason story 036 gave (presentation only, no new data surface). [input-validation] is `~` NOT_APPLICABLE — no new input is accepted; the grid regroups an already-validated item list. [completeness]/[feature-availability]/[robustness]/[configurability] are `x` PROVEN by the dev-server + Playwright measurements above (real CSS layout, not jsdom, which cannot measure grid track sizing). [defense-in-depth] is `x` PROVEN in the sense that the change is scoped narrowly enough (`[data-lane="live"]` only) that a reviewer diffing the stylesheet sees the blast radius is exactly one lane, with no shared rule touched.
