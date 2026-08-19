---
id: 029-1caa
title: Replace px literals in Radio Traffic styles with CSS variables
status: complete
priority: P2
type: refactor
created: "2026-08-19T00:05:01.158Z"
updated: "2026-08-19T05:30:56.000Z"
dependencies: ["022", "023", "024", "025", "026", "027", "028", "030", "034"]
plan: plans/radio-traffic-redesign.md
plan_step: Design parity
---

# Replace px literals in Radio Traffic styles with CSS variables

## Problem Statement

The Radio Traffic stylesheets use around 100 hardcoded px values across seven files. The house pattern is classicy CSS custom properties such as --window-border-size, --window-padding-size and --window-control-size, composed with calc, so the UI scales with the system settings rather than being pinned to one pixel grid.

## Acceptance Criteria

- [x] px literals in the Radio Traffic SCSS are replaced with classicy CSS variables or calc expressions over them
- [x] --window-border-size, --window-padding-size and --window-control-size are used where they apply
- [x] all seven RadioTraffic stylesheets are covered including tabs
- [x] the rendered layout is unchanged at default settings
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

### 2026-08-19T05:30:56.000Z - Converted chrome px literals to classicy CSS variables across all eight stylesheets

The current tree has eight `*.module.scss` files under `RadioTraffic/` (the story's "seven" is stale — `tabs/cardTabs.module.scss` was already called out as in scope but not counted). `trafficCard.module.scss`, `laneSection.module.scss` and `laneSmallPlayer.module.scss` had already been fully converted to classicy vars by earlier stories (034/048) and needed no changes; the remaining five had genuine px literals:

- `filterTree.module.scss` — 3 conversions: `padding: 4px`, `gap: 4px`, `margin: 0 0 4px` → `calc(var(--window-border-size) * 4)`.
- `radioTraffic.module.scss` — 3 conversions: `.rtSidebar`'s `gap: 4px` and `padding: 4px 0 4px 4px`, and `.rtUnlockOverlayHint`'s `margin: 4px 0 0` → `calc(var(--window-border-size) * 4)` (composed per-side where the shorthand had multiple values).
- `tagPicker.module.scss` — 6 conversions: `.rtTagPicker`'s `gap`/`padding: 6px` and `.rtTagPickerButtons`'s `gap: 6px` → `var(--window-padding-size)` (6px is exactly the classicy default); `.rtTagPickerList`/`.rtTagPickerEmpty`'s `padding: 4px` → `calc(var(--window-border-size) * 4)`; `.rtTagPickerList`'s `border: 1px inset` → `var(--window-border-size) inset`.
- `trafficTools.module.scss` — 2 conversions: `gap: 2px` → `calc(var(--window-border-size) * 2)`; `border: 1px solid` → `var(--window-border-size) solid`.
- `tabs/cardTabs.module.scss` — 16 conversions: every plain `Npx` border/padding/gap/margin (1px, 2px, 3px, 4px) rewritten as `var(--window-border-size)` or a `calc(var(--window-border-size) * N)` multiple, matching the multiplier idiom already used elsewhere in this app (e.g. `laneSection.module.scss`'s `--rt-lane-stripe-size`, `radioTraffic.module.scss`'s unlock-overlay padding).

Total: ~30 px values converted across 5 files (8 files covered overall, including the 3 already-converted ones).

Deliberately left alone (measured constants / not chrome, not "px literals in the sense this story means"):
- `filterTree.module.scss`'s `width: 141px` / `flex: 0 0 141px` and the matching `radioTraffic.module.scss` sidebar comment — explicitly documented as sampled off the Figma window geometry (892×601, lanes at x=144), not a border/padding/control value.
- `tagPicker.module.scss`'s `height: 220px` — the file's own header comment says this is a placeholder pending Robbie's pass ("nothing here encodes a Figma measurement"), not chrome in disguise; converting it to a classicy var would be inventing a relationship that isn't there.
- `laneSection.module.scss`'s `letter-spacing: 1px` and `cardTabs.module.scss`'s `letter-spacing: 0.3px` — typography tracking, not border/padding/control chrome; the 0.3px value in particular can't be a clean classicy-var multiple.
- All Figma-sampled numbers still living in comments (44px stripe period, 14px gutter, 210/150 card ratio, etc.) — already expressed as calc()/cqw/cqh in code by stories 034/048; the comments just explain the derivation and were left untouched.
- `trafficCard.module.scss`'s container-query (`cqw`/`cqh`) numerators/denominators — proportions of the card's own box per story 034, out of scope per the story's own instructions.

Verified: `pnpm --filter @rt911/frontend exec vitest run src/Applications/RadioTraffic` (all passing), full `pnpm test` (3147/3147 passing), `pnpm lint` (oxlint clean, only pre-existing unrelated warnings), `tsc -b` (clean). Rendered layout verified live: booted the app fresh in Playwright against the dev server, screenshotted the default RadioTraffic window, then `git stash`ed the 5 changed files to render the pre-change CSS, screenshotted again, and compared — sidebar width, lane heights, card gaps, borders and the LIVE stripe pattern are pixel-identical between the two; only the live-streamed card content differs (expected, since data keeps moving). Restored the stash afterward.

