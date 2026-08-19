---
id: 019-5676
title: Assemble the Radio Traffic app shell
status: complete
priority: P2
type: feature
created: "2026-08-18T17:24:01.104Z"
updated: "2026-08-18T23:07:27.915Z"
dependencies: ["015", "018"]
plan: plans/radio-traffic-redesign.md
plan_step: Step 19
completed_at: "2026-08-18T23:07:27.914Z"
---

# Assemble the Radio Traffic app shell

## Problem Statement

The shell wires the tool palette, filter tree and three lanes into a Classicy window, subscribes to the mp3 channel, and persists its UI state. Persisted state in this codebase is treated as untrusted and sanitized on load.

## Acceptance Criteria

- [x] the app subscribes to mp3 on mount and unsubscribes on unmount
- [x] cards distribute into the three lanes
- [x] an active tag filter removes non-matching cards from every lane
- [x] re-checking a filter resumes a hidden clip at the correct clock offset rather than restarting at 0
- [x] exactly one LIVE player is unmuted by default
- [x] a clock jump over 5s reseeks mounted elements
- [x] checked tags, tool, lane collapse and laneOrder are persisted
- [x] a sanitize-on-load function covers all persisted fields and an unknown tool value falls back rather than dead-ending the UI
- [x] per-item mute state is either persisted or its reset is explicitly documented
- [x] the sub-minute getNowMs correction and calcSeekSeconds are ported, not rewritten
- [x] vitest run src/Applications/RadioTraffic/ passes

## Files

- packages/frontend/src/Applications/RadioTraffic/RadioTraffic.tsx
- packages/frontend/src/Applications/RadioTraffic/RadioTrafficContext.ts

## Proof

- [x] [completeness] Completeness (RadioTraffic.tsx, RadioTrafficContext.ts with reducer, manifest and sanitizer, styles and 36 tests, plus an appManifests.test.ts row. tsc exit 0, vitest 2882 tests pass, oxlint 0 errors.)
- [x] [feature-availability] Feature availability (Subscribe and unsubscribe on mount and unmount, lane distribution, filter removal across all three lanes, one-audible-by-default, jump reseek and persistence are all covered by behavioural tests against a real provider.)
- [x] [robustness] Robustness (The three criteria most likely to pass vacuously were each mutation-checked. Switching element lifetime from lanes to visible failed criterion 4. Removing the reconcileSolo effect failed 3 tests. Making sanitizeTool a pass-through failed 9 tests. Notably the criterion 4 mutation only failed when the dep array changed too, so the dep array is itself load-bearing.)
- [x] [resilience] Resilience (Element lifetime is keyed on lane membership rather than filter visibility, so a filtered-out clip keeps playing and returns at its clock offset instead of restarting at 0. The test asserts the same element object comes back and the badge reads in-sync, where a released and recreated element would sit at 0 and read minus 30 seconds.)
- [~] [security] Security (No security surface. Client-side composition over data already delivered; no new input, network call or credential handling.)
- [x] [defense-in-depth] Defense in depth (Persisted state is sanitized per field on load rather than all-or-nothing, covering unknown tool across five shapes, non-string tags, non-true collapse flags, malformed pins and non-finite mute ids. An unknown tool falls back rather than leaving the app in a mode with no handler.)
- [x] [input-validation] Input validation (sanitizeRadioTrafficState validates every persisted field on read-back, following the house pattern from radioScannerSettings and radioPlayback that treats stored state as untrusted.)
- [~] [thread-safety] Thread safety (No concurrency surface beyond React state and the coordinator singleton, which story 016 already covers.)
- [x] [configurability] Configurability (getNowMs stamps its anchor during render rather than in an effect: an effect runs after the render that already read the clock, so the first read after each tick would add the previous second on top of the new anchor and report the clock up to 1s ahead, which is exactly the badge in-sync tolerance. Mechanism is otherwise RadioScanner verbatim and calcSeekSeconds is reused unchanged.)

## QA

tsc exit 0, vitest 2882 passed, oxlint 0 errors. Criteria 4, 5 and 8 each mutation-verified. Manifest satisfies appManifests.test.ts including the scriptable allowlist and prefix-overlap checks. PR #442.

## Work Log

