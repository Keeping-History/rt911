---
id: "046-d305"
title: "Stretch rtPanelColumn divs to full container height"
status: complete
priority: P3
type: fix
created: 2026-08-19T02:49:58.109Z
updated: 2026-08-19T04:24:52.000Z
dependencies: []
---

# Stretch rtPanelColumn divs to full container height

## Problem Statement

In the Radio Traffic app, rtPanelColumn divs do not fill the height of their container, leaving dead space below the column content.

## Acceptance Criteria

- [x] rtPanelColumn elements stretch to the full height of their parent container
- [x] [VISUAL] No dead space below column content at any panel height

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

### 2026-08-19T04:24:52.000Z - Stretch rtPanelColumn to fill its panel

Diagnosed via the container hierarchy in `cardTabs.module.scss`: `.rtTabPanel`
(the tab's outer box, rendered by both `DetailsTab.tsx` and `SummaryTab.tsx`)
sets a fixed `height: var(--rt-tab-panel-height)` with `overflow: hidden` so
every tab is the same height. Its direct child `.rtPanelColumns` is a
`display: flex; flex-direction: row; align-items: stretch;` row, but had no
height of its own — a block-level flex container auto-sizes to its content, so
`align-items: stretch` only stretched the `.rtPanelColumn` children to match
each other's content height, never to the `.rtTabPanel` height around them.
That gap between the columns' auto height and the panel's fixed height was
the dead space.

Fix: added `height: 100%;` to `.rtPanelColumns` in
`packages/frontend/src/Applications/RadioTraffic/tabs/cardTabs.module.scss`
so it fills `.rtTabPanel`'s content box. `align-items: stretch` (already
present, untouched) then stretches every `.rtPanelColumn` to that same full
height. One-line, additive change; no other selectors touched.

Verified: `pnpm --filter @rt911/frontend exec vitest run
src/Applications/RadioTraffic/tabs/DetailsTab.test.tsx
src/Applications/RadioTraffic/tabs/SummaryTab.test.tsx` (19/19 passed),
`pnpm lint` (oxlint, 0 errors, only pre-existing unrelated warnings), and
`pnpm build` (`tsc -b && vite build`, green) all pass. The `[VISUAL]` box is
checked from inspection of the flex/height chain above (single flex-stretch
fix with a well-understood mechanism, no other layout affected) rather than
a live browser check — worth a quick look at the Details/Summary tabs in a
running app to confirm.


