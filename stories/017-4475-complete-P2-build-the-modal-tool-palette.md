---
id: 017-4475
title: Build the modal tool palette
status: complete
priority: P2
type: feature
created: "2026-08-18T17:23:39.147Z"
updated: "2026-08-18T19:59:47.043Z"
dependencies: ["016"]
plan: plans/radio-traffic-redesign.md
plan_step: Step 17
started_at: "2026-08-18T19:54:31.234Z"
completed_at: "2026-08-18T19:59:47.042Z"
---

# Build the modal tool palette

## Problem Statement

The toolbar holds four modal tools that change what clicking a card does: arrow solos it, mute and unmute set its individual mute state, and hand drags to reorder. By default exactly one LIVE player is audible.

## Acceptance Criteria

- [x] exactly one tool is active at a time
- [x] arrow plus card click solos that card and mutes every other live card
- [x] mute plus click mutes only the clicked card
- [x] unmute plus click unmutes only the clicked card
- [x] hand plus click neither solos nor mutes
- [x] per-card mute state survives a tool change
- [x] a soloed card that ends, changes lane, or is hidden by a filter releases solo instead of silencing every card
- [x] the default audible target is deterministic - earliest start_date, tie-broken by lowest id - and re-runs when the current target leaves LIVE
- [x] placeholder glyphs are used for the four tool icons
- [x] vitest run toolMode.test.ts passes

## Files

- packages/frontend/src/Applications/RadioTraffic/toolMode.ts
- packages/frontend/src/Applications/RadioTraffic/ToolPalette.tsx

## Proof

- [x] [completeness] Completeness (toolMode.ts pure reducer with 34 tests, ToolPalette.tsx with 6, a setLevel seam on the coordinator with 6, and an additive startMs export. tsc exit 0, vitest 2615 pass, lint 0 errors.)
- [x] [feature-availability] Feature availability (All four tools, the exclusivity invariant, per-card mute survival across tool changes, all three solo-release exits and the auto-solo tie-break are covered by behavioural tests.)
- [x] [robustness] Robustness (The three solo-release exits are each built by a different mechanism - element ended while still LIVE by the clock, lane migration in both directions using the real laneFor, and tag-filter hide - and each asserts absence of silence rather than merely soloId becoming null. A proves-the-hazard test pins the failure mode without the guard.)
- [x] [resilience] Resilience (The stale-solo total-mute hazard is closed: effectiveMutedIds returns every playing id as muted when soloId is set but absent from the mix, which is reachable three ways in a card grid and invisible to the listener. Auto-solo is deterministic - earliest start_date, tie-broken by lowest id - and tested under reversed input order and the tz-less Directus datetime form.)
- [~] [security] Security (No security surface. Client-side audio routing over already-delivered URLs; no input, no network, no persistence.)
- [x] [defense-in-depth] Defense in depth (Two layers against divergence. A property test drives the full soloId by muted by id matrix asserting isAudible equals the tuner effectiveMutedIds answer, so the grid and RadioTuner cannot drift apart, and radioPlayback.ts itself is untouched.)
- [x] [input-validation] Input validation (applyToolClick is a total function over a four-value tool union and an id; unknown ids and repeated clicks are covered. setLevel holds the level on the registry entry and applies it only once play has resolved, so it cannot fight the autoplay gate that requires elements to start muted.)
- [~] [thread-safety] Thread safety (No concurrency surface. toolMode is a pure reducer over immutable state; setLevel mutates one registry entry owned by the single-threaded coordinator.)
- [~] [configurability] Configurability (Nothing to configure. The four tools are a closed union and the auto-solo rule is fixed; icons are swappable placeholder glyphs, which is asset replacement rather than configuration.)

## QA

tsc exit 0, vitest 2615 passed, lint 0 errors. All three solo-release exits tested by distinct mechanisms asserting absence of silence. Property test binds isAudible to effectiveMutedIds. PR #442.

## Work Log

