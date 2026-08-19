---
id: 030-cdfa
title: Replace raw button elements in Radio Traffic with Classicy components
status: complete
priority: P1
type: refactor
created: "2026-08-19T00:53:03.216Z"
updated: "2026-08-19T04:40:01.000Z"
dependencies: ["022", "024", "027"]
plan: plans/radio-traffic-redesign.md
plan_step: Design parity
---

# Replace raw button elements in Radio Traffic with Classicy components

## Problem Statement

Radio Traffic renders eight raw HTML button elements across FilterTree, TrafficCard, CardTabBar, LaneSection and ToolPalette. Repo convention is to use Classicy components where one exists, so the app inherits Platinum styling, states and accessibility rather than reimplementing them per call site.

## Acceptance Criteria

- [x] no raw button elements remain in RadioTraffic source, excluding tests
- [x] the mute control uses ClassicyBevelButton in toggle mode with a controlled on state
- [x] icon-only controls use the square prop rather than hand-rolled sizing
- [x] existing behaviour and aria semantics are preserved, including the mute button stopPropagation guard that prevents a tool click and a button toggle firing from one press
- [x] tests assert behaviour and state attributes rather than element tag names
- [x] tsc, vitest and oxlint all pass

## Files

- packages/frontend/src/Applications/RadioTraffic/

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

### 2026-08-19T04:40:01.000Z - Replaced all 8 raw buttons with Classicy components

Grepped `<button` across `packages/frontend/src/Applications/RadioTraffic/` (excluding `*.test.tsx`) for the authoritative list — found exactly 8, matching the problem statement's file list:

1. `ToolPalette.tsx` — the 4-tool radio button → `ClassicyBevelButton` `mode="radio"` `square`, controlled `on={t === tool}`, `onClickFunc={() => onSelect(t)}`. `mode="radio"` hardcodes `role="radio"`/`aria-checked` internally, matching the pre-existing raw markup's own `role="radio"`/`aria-checked`.
2. `CardTabBar.tsx` — "Previous tab" arrow → `ClassicyBevelButton` `square`, default push mode, `disabled={index<=0}`, `onClickFunc={() => page(-1)}`.
3. `CardTabBar.tsx` — the per-tab button (`role="tab"`) → `ClassicyButton` (not `ClassicyBevelButton`: BevelButton hardcodes its own `role` off `mode`, which can only ever be "radio" or "button" and would silently clobber `role="tab"` — the thing the tablist's semantics and `CardTabBar.test.tsx`'s `getByRole("tab", …)` queries depend on). `ClassicyButton` sets no `role` of its own, so `role="tab"`/`aria-selected` pass through via rest untouched, and its real `forwardRef` keeps `activeRef`'s scroll-into-view working.
4. `CardTabBar.tsx` — "Next tab" arrow → `ClassicyBevelButton`, same as #2.
5. `LaneSection.tsx` — the collapse/expand toggle → `ClassicyBevelButton` `square`, default push mode (not `toggle`: `aria-expanded` is already the correct disclosure-widget semantic, and adding BevelButton's own `aria-pressed` on top via `mode="toggle"` would be a second, redundant state for the same fact).
6. `FilterTree.tsx` — a large namespace's row (`LargeNamespaceRow`) → `ClassicyBevelButton`, default push mode, no `square` (it carries a text label + count, not an icon).
7. `TrafficCard.tsx` — the transport (play/pause) button → `ClassicyBevelButton` `square`, default push mode, `onClickFunc={onTransport}`.
8. `TrafficCard.tsx` — the mute button (the one named in the acceptance criteria) → `ClassicyBevelButton` `mode="toggle"` `square`, controlled `on={muted}`, `onChangeFunc={onToggleMute}`. The `onPointerUp={(e) => e.stopPropagation()}` guard against the lane/card slot's own pointerup tool-click handler was carried over verbatim — `ClassicyBevelButton` sets no `onPointerUp` of its own, so it passes straight through via rest props.

`LaneSection.tsx`'s lane-level mute control was **already** a `ClassicyBevelButton` (`mode="toggle"`, controlled `on`) before this story — not one of the 8, but the reference pattern the other conversions followed. Note also that `ClassicyBevelButton`/`ClassicyButton` both compute their own `className` internally and drop any `className` handed to them (confirmed against `~/classicy`'s source, `ClassicyBevelButton.tsx`/`ClassicyButton.tsx`) — this is why the lane-mute control already styled itself off `[data-lane-mute]` rather than a class, and why several of the conversions below follow the same attribute-selector pattern.

