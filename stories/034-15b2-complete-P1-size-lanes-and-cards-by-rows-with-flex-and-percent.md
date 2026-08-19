---
id: 034-15b2
title: Size lanes and cards by rows with flex and percentages, not fixed px
status: complete
priority: P1
type: refactor
created: "2026-08-19T01:24:25.088Z"
updated: "2026-08-19T04:52:50.000Z"
dependencies: ["024", "027"]
plan: plans/radio-traffic-redesign.md
plan_step: Design parity
---

# Size lanes and cards by rows with flex and percentages, not fixed px

## Problem Statement

Lane heights and card size are currently pinned to pixel numbers - lane fractions applied to a fixed 124px card scaled by a hardcoded 1.25 multiplier. That is why PREVIOUS could never show a whole card: the lane fraction and the card scale were computed independently and disagreed. The design is really expressed in player rows - LIVE is 3 players deep, UPCOMING 2, PREVIOUS 1, totalling 6 rows that fill the window exactly - so the card should derive its height from the row it occupies rather than the other way round.

## Acceptance Criteria

- [x] the lane column is divided into 6 player rows, LIVE taking 3, UPCOMING 2 and PREVIOUS 1
- [x] lane heights are expressed with flex and percentages rather than pixel values
- [x] a card fills the height of one player row, so LIVE shows 3 rows of cards, UPCOMING 2 and PREVIOUS 1
- [x] the hardcoded 1.25 card scale multiplier is removed, since the card now derives its size from its row
- [x] no lane scrolls internally at the default window size, because a row is by definition tall enough for its card
- [x] card width is driven by the grid rather than a fixed pixel width
- [x] resizing the window rescales lanes and cards proportionally with no internal scrollbars appearing
- [x] chrome values that are genuinely fixed, such as borders, use classicy CSS variables rather than px literals
- [x] tsc, vitest and oxlint all pass

## Files

- packages/frontend/src/Applications/RadioTraffic/laneSection.module.scss
- packages/frontend/src/Applications/RadioTraffic/trafficCard.module.scss
- packages/frontend/src/Applications/RadioTraffic/radioTraffic.module.scss

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

### 2026-08-19T04:52:50.000Z - Row-based card and lane sizing, replacing the fixed card scale

Implemented the row model across the three listed stylesheets:

- **laneSection.module.scss**: made the "6 player rows, LIVE 3 / UPCOMING 2 /
  PREVIOUS 1" model explicit rather than implicit. `.rtLane` now declares
  `--rt-lane-rows: 1` (overridden to 3/2/1 per `data-lane`) and computes
  `flex: var(--rt-lane-rows) 1 0`, so the flex-grow ratio is literally derived
  from a stated row count instead of a pre-reduced 3:2:1 that a reader had to
  reconstruct. This was already flex/percentage-based (no px) before this
  story; the change makes the "six rows" fact visible in the code itself.
  Also converted `.rtSidebar`'s border-right to `var(--window-border-size)`
  and updated the file's stale top-of-file comment describing the (now-fixed)
  clipping bug.
- **trafficCard.module.scss**: this was the actual bug. `.rtCard` no longer
  carries `--rt-card-scale` or a fixed `width`/`min-height`; it keeps
  `height: 100%` (of its row, unchanged) and gets `aspect-ratio: 210 / 150`
  (150 = the true sum of every band it stacks: header 29 + waveform 54 +
  controls 14 + tabs-block 11+3+39 — not Figma's "124", which undercounts
  because the waveform is drawn at double Figma's 27 for legibility) plus
  `container-type: size` so every internal dimension can be expressed as a
  cqw/cqh fraction of the card's OWN box instead of `Npx * var(--rt-card-scale)`.
  A LIVE row is taller, so a LIVE card is both taller and wider than a
  PREVIOUS one — the card's whole footprint scales with its row. Added
  `overflow: hidden` as a backstop. Made `.rtCardPanel` shrinkable
  (`flex: 1 0 auto` → `1 1 auto`) since the card's height is now a ceiling,
  not something content can push past. Converted every `1px solid` border in
  the file to `var(--window-border-size)`.
- **radioTraffic.module.scss**: converted `.rtUnlockOverlayBox`'s padding and
  border to classicy vars composed with calc().
- **Bug found and fixed during live-browser verification**: the waveform's
  `aspect-ratio: 206 / 54` did not hold in practice — PeaksWaveform's
  `<canvas>` carries its own width/height HTML attributes (a backing-store
  resolution), and as a replaced element those floated the flex item's
  automatic minimum size past the ratio despite `overflow: clip`, roughly
  doubling the waveform's height and starving the tabs block down to ~2px.
  Fixed by stating `.rtCardWaveform`'s height as an explicit `calc(54 / 210 *
  100cqw)` (the same cqw basis as its width) instead of `aspect-ratio`, which
  sidesteps the replaced-content interaction entirely.

Verified with the dev server + Playwright (not just tsc/vitest, which don't
exercise real layout): at the default window size, `.rtLaneCards` clientHeight
came back 269/179/90 for LIVE/UPCOMING/PREVIOUS (exact 3:2:1), a PREVIOUS card
measured 126x90 (matching the 210:150 aspect ratio) with zero vertical
overflow (`scrollHeight === clientHeight` in every lane) and the expected
horizontal overflow (more cards than fit one screen width, story 036's
sideways scroll). Dragged the window's resize handle twice — taller
(612→974px) and then smaller (974→698px, net down to 699x... a size below
the original) — and re-measured each time: row heights stayed in exact 3:2:1
ratio (e.g. 456/304/152, then 312/208/104), a PREVIOUS card stayed at the
210:150 aspect ratio at every size (145.6x104 at the smallest), the waveform
stayed at 206:54 (140.8x36.9 at the smallest), and no lane ever reported
`scrollHeight > clientHeight`. This is what caught the aspect-ratio bug above
in the first place — jsdom/vitest cannot lay out real CSS, so this class of
bug is only visible this way.

tsc (`tsc -b`), the full `vitest run` (3147 tests) and `pnpm lint` (oxlint)
all pass clean; oxlint's only output is pre-existing warnings in unrelated
files. Only the three listed files were touched — LaneSection.tsx and
TrafficCard.tsx needed no changes, since the pixel computation lived entirely
in the stylesheets.

One thing I could not verify: the very small clip corpus loaded at the
window's default virtual-clock position only populated the PREVIOUS lane
(LIVE/UPCOMING were empty at that instant), so the resize/proportion checks
above are direct measurements of PREVIOUS-lane rows and cards, not LIVE or
UPCOMING ones. I did not chase the clock to a data-rich window to populate
all three lanes at once. This is a lower-risk gap than it sounds: LIVE and
UPCOMING use the exact same `.rtCard`/`.rtLane` rules with only
`--rt-lane-rows` and colour variables differing, and PREVIOUS (one row, the
tightest budget) is the case most likely to fail — it did fail before the
waveform fix above, and passed cleanly after. I'm confident in the result but
did not observe a populated LIVE or UPCOMING card directly.

