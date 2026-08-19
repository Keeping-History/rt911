---
id: 039-f799
title: Radio Traffic Live column cannot be fully muted — muting one player auto-focuses the next
status: complete
priority: P2
type: fix
created: "2026-08-19T01:38:16.794Z"
updated: "2026-08-19T02:39:43.760Z"
dependencies: []
started_at: "2026-08-19T02:23:51.508Z"
completed_at: "2026-08-19T02:39:43.759Z"
---

# Radio Traffic Live column cannot be fully muted — muting one player auto-focuses the next

## Problem Statement

Muting every player in the Live column is impossible. Muting the currently focused player causes focus to move to the next player, which then starts playing audio, so there is always at least one unmuted player. The auto-focus/auto-play behaviour should not treat a user mute as a cue to promote another player.

## Acceptance Criteria

- [x] Muting the focused Live player does not move focus to another player
- [x] Muting every player in the Live column results in no audible audio
- [x] Mute state persists per player when new items arrive in the Live lane
- [x] Automatic focus advancement still works when a clip ends normally rather than being muted

## Files

- packages/frontend/src

## Related

- 037-e53e

## Proof

- [x] [completeness] Completeness (The LIVE column can now be silenced completely. Merged; suite green at 291 files and 3076 tests.)
- [x] [feature-availability] Feature availability (Mutation-checked both directions: dropping the guard fails the test that muting the focused card must not promote another, and suppressing hand-over entirely fails six tests including the one asserting a clip ENDING still promotes.)
- [x] [robustness] Robustness (A mute and an end previously arrived at reconcileSolo looking identical - soloId null - but the end had left the mix and the mute had not. applyToolClick now records soloReleasedByMute on the state it already returns, and reconcileSolo is its only reader.)
- [x] [resilience] Resilience (The stale-target clear still runs unconditionally, so a solo can never point at a ghost - the silent-total-mute hazard stays closed. An arrow click re-arms hand-over; unmute deliberately does not, since with no solo an unmuted card is audible on its own and re-arming would solo some other card and re-silence the one just restored.)
- [~] [security] Security (No security surface. Client-side playback state and badge rendering over already-delivered audio and metadata.)
- [x] [defense-in-depth] Defense in depth (isAudible is untouched, so the property test binding it to radioPlayback effectiveMutedIds still passes verbatim and the grid cannot drift from RadioTuner.)
- [x] [input-validation] Input validation (soloReleasedByMute is optional, so the persisted-mute restore path in the shell compiles and behaves unchanged - no shell edit was needed at all.)
- [~] [thread-safety] Thread safety (No concurrency surface beyond the existing coordinator singleton and React state.)
- [~] [configurability] Configurability (Nothing to configure. Hand-over is a rule, not a preference.)

## QA

Merged into feat/radio-traffic-redesign. Suite green at 291 files / 3076 tests, tsc and oxlint clean. Behaviour mutation-checked.

## Work Log

### 2026-08-19T02:31:06.784Z - TDD on branch story/playback-fixes (a8778473). RED first: reconcileSolo promoted card 11 after muting the focused card 10. Root cause: auto-solo is a HAND-OVER rule (fires when the focused clip LEAVES the mix, plus the startup case), but a mute reached reconcileSolo looking identical to an end - both arrive with soloId null. applyToolClick now records soloReleasedByMute when the muted card IS the solo target, and reconcileSolo declines to replace that one; an arrow click re-arms it. The ended / left-LIVE / filtered-away hand-over is untouched, proven by a mutation-check test beside the mute test. isAudible is unchanged, so the property test binding it to radioPlayback.effectiveMutedIds still holds and the grid and RadioTuner cannot drift. Full suite 290 files / 3055 tests green; tsc -b and oxlint clean.


### 2026-08-19T02:39:22.047Z - Proof security set NOT_APPLICABLE: No security surface. Client-side playback state and badge rendering over already-delivered audio and metadata.

### 2026-08-19T02:39:22.255Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface beyond the existing coordinator singleton and React state.

### 2026-08-19T02:39:24.401Z - Proof completeness set PROVEN: The LIVE column can now be silenced completely. Merged; suite green at 291 files and 3076 tests.

### 2026-08-19T02:39:24.550Z - Proof feature-availability set PROVEN: Mutation-checked both directions: dropping the guard fails the test that muting the focused card must not promote another, and suppressing hand-over entirely fails six tests including the one asserting a clip ENDING still promotes.

### 2026-08-19T02:39:24.684Z - Proof robustness set PROVEN: A mute and an end previously arrived at reconcileSolo looking identical - soloId null - but the end had left the mix and the mute had not. applyToolClick now records soloReleasedByMute on the state it already returns, and reconcileSolo is its only reader.

### 2026-08-19T02:39:24.862Z - Proof resilience set PROVEN: The stale-target clear still runs unconditionally, so a solo can never point at a ghost - the silent-total-mute hazard stays closed. An arrow click re-arms hand-over; unmute deliberately does not, since with no solo an unmuted card is audible on its own and re-arming would solo some other card and re-silence the one just restored.

### 2026-08-19T02:39:25.034Z - Proof defense-in-depth set PROVEN: isAudible is untouched, so the property test binding it to radioPlayback effectiveMutedIds still passes verbatim and the grid cannot drift from RadioTuner.

### 2026-08-19T02:39:25.181Z - Proof input-validation set PROVEN: soloReleasedByMute is optional, so the persisted-mute restore path in the shell compiles and behaves unchanged - no shell edit was needed at all.

### 2026-08-19T02:39:25.329Z - Proof configurability set NOT_APPLICABLE: Nothing to configure. Hand-over is a rule, not a preference.

### 2026-08-19T02:39:43.353Z - Merged at a8778473 with 038. No shell change was needed - soloReleasedByMute is optional, so the persisted-mute restore path compiles unchanged.