Test changes: `ToolPalette.test.tsx`, `FilterTree.test.tsx`, `CardTabBar.test.tsx`, `LaneSection.test.tsx`, `TrafficCard.test.tsx` needed no changes — they were already role/attribute/behaviour-based (`getByRole`, `aria-*`, `data-*`), not tag-based, so they hold as the assertion-quality half of this story's acceptance criteria without edits. `RadioTraffic.test.tsx`'s hand-rolled `vi.mock("classicy", …)` test double for `ClassicyBevelButton` and `ClassicyButton` *did* need updating: the old `ClassicyBevelButton` stub ignored `mode` entirely (always native `role="button"`, always fired `onChangeFunc` on click, never called `onClickFunc`), which broke the shell's own tests once `ToolPalette` started depending on `mode="radio"` → `role="radio"`. Rewrote both stubs to mirror the real components' `mode`-driven `role`/`aria-checked`/`aria-pressed` and `onClickFunc`/`onChangeFunc` firing rules, and to forward `role`/`aria-selected`/`ref` for `ClassicyButton`.

Dead CSS flagged for the sibling story 034/029 agents (not touched — `laneSection.module.scss` and `trafficCard.module.scss` are excluded from this story; `ClassicyBevelButton`/`ClassicyButton` drop any `className` handed to them, per above, so these selectors have nothing to match once the elements they targeted stopped being able to carry a class):
- `laneSection.module.scss` — `.rtLaneToggle` (the collapse/expand button's rule block). The file already has an established migration path for this exact situation next to the mute control's own CSS (`.rtLaneStrip [data-lane-mute] { … }` with a comment explaining the className-drop) — `.rtLaneToggle` could follow the same shape as `.rtLaneStrip [data-lane-toggle]` once someone can edit that file; the element already carries `data-lane-toggle`.
- `trafficCard.module.scss` — `.rtCardTransport`, `.rtCardMute` (the two control-bar buttons), and `.rtCardTabArrow`, `.rtCardTab`, `.rtCardTabSelected` (the tab strip, now `ClassicyButton`/`ClassicyBevelButton`). None of the elements carry a spare attribute hook today beyond `data-muted` (mute only) — a follow-up wanting to restyle these will need to add one, the same way `[data-lane-mute]`/`[data-filter-large-row]` do below.

Where this story *did* own the stylesheet (`filterTree.module.scss`, `trafficTools.module.scss` — neither is in the excluded list), the dead-CSS problem was fixed rather than flagged: `.rtFilterLargeRow` became `.rtFilterTree [data-filter-large-row]`, and `.rtTool`/`.rtToolActive` became `.rtToolPalette [role="radio"]`/`.rtToolPalette [role="radio"][aria-checked="true"]` (using the ARIA state `ClassicyBevelButton` already exposes instead of inventing a new data attribute), with the hand-rolled `width`/`height` on `.rtTool` dropped in favour of the `square` prop.

Verified: `pnpm --filter @rt911/frontend exec vitest run src/Applications/RadioTraffic` (31 files, 668 tests, all green), full `pnpm test` (292 files, 3147 tests, all green), `tsc -b` (clean), `pnpm lint` (clean — only pre-existing warnings in unrelated files/lines).
