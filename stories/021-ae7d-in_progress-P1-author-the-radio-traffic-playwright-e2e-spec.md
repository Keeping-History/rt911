---
id: 021-ae7d
title: Author the Radio Traffic Playwright E2E spec
status: in_progress
priority: P1
type: task
created: "2026-08-18T17:24:01.209Z"
updated: "2026-08-19T04:16:36.000Z"
dependencies: ["019"]
plan: plans/radio-traffic-redesign.md
plan_step: Step 21
---

# Author the Radio Traffic Playwright E2E spec

## Problem Statement

No Radio E2E spec exists today - there are zero matches for RadioScanner under the e2e directory. Playwright is a required check and the frontend image job depends on it, so a red or missing E2E blocks both merge and the GHCR push.

## Acceptance Criteria

- [x] the app opens from the desktop
- [x] cards render into the LIVE, UPCOMING and PREVIOUS lanes
- [ ] checking a small-namespace tag narrows the visible cards
- [ ] opening the aircraft picker, typing and confirming narrows them further
- [x] each tool activates and shows as selected
- [x] a card tab bar switches panels
- [x] nothing is mocked - the spec drives the real app against the dev server
- [x] the clock is pinned or paused before asserting lane membership so cards cannot migrate mid-run
- [x] playwright test e2e/tests/radio-traffic.spec.ts passes

## Files

- packages/frontend/e2e/tests/radio-traffic.spec.ts

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

### 2026-08-18T23:31:41.928Z - E2E spec landed on story/021-e2e-spec (0a80720e). 4 of 6 scenarios proved against the real dev server + real streamer, nothing mocked: app opens from the desktop icon; cards render into LIVE/UPCOMING/PREVIOUS and do not migrate once the clock is pinned; all four tools activate exclusively; a card tab bar switches panels. The two tag-filter scenarios (small-namespace tag, aircraft picker) are SKIPPED at runtime because the deployed streamer 404s GET /mp3/tags, so FilterTree renders 'Tags unavailable.' with no checkbox and no Aircraft row. Their assertions were dry-run locally against a stubbed vocabulary and pass, and the skip is a runtime check so they self-enable when the route deploys. Clock pinned via Time Machine's own Pause button (new pinVirtualClock helper in e2e/fixtures). Also had to register <RadioTraffic /> in Desktop.tsx: story 019 explicitly deferred that to story 020, which has not landed, so there was no desktop icon to open.

### 2026-08-19T04:16:36.000Z - That branch was lost (never merged); re-authored packages/frontend/e2e/tests/radio-traffic.spec.ts fresh on `checkout`. `<RadioTraffic />` is already registered in Desktop.tsx on this branch (story 020's app-registration cleanup has since landed alongside it), so no source change was needed there this time — only the spec and a `pinVirtualClock` helper added to e2e/fixtures/index.ts.

7 of 9 criteria proved for real against the real dev server + the real (production) streamer, nothing mocked, run repeatedly (`playwright test e2e/tests/radio-traffic.spec.ts`, both default and single-worker): the app opens from its desktop icon; cards render into LIVE/UPCOMING/PREVIOUS; all four tools (Solo/Mute/Unmute/Move) activate exclusively; a card's tab bar switches panels (Details → Transcript); and the one test asserting lane membership pins the clock first and confirms two samples 4s apart land on the identical partition.

Two real bugs surfaced and got fixed along the way, both instructive:
- The tests all default to worker-parallel; running 5 at once each opens its own full session against the ONE real production streamer, which saturated badly enough that even a button click missed Playwright's default timeout. Fixed with `test.describe.configure({ mode: "serial" })` scoped to this file only — trades wall time for not hammering shared infrastructure with N simultaneous full boots.
- Pinning the clock immediately at the seeded 8:40 AM boot instant is a real trap: the UPCOMING lane reads MediaStreamProvider's forward-looking reveal buffer (not the history snapshot LIVE/PREVIOUS render from), and that window can genuinely hold nothing at all right at boot — no amount of extra wait fixes a lane with nothing upcoming to show once the clock that would have slid the window forward is frozen. Tried jumping the clock forward with Time Machine's own skip button instead; that surfaced a second issue — a large enough jump crosses an Alerts.app event boundary (e.g. "AA11 CRASHES") and pops a modal that blocks everything until dismissed, and dismissing it while the clock is still running let real time compound past FURTHER boundaries, cascading into more alerts and blowing the test timeout outright. Landed on the simplest robust order: open the app, let the clock run in ordinary real time, poll all three lanes with ONE combined `expect.poll` until every one has a card, and only then call `pinVirtualClock` to freeze the moment. `pinVirtualClock` itself never jumps the clock — its doc comment carries this reasoning for the next caller.

The two tag-filter criteria stay unchecked, honestly: `GET /mp3/tags` still 404s on the deployed streamer (this branch's backend changes haven't shipped — confirmed again by hand with curl), so FilterTree renders "Tags unavailable." with no checkboxes and the spec's `tagsAvailable()` guard makes both scenarios self-skip cleanly rather than fail. Their actual logic (checking a small-namespace checkbox and confirming the visible count narrows; opening the Aircraft picker, typing a real prefix of the first option's own label, confirming, and checking the count narrows further) was dry-run twice against a `page.route`-stubbed `/mp3/tags` response and passes — never committed, scratch-only. Status stays `pending`, not `complete`: this will self-resolve the moment the backend deploys, at which point re-running the suite should flip both boxes with no code change.

Verified stable over 4+ full runs (`pnpm --filter @rt911/frontend exec playwright test e2e/tests/radio-traffic.spec.ts`, default single-worker-after-serial config): 3/4 clean, 1 hit an unrelated Playwright "Protocol error … session closed" — a Chromium/session crash mid-run on this shared sandbox (other real services + other agent sessions on the same box), not an assertion failure; reran clean immediately after. Also ran the rest of the suite (14 pre-existing specs) at `--workers=2` to confirm the shared `e2e/fixtures/index.ts` change (added `pinVirtualClock`, nothing else touched) introduces no regression — all 14 passed.

