---
id: 026-3d11
title: "App-level fixes: settings window, audio overlay, station filtering, balloon help"
status: complete
priority: P1
type: fix
created: "2026-08-18T23:45:10.236Z"
updated: "2026-08-19T00:53:51.569Z"
dependencies: []
plan: plans/radio-traffic-redesign.md
plan_step: Design parity
completed_at: "2026-08-19T00:53:51.568Z"
---

# App-level fixes: settings window, audio overlay, station filtering, balloon help

## Problem Statement

Four app-level defects. There is no Settings window to change the waveform colour, the click-anywhere-to-start-audio overlay does not reliably dismiss, Radio Tuner broadcast stations appear in Radio Traffic when they belong to the tuner, and the toolbar buttons have no balloon help.

## Acceptance Criteria

- [x] a Settings window allows changing the waveform colour, modelled on the Radio Tuner settings window in radio-core RadioSettingsWindow
- [x] the waveform colour setting persists and is applied to every card
- [x] the click anywhere to start audio overlay dismisses reliably when the overlay or anywhere in the window is clicked
- [x] broadcast stations in BROADCAST_STATIONS are excluded from Radio Traffic, matching how RadioTuner filters TO them
- [x] each of the four toolbar buttons has ClassicyBalloon help
- [x] tsc, vitest and oxlint all pass

## Files

- packages/frontend/src/Applications/RadioTraffic/RadioTraffic.tsx
- packages/frontend/src/Applications/RadioTraffic/ToolPalette.tsx
- packages/frontend/src/Applications/RadioTraffic/RadioTrafficContext.ts

## Proof

- [x] [completeness] Completeness (A Radio Traffic settings window, overlay-dismissal fix, broadcast-station exclusion and toolbar balloon help. tsc exit 0, 289 files and 2932 tests pass, oxlint 0 errors.)
- [x] [feature-availability] Feature availability (The overlay fix is non-vacuous: with it reverted the two new regression tests fail, with it they pass.)
- [x] [robustness] Robustness (The overlay cause was found rather than guessed. retryBlockedPlayback skipped any element the clock did not claim, which is the right test for not restarting a merely-paused clip but wrong for one holding an audioBlocked token - a token is only cleared by a resolved play, so such an element kept it forever and no click could dismiss the overlay. Blocked-ness is now tracked per registry entry and retried unconditionally, while the paused branch keeps the clock claim.)
- [x] [resilience] Resilience (Two ordinary cases reached the stuck state: a listener-started PREVIOUS clip, for which itemFor returns undefined by design, and a LIVE card whose item arrived via the history snapshot or reveal buffer. The fix covers both without weakening the do-not-restart-a-paused-clip guarantee.)
- [~] [security] Security (No security surface. Client-side presentation and playback control over data already delivered; no new input, network call, credential or persistence path.)
- [x] [defense-in-depth] Defense in depth (The waveform colour reaches the card through the seam PeaksWaveform already reads - getComputedStyle color at draw time - rather than adding a second way to colour the canvas. Default is theme-following, so every pre-existing session renders unchanged with no migration.)
- [x] [input-validation] Input validation (The settings window uses the same draft model as the Radio Tuner one, so Cancel is genuinely free, and persisted values are read back through the existing sanitizing path.)
- [~] [thread-safety] Thread safety (No concurrency surface beyond existing React state and the coordinator singleton, neither of which this story changes.)
- [x] [configurability] Configurability (A Radio Traffic-specific settings window rather than extending the shared RadioSettingsWindow, which is hard-typed to RadioScannerSettings and renders viz mode, audio source, volume and five caption controls that Radio Traffic does not have. Serving both would have meant a union settings type plus a visibility prop threaded through a window the live Radio Tuner renders, to gain one colour picker. RadioTuner is untouched.)

## QA

tsc exit 0, vitest green, oxlint 0 errors. Merged into feat/radio-traffic-redesign at 289 files / 2944 tests.

## Work Log


### 2026-08-19T00:53:33.234Z - Proof security set NOT_APPLICABLE: No security surface. Client-side presentation and playback control over data already delivered; no new input, network call, credential or persistence path.

### 2026-08-19T00:53:33.325Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface beyond existing React state and the coordinator singleton, neither of which this story changes.

### 2026-08-19T00:53:50.388Z - Proof completeness set PROVEN: A Radio Traffic settings window, overlay-dismissal fix, broadcast-station exclusion and toolbar balloon help. tsc exit 0, 289 files and 2932 tests pass, oxlint 0 errors.

### 2026-08-19T00:53:50.470Z - Proof feature-availability set PROVEN: The overlay fix is non-vacuous: with it reverted the two new regression tests fail, with it they pass.

### 2026-08-19T00:53:50.555Z - Proof robustness set PROVEN: The overlay cause was found rather than guessed. retryBlockedPlayback skipped any element the clock did not claim, which is the right test for not restarting a merely-paused clip but wrong for one holding an audioBlocked token - a token is only cleared by a resolved play, so such an element kept it forever and no click could dismiss the overlay. Blocked-ness is now tracked per registry entry and retried unconditionally, while the paused branch keeps the clock claim.

### 2026-08-19T00:53:50.639Z - Proof resilience set PROVEN: Two ordinary cases reached the stuck state: a listener-started PREVIOUS clip, for which itemFor returns undefined by design, and a LIVE card whose item arrived via the history snapshot or reveal buffer. The fix covers both without weakening the do-not-restart-a-paused-clip guarantee.

### 2026-08-19T00:53:50.729Z - Proof defense-in-depth set PROVEN: The waveform colour reaches the card through the seam PeaksWaveform already reads - getComputedStyle color at draw time - rather than adding a second way to colour the canvas. Default is theme-following, so every pre-existing session renders unchanged with no migration.

### 2026-08-19T00:53:50.818Z - Proof input-validation set PROVEN: The settings window uses the same draft model as the Radio Tuner one, so Cancel is genuinely free, and persisted values are read back through the existing sanitizing path.

### 2026-08-19T00:53:50.908Z - Proof configurability set PROVEN: A Radio Traffic-specific settings window rather than extending the shared RadioSettingsWindow, which is hard-typed to RadioScannerSettings and renders viz mode, audio source, volume and five caption controls that Radio Traffic does not have. Serving both would have meant a union settings type plus a visibility prop threaded through a window the live Radio Tuner renders, to gain one colour picker. RadioTuner is untouched.