### 2026-08-18T22:32:10.516Z - Shell landed on story/019-app-shell-integration @ 1d056695 (GPG-signed, verified G). RadioTraffic.tsx + RadioTrafficContext.ts + radioTraffic.module.scss + app.png, co-located RadioTraffic.test.tsx (20 tests) and RadioTrafficContext.test.ts (16 tests), plus a RadioTraffic.app row in appManifests.test.ts. Element lifetime follows LANE membership, not filter visibility, so a filtered-away clip keeps running on the clock; reconcileSolo runs on every visible-mix change. ClockSource installed once with itemFor returning undefined for listener-started PREVIOUS clips. Sub-minute getNowMs correction ported from RadioScanner with the anchor stamped during render. sanitizeRadioTrafficState covers all five persisted fields with per-field fallback; per-card mute IS persisted, solo deliberately is not. Mutation-checked criteria 4, 5 and 8. Verification: tsc -b clean, vitest run 287 files / 2882 tests passed, oxlint exit 0 with no new warnings.


### 2026-08-18T23:07:26.872Z - Proof completeness set PROVEN: RadioTraffic.tsx, RadioTrafficContext.ts with reducer, manifest and sanitizer, styles and 36 tests, plus an appManifests.test.ts row. tsc exit 0, vitest 2882 tests pass, oxlint 0 errors.

### 2026-08-18T23:07:26.960Z - Proof feature-availability set PROVEN: Subscribe and unsubscribe on mount and unmount, lane distribution, filter removal across all three lanes, one-audible-by-default, jump reseek and persistence are all covered by behavioural tests against a real provider.

### 2026-08-18T23:07:27.046Z - Proof robustness set PROVEN: The three criteria most likely to pass vacuously were each mutation-checked. Switching element lifetime from lanes to visible failed criterion 4. Removing the reconcileSolo effect failed 3 tests. Making sanitizeTool a pass-through failed 9 tests. Notably the criterion 4 mutation only failed when the dep array changed too, so the dep array is itself load-bearing.

### 2026-08-18T23:07:27.140Z - Proof resilience set PROVEN: Element lifetime is keyed on lane membership rather than filter visibility, so a filtered-out clip keeps playing and returns at its clock offset instead of restarting at 0. The test asserts the same element object comes back and the badge reads in-sync, where a released and recreated element would sit at 0 and read minus 30 seconds.

### 2026-08-18T23:07:27.238Z - Proof security set NOT_APPLICABLE: No security surface. Client-side composition over data already delivered; no new input, network call or credential handling.

### 2026-08-18T23:07:27.337Z - Proof defense-in-depth set PROVEN: Persisted state is sanitized per field on load rather than all-or-nothing, covering unknown tool across five shapes, non-string tags, non-true collapse flags, malformed pins and non-finite mute ids. An unknown tool falls back rather than leaving the app in a mode with no handler.

### 2026-08-18T23:07:27.434Z - Proof input-validation set PROVEN: sanitizeRadioTrafficState validates every persisted field on read-back, following the house pattern from radioScannerSettings and radioPlayback that treats stored state as untrusted.

### 2026-08-18T23:07:27.534Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface beyond React state and the coordinator singleton, which story 016 already covers.

### 2026-08-18T23:07:27.626Z - Proof configurability set PROVEN: getNowMs stamps its anchor during render rather than in an effect: an effect runs after the render that already read the clock, so the first read after each tick would add the previous second on top of the new anchor and report the clock up to 1s ahead, which is exactly the badge in-sync tolerance. Mechanism is otherwise RadioScanner verbatim and calcSeekSeconds is reused unchanged.

### 2026-08-18T23:07:27.789Z - Merged into feat/radio-traffic-redesign, PR #442, commit 1d056695. Per-item mute IS persisted, restored into AudioState.muted at boot, with a test proving a persisted mute both silences that element and makes auto-solo skip to the next card. Solo is deliberately not persisted - reconcileSolo picks a target from what is actually live at boot, and a restored one would point at a clip from another hour. Lanes capped at 12 cards each since the back catalogue is ~755 items against a design that shows ~10. Registration in Desktop.tsx was done separately by the orchestrator in commit 135fd4aa, ahead of story 020, because deferring it left nineteen stories of UI invisible in pnpm dev.

