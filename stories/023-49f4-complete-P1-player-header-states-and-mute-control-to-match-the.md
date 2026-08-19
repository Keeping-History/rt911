---
id: 023-49f4
title: Player header states and mute control to match the design
status: complete
priority: P1
type: fix
created: "2026-08-18T23:45:10.057Z"
updated: "2026-08-19T00:53:51.126Z"
dependencies: []
plan: plans/radio-traffic-redesign.md
plan_step: Design parity
completed_at: "2026-08-19T00:53:51.126Z"
---

# Player header states and mute control to match the design

## Problem Statement

Card headers do not reflect lane or playback state. All lanes look alike, UPCOMING is not visually inactive, playing cards are not distinguished, and mute state is shown as the word MUTED rather than a speaker control the user can click.

## Acceptance Criteria

- [x] LIVE card headers are #ff4f6d, UPCOMING #2b2b2b and PREVIOUS #1010ff, sampled from the design frame
- [x] the UPCOMING card interface is visually grayed out to read as not yet active
- [x] a card that is actually playing and unmuted renders at increased brightness and colour saturation
- [x] the word MUTED is replaced by a mute/unmute button using speaker icons
- [x] the mute button toggles that card own mute state and reflects it
- [x] cards are scaled up by a factor of 1.25

## Files

- packages/frontend/src/Applications/RadioTraffic/TrafficCard.tsx
- packages/frontend/src/Applications/RadioTraffic/trafficCard.module.scss

## Proof

- [x] [completeness] Completeness (Lane-keyed header colours, grayed UPCOMING chrome, audible brightening, a real mute toggle and 1.25x scaling. tsc exit 0, 288 files and 2918 tests pass, oxlint 0 errors.)
- [x] [feature-availability] Feature availability (Behaviour is asserted through data-lane and data-audible attributes rather than hex values, so the tests survive a palette change while still pinning the mechanism. All 12 new tests were confirmed red before implementation.)
- [x] [robustness] Robustness (Re-sampling the design frame disproved part of the brief: each lane has two tones, not one, and the values I supplied were the bright ones. PREVIOUS idle is #000088 and playing is #0000ff, not the #1010ff I gave. Lane colour and the playing state are therefore one mechanism, implemented as a single lane-by-audible table.)
- [x] [resilience] Resilience (audible is derived as lane not upcoming and not paused and not muted, reusing the existing effectiveMutedIds and isAudible model rather than a second mute source of truth. A muted clip still advances, since the coordinator silences rather than pauses to hold sync.)
- [~] [security] Security (No security surface. Client-side presentation and playback control over data already delivered; no new input, network call, credential or persistence path.)
- [x] [defense-in-depth] Defense in depth (The mute button stops propagation on pointerup because both the lane slot and the card slot apply the active tool on pointerup - without it, one press under the mute tool would both mute via the tool and toggle via the button. There is a dedicated test for that.)
- [x] [input-validation] Input validation (The button carries an aria-label naming the action and aria-pressed carrying the state, and the header lane attribute is derived from the same prop the card frame uses so the two cannot diverge.)
- [~] [thread-safety] Thread safety (No concurrency surface beyond existing React state and the coordinator singleton, neither of which this story changes.)
- [x] [configurability] Configurability (Scaling is a single --rt-card-scale custom property with every length as calc over the original Figma number, so the scale is one edit rather than a sweep. No new px literals were introduced.)

## QA

tsc exit 0, vitest green, oxlint 0 errors. Merged into feat/radio-traffic-redesign at 289 files / 2944 tests.

## Work Log

### 2026-08-19T00:48:12.509Z - Card chrome parity: lane-coloured headers as a lane x audible table in trafficCard.module.scss (LIVE #ad001d -> #ff4f6d, PREVIOUS #000088 -> #0000ff, UPCOMING #2b2b2b + dimmed player chrome); data-audible on the card marks playing+unmuted; MUTED text replaced by an aria-pressed speaker button taking onToggleMute; whole card scaled 1.25 via --rt-card-scale over the existing Figma numbers. 12 new behavioural tests, no hex assertions. Pixel note: sampled #0000ff/#000088 for PREVIOUS, not #1010ff; #ff4f6d and #1010ff are the PLAYING variants, not the lane base.


### 2026-08-19T00:53:32.833Z - Proof security set NOT_APPLICABLE: No security surface. Client-side presentation and playback control over data already delivered; no new input, network call, credential or persistence path.

### 2026-08-19T00:53:32.929Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface beyond existing React state and the coordinator singleton, neither of which this story changes.

### 2026-08-19T00:53:34.170Z - Proof completeness set PROVEN: Lane-keyed header colours, grayed UPCOMING chrome, audible brightening, a real mute toggle and 1.25x scaling. tsc exit 0, 288 files and 2918 tests pass, oxlint 0 errors.

### 2026-08-19T00:53:34.271Z - Proof feature-availability set PROVEN: Behaviour is asserted through data-lane and data-audible attributes rather than hex values, so the tests survive a palette change while still pinning the mechanism. All 12 new tests were confirmed red before implementation.

### 2026-08-19T00:53:34.373Z - Proof robustness set PROVEN: Re-sampling the design frame disproved part of the brief: each lane has two tones, not one, and the values I supplied were the bright ones. PREVIOUS idle is #000088 and playing is #0000ff, not the #1010ff I gave. Lane colour and the playing state are therefore one mechanism, implemented as a single lane-by-audible table.

### 2026-08-19T00:53:34.475Z - Proof resilience set PROVEN: audible is derived as lane not upcoming and not paused and not muted, reusing the existing effectiveMutedIds and isAudible model rather than a second mute source of truth. A muted clip still advances, since the coordinator silences rather than pauses to hold sync.

### 2026-08-19T00:53:34.605Z - Proof defense-in-depth set PROVEN: The mute button stops propagation on pointerup because both the lane slot and the card slot apply the active tool on pointerup - without it, one press under the mute tool would both mute via the tool and toggle via the button. There is a dedicated test for that.

### 2026-08-19T00:53:34.844Z - Proof input-validation set PROVEN: The button carries an aria-label naming the action and aria-pressed carrying the state, and the header lane attribute is derived from the same prop the card frame uses so the two cannot diverge.

### 2026-08-19T00:53:34.957Z - Proof configurability set PROVEN: Scaling is a single --rt-card-scale custom property with every length as calc over the original Figma number, so the scale is one edit rather than a sweep. No new px literals were introduced.

### 2026-08-19T01:25:04.476Z - SUPERSEDED IN PART by story 034. Criterion 6, cards scaled up by a factor of 1.25, was the wrong mechanism: a fixed multiplier over fixed px card dimensions is computed independently of the lane height, which is why PREVIOUS could never fit a whole card. The design is expressed in player rows - LIVE 3 deep, UPCOMING 2, PREVIOUS 1, six rows filling the window - so the card derives its height from its row instead. The visual intent of criterion 6, larger cards, is preserved; the hardcoded multiplier goes.