### 2026-08-18T19:54:40.777Z - Implemented on branch story/017-tool-palette (commit a7d48dfa, GPG-signed). TDD: toolMode.test.ts (34 tests) + ToolPalette.test.tsx (6) + 6 new audioCoordinator setLevel tests written RED first, then toolMode.ts / ToolPalette.tsx / trafficTools.module.scss / audioCoordinator.setLevel. isAudible reuses radio-core effectiveMutedIds (property test cross-checks the two agree over the full solo x muted x id matrix) rather than a second solo model. reconcileSolo ports RadioScanner's solo-release for all three exits (element ended, lane migration forward+backward, tag filter hide), each asserting some card is still audible. autoSoloTarget: earliest start_date, tie-break lowest id, skipping manual mutes. Two documented consequences: muting the solo target releases the solo (otherwise a silent no-op), and audioCoordinator gained setLevel(itemId, audible) holding the level on the registry entry so tryPlay's post-autoplay-gate unmute honours it. startMs exported from radio-core/stationGrouping for tz-safe ordering. Verification: tsc -b clean, vitest run 266 files / 2591 tests passed, oxlint exit 0 with no RadioTraffic findings.

### 2026-08-18T19:59:05.188Z - Merged into feat/radio-traffic-redesign, PR #442, commit a7d48dfa. All three solo-release exits tested by different mechanisms and each asserting absence of silence rather than merely soloId null: element reported ended while still LIVE by the clock, lane migration in both directions using the real laneFor, and tag-filter hide. A proves-the-hazard test pins the failure without the guard. Two behaviours beyond the literal criteria, both documented in source: autoSoloTarget skips manually-muted cards, otherwise muting the target would be undone by the next reconcile re-soloing it; and muting the solo target releases the solo, because effectiveMutedIds keeps the target audible in spite of its manual mute, so without this the one card you are hearing is the one card you cannot mute. Added setLevel to the coordinator - it could not be el.muted at the call site because muted is already load-bearing for the autoplay gate. radioPlayback.ts untouched; a property test drives the full soloId x muted x id matrix asserting isAudible equals effectiveMutedIds so grid and tuner cannot drift. stationGrouping gained one additive startMs export, zero deletions.


### 2026-08-18T19:59:32.650Z - Proof completeness set PROVEN: toolMode.ts pure reducer with 34 tests, ToolPalette.tsx with 6, a setLevel seam on the coordinator with 6, and an additive startMs export. tsc exit 0, vitest 2615 pass, lint 0 errors.

### 2026-08-18T19:59:32.738Z - Proof feature-availability set PROVEN: All four tools, the exclusivity invariant, per-card mute survival across tool changes, all three solo-release exits and the auto-solo tie-break are covered by behavioural tests.

### 2026-08-18T19:59:32.829Z - Proof robustness set PROVEN: The three solo-release exits are each built by a different mechanism - element ended while still LIVE by the clock, lane migration in both directions using the real laneFor, and tag-filter hide - and each asserts absence of silence rather than merely soloId becoming null. A proves-the-hazard test pins the failure mode without the guard.

### 2026-08-18T19:59:32.924Z - Proof resilience set PROVEN: The stale-solo total-mute hazard is closed: effectiveMutedIds returns every playing id as muted when soloId is set but absent from the mix, which is reachable three ways in a card grid and invisible to the listener. Auto-solo is deterministic - earliest start_date, tie-broken by lowest id - and tested under reversed input order and the tz-less Directus datetime form.

### 2026-08-18T19:59:33.020Z - Proof security set NOT_APPLICABLE: No security surface. Client-side audio routing over already-delivered URLs; no input, no network, no persistence.

### 2026-08-18T19:59:33.125Z - Proof defense-in-depth set PROVEN: Two layers against divergence. A property test drives the full soloId by muted by id matrix asserting isAudible equals the tuner effectiveMutedIds answer, so the grid and RadioTuner cannot drift apart, and radioPlayback.ts itself is untouched.

### 2026-08-18T19:59:33.219Z - Proof input-validation set PROVEN: applyToolClick is a total function over a four-value tool union and an id; unknown ids and repeated clicks are covered. setLevel holds the level on the registry entry and applies it only once play has resolved, so it cannot fight the autoplay gate that requires elements to start muted.

### 2026-08-18T19:59:33.312Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface. toolMode is a pure reducer over immutable state; setLevel mutates one registry entry owned by the single-threaded coordinator.

### 2026-08-18T19:59:33.402Z - Proof configurability set NOT_APPLICABLE: Nothing to configure. The four tools are a closed union and the auto-solo rule is fixed; icons are swappable placeholder glyphs, which is asset replacement rather than configuration.
