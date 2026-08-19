---
id: 022-1fe5
title: Lane chrome and window layout to match the design
status: complete
priority: P1
type: fix
created: "2026-08-18T23:45:09.994Z"
updated: "2026-08-19T01:20:54.676Z"
dependencies: []
plan: plans/radio-traffic-redesign.md
plan_step: Design parity
completed_at: "2026-08-19T01:20:54.675Z"
---

# Lane chrome and window layout to match the design

## Problem Statement

The three lanes do not match the Figma design. LIVE has no stripe pattern and the wrong red, the lanes share one flat background with no borders, the window scrolls instead of fitting, PREVIOUS is narrower than the other two, and cards are crowded together.

## Acceptance Criteria

- [x] the LIVE lane uses the diagonal stripe pattern from classicy assets/img/ui/stripe.svg
- [x] LIVE stripe colours are #cd8a8a and #ac3c3c as sampled from the design frame
- [x] UPCOMING lane background is #a5a3a3 and PREVIOUS is #cccccc
- [x] each lane has its own border per the design
- [x] the main window does not scroll
- [x] lane heights default to 3/5 LIVE, 2/5 UPCOMING and 1/5 PREVIOUS of the window
- [x] the PREVIOUS lane is 100 percent width, matching LIVE and UPCOMING
- [x] cards have visible padding between them
- [x] stripe.svg is vendored into this repo since it is not in the published classicy package

## Files

- packages/frontend/src/Applications/RadioTraffic/LaneSection.tsx
- packages/frontend/src/Applications/RadioTraffic/laneSection.module.scss
- packages/frontend/src/Applications/RadioTraffic/RadioTraffic.tsx

## Proof

