---
id: 031-2de0
title: Move the Play Original Recording setting to Radio Traffic
status: complete
priority: P1
type: feature
created: "2026-08-19T00:53:03.289Z"
updated: "2026-08-19T02:28:29.372Z"
dependencies: []
plan: plans/radio-traffic-redesign.md
plan_step: Design parity
completed_at: "2026-08-19T02:28:29.371Z"
---

# Move the Play Original Recording setting to Radio Traffic

## Problem Statement

The Play Original Recording toggle, which selects the source recording over the noise-reduced render, currently lives in the shared radio-core settings window and is surfaced by Radio Tuner. It belongs to Radio Traffic. Radio Traffic also does not yet honour it at all, since its audio path builds URLs through the coordinator rather than through resolveAudioUrl.

## Acceptance Criteria

- [x] the Play Original Recording control appears in the Radio Traffic settings window
- [x] Radio Traffic honours the setting by resolving audio through resolveAudioUrl rather than the raw item url
- [x] the setting persists in RadioTrafficContext and is declared in its registerApp manifest
- [x] the control is removed from the Radio Tuner settings surface
- [x] RadioTuner still builds and its tests pass unchanged
- [x] changing the setting takes effect for cards without requiring a reload
- [x] tsc, vitest and oxlint all pass

## Files

- packages/frontend/src/Applications/RadioTraffic/
- packages/frontend/src/Applications/radio-core/RadioSettingsWindow.tsx
- packages/frontend/src/Applications/RadioTuner/

## Proof

- [x] [completeness] Completeness (Play Original Recording moved to the Radio Traffic settings window, persisted in RadioTrafficContext with a manifest entry, honoured through resolveAudioUrl, and removed from the shared window. Merged; suite green at 290 files and 3031 tests.)
- [x] [feature-availability] Feature availability (A test asserts element IDENTITY across a settings change plus that the id never appears in released, so criterion 6 is proved by the element surviving rather than by the URL merely changing.)
- [x] [robustness] Robustness (Changing the source re-points the same element rather than remounting, which matters beyond tidiness: audioCapture createMediaElementSource may be called only once per element and the capture is permanent, so a teardown would silently orphan every card waveform graph.)
- [x] [resilience] Resilience (Scoped re-run across the blast radius - RadioTuner, RadioScanner, radio-core and appManifests - passed 27 files and 348 tests, confirming the shared-window edit did not disturb a live app.)
- [~] [security] Security (No security surface. A client-side preference selecting between two already-public audio renders.)
- [x] [defense-in-depth] Defense in depth (The manifest declares the new field per the strict rules pinned by appManifests.test.ts - looseObject, optional, described, params naming exactly what the reducer reads - so a schema drift would fail that suite rather than silently dev-warn.)
- [x] [input-validation] Input validation (The persisted value is read back through sanitizeRadioTrafficState, so a hand-edited or stale stored value falls back per field rather than putting the app in an undefined state.)
- [~] [thread-safety] Thread safety (No concurrency surface. A boolean setting read during render.)
- [x] [configurability] Configurability (The setting is the configuration; it is surfaced in one window and read in one place, rather than duplicated per card.)

## QA

Merged. Suite green at 290 files / 3031 tests, tsc and oxlint clean. Blast-radius re-run across RadioTuner, RadioScanner, radio-core and appManifests passed 27 files / 348 tests.

## Work Log

### 2026-08-19T02:17:16.652Z - Moved Play Original Recording from radio-core's shared RadioSettingsWindow to Radio Traffic's own settings window. RadioTrafficSettings (renamed from WaveformColorSettings) now carries playOriginalAudio, sanitised, persisted and declared in the registerApp manifest. The shell resolves every card's audio through resolveAudioUrl(item, settings.playOriginalAudio) and re-runs that effect on the setting, so audioCoordinator.ensure re-points the SAME element at the new src — no reload, no release, no orphaned audioCapture graph. Removed the control from the shared window; RadioTuner and RadioScanner still honour a previously-saved value but can no longer change one. tsc clean, oxlint exit 0, 348/348 radio + manifest tests green.


### 2026-08-19T02:28:05.484Z - Proof completeness set PROVEN: Play Original Recording moved to the Radio Traffic settings window, persisted in RadioTrafficContext with a manifest entry, honoured through resolveAudioUrl, and removed from the shared window. Merged; suite green at 290 files and 3031 tests.

### 2026-08-19T02:28:05.607Z - Proof feature-availability set PROVEN: A test asserts element IDENTITY across a settings change plus that the id never appears in released, so criterion 6 is proved by the element surviving rather than by the URL merely changing.

### 2026-08-19T02:28:05.745Z - Proof robustness set PROVEN: Changing the source re-points the same element rather than remounting, which matters beyond tidiness: audioCapture createMediaElementSource may be called only once per element and the capture is permanent, so a teardown would silently orphan every card waveform graph.

### 2026-08-19T02:28:05.847Z - Proof resilience set PROVEN: Scoped re-run across the blast radius - RadioTuner, RadioScanner, radio-core and appManifests - passed 27 files and 348 tests, confirming the shared-window edit did not disturb a live app.

### 2026-08-19T02:28:05.955Z - Proof security set NOT_APPLICABLE: No security surface. A client-side preference selecting between two already-public audio renders.

### 2026-08-19T02:28:06.062Z - Proof defense-in-depth set PROVEN: The manifest declares the new field per the strict rules pinned by appManifests.test.ts - looseObject, optional, described, params naming exactly what the reducer reads - so a schema drift would fail that suite rather than silently dev-warn.

### 2026-08-19T02:28:06.167Z - Proof input-validation set PROVEN: The persisted value is read back through sanitizeRadioTrafficState, so a hand-edited or stale stored value falls back per field rather than putting the app in an undefined state.

### 2026-08-19T02:28:06.274Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface. A boolean setting read during render.

### 2026-08-19T02:28:06.384Z - Proof configurability set PROVEN: The setting is the configuration; it is surfaced in one window and read in one place, rather than duplicated per card.

### 2026-08-19T02:28:07.366Z - Merged into feat/radio-traffic-redesign at 8b6781c5. IMPROVEMENT flagged by the agent: playOriginalAudio remains in RadioScannerSettings, both context manifests and the two player props, so Tuner and Scanner still honour a previously saved value but can no longer change it. Deliberately not ripped out - that would touch a live app manifest and radio-core sanitiser tests, colliding with criterion 5. Story 020 is the natural place.

### 2026-08-19T02:28:29.247Z - Criterion 7 was correctly left unchecked by the agent: the suite was red at the time due to a stale assertion in DetailsTab.test.tsx, which commit 08d6012b caused by renaming the Details column heading without updating its test. Fixed in 13510f67; suite now green at 290 files and 3031 tests, so the criterion is genuinely met.