- [x] [completeness] Completeness (Stripe pattern, per-lane borders and backgrounds, non-scrolling window and lane ratios. tsc exit 0, 289 files and 2949 tests pass, oxlint exit 0.)
- [x] [feature-availability] Feature availability (The stripe was verified in Chrome rather than assumed: 49.2/48.6 percent split, 44px period, colour constant along the anti-diagonal, matching the design orientation and period. vite build was also run to prove the SCSS, the url and the mask survive into the bundle, which vitest cannot catch since it does not process CSS.)
- [x] [robustness] Robustness (Five regression tests pin the TSX to SCSS contract - per-lane data-lane, data-collapsed including LIVE stale-flag rejection, and cards living in a box separate from the label strip. Honest caveat recorded: this story is almost entirely CSS, so those are guards rather than TDD-driven tests, and the colours still need a human eye.)
- [x] [resilience] Resilience (Independent re-sampling confirmed every colour I supplied - LIVE #cd8a8a and #ac3c3c, UPCOMING #a5a3a3, PREVIOUS #cccccc, sidebar #dddddd - and found one I had missed: the LIVE label strip is its own brighter stripe at #ee3030 and #e21515 with white lettering.)
- [~] [security] Security (No security surface. Stylesheet and a vendored 356-byte static SVG; no input, network or credential path.)
- [x] [defense-in-depth] Defense in depth (The stripe is used as a luminance mask rather than baking colours into the asset, so one vendored file serves both the lane and the brighter label strip from CSS variables. mask-mode luminance is required because the tile is opaque edge to edge and the default alpha mask yields a flat colour.)
- [x] [input-validation] Input validation (The asset was copied byte-identical, verified with diff, so a future re-sync from the classicy source is a plain copy rather than a merge.)
- [~] [thread-safety] Thread safety (No concurrency surface. Static styling with no shared mutable state.)
- [x] [configurability] Configurability (Lane ratios are flex-grow over a zero basis rather than fixed heights, so they hold at any window size. Criterion 6 as written summed to 6/5 of the window, which would have reintroduced the scrolling criterion 5 forbids; the 3:2:1 ratio is the only reading satisfying both, and that was flagged rather than silently resolved.)

## QA

tsc exit 0, vitest 289 files / 2950 tests, oxlint exit 0. Stripe verified in Chrome and via vite build. Merged into feat/radio-traffic-redesign.

## Work Log

### 2026-08-19T01:13:42.330Z - Implemented on story/022-lane-chrome @ 111ab00d. Two judgement calls the reviewer should know about. (1) Criterion 6: 3/5 + 2/5 + 1/5 = 6/5, which overflows the window by 20% and would reintroduce the scrolling criterion 5 forbids. Implemented as the RATIO 3:2:1 via flex-grow with flex-basis 0, which is the only reading that satisfies both criteria at any window size. (2) Card-scale interaction: PREVIOUS gets 1/6 of the column, about 95px in a 601px window, while a card is 124px * 1.25 = 155px tall, so PREVIOUS always scrolls its cards internally at the current --rt-card-scale. Lane heights are fixed and the overflow scrolls inside each lane's card box, which keeps all three label strips on screen. Stripe technique: stripe.svg vendored byte-identical (356 bytes) and used as a luminance mask over a coloured background, so one asset yields two CSS-controlled colours - verified in Chrome at 49.2/48.6 percent split, 44px period, same orientation as the design frame. Also found and implemented: the LIVE label strip is its own BRIGHTER stripe in the design (#ee3030/#e21515) with white lettering, which the brief did not mention.


### 2026-08-19T01:20:53.500Z - Proof completeness set PROVEN: Stripe pattern, per-lane borders and backgrounds, non-scrolling window and lane ratios. tsc exit 0, 289 files and 2949 tests pass, oxlint exit 0.

### 2026-08-19T01:20:53.591Z - Proof feature-availability set PROVEN: The stripe was verified in Chrome rather than assumed: 49.2/48.6 percent split, 44px period, colour constant along the anti-diagonal, matching the design orientation and period. vite build was also run to prove the SCSS, the url and the mask survive into the bundle, which vitest cannot catch since it does not process CSS.

### 2026-08-19T01:20:53.706Z - Proof robustness set PROVEN: Five regression tests pin the TSX to SCSS contract - per-lane data-lane, data-collapsed including LIVE stale-flag rejection, and cards living in a box separate from the label strip. Honest caveat recorded: this story is almost entirely CSS, so those are guards rather than TDD-driven tests, and the colours still need a human eye.

### 2026-08-19T01:20:53.870Z - Proof resilience set PROVEN: Independent re-sampling confirmed every colour I supplied - LIVE #cd8a8a and #ac3c3c, UPCOMING #a5a3a3, PREVIOUS #cccccc, sidebar #dddddd - and found one I had missed: the LIVE label strip is its own brighter stripe at #ee3030 and #e21515 with white lettering.

### 2026-08-19T01:20:53.996Z - Proof security set NOT_APPLICABLE: No security surface. Stylesheet and a vendored 356-byte static SVG; no input, network or credential path.

### 2026-08-19T01:20:54.089Z - Proof defense-in-depth set PROVEN: The stripe is used as a luminance mask rather than baking colours into the asset, so one vendored file serves both the lane and the brighter label strip from CSS variables. mask-mode luminance is required because the tile is opaque edge to edge and the default alpha mask yields a flat colour.

### 2026-08-19T01:20:54.181Z - Proof input-validation set PROVEN: The asset was copied byte-identical, verified with diff, so a future re-sync from the classicy source is a plain copy rather than a merge.

### 2026-08-19T01:20:54.274Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface. Static styling with no shared mutable state.

### 2026-08-19T01:20:54.371Z - Proof configurability set PROVEN: Lane ratios are flex-grow over a zero basis rather than fixed heights, so they hold at any window size. Criterion 6 as written summed to 6/5 of the window, which would have reintroduced the scrolling criterion 5 forbids; the 3:2:1 ratio is the only reading satisfying both, and that was flagged rather than silently resolved.

### 2026-08-19T01:20:54.543Z - Merged into feat/radio-traffic-redesign. Two things flagged for a human decision. First, criterion 6 as written summed to 6/5 of the window; implemented as the 3:2:1 ratio, the only reading that also satisfies the no-scroll criterion. Second, the lane ratio and the 1.25x card scale genuinely conflict - PREVIOUS gets about 95px of a 601px window while a scaled card is 155px, so PREVIOUS will always scroll internally until either the ratio or the scale gives.

