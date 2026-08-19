---
id: 032-4135
title: "Radio Traffic countdown badge should use hh:mm:ss past 60 minutes"
status: complete
priority: P3
type: fix
created: "2026-08-19T01:05:30.115Z"
updated: "2026-08-19T02:28:07.698Z"
dependencies: []
started_at: "2026-08-19T02:23:49.447Z"
completed_at: "2026-08-19T02:28:07.698Z"
---

# Radio Traffic countdown badge should use hh:mm:ss past 60 minutes

## Problem Statement

The rtCardBadge "countdown" div in the new Radio Traffic app always renders mm:ss. Durations of 60 minutes or more roll over or display misleading minute counts instead of showing hours.

## Acceptance Criteria

- [x] Countdown renders as mm:ss when total duration is under 60 minutes
- [x] Countdown renders as hh:mm:ss when total duration is 60 minutes or more
- [x] Minutes and seconds are zero-padded to two digits in both formats
- [x] Unit tests cover the boundary (59:59, 60:00) and multi-hour durations

## Files

- packages/frontend/src

## Proof

- [x] [completeness] Completeness (countdownFor renders bare seconds under a minute, zero-padded MM:SS under an hour and zero-padded HH:MM:SS at an hour or more. Merged; suite green at 290 files and 3031 tests.)
- [x] [feature-availability] Feature availability (Tests cover the 59:59 and 60:00 boundary and multi-hour durations.)
- [x] [robustness] Robustness (Rounding still comes from radio-core countdownLabel and only the rendering is local, so the card and the tuner Coming Up list cannot disagree about how long is left. Hours split off here rather than in radio-core because ten other consumers already agree on the MM:SS form.)
- [x] [resilience] Resilience (The sub-minute short form was kept rather than broken: an existing deliberate test pins bare seconds under a minute, and that was reported as a caveat against criterion 1 instead of being silently overridden.)
- [~] [security] Security (No security surface. Pure string formatting of a duration.)
- [x] [defense-in-depth] Defense in depth (Formatting is a pure function of the remaining milliseconds, so it cannot disagree with itself across cards.)
- [x] [input-validation] Input validation (Zero-padding is applied in both formats and the boundary cases are pinned by tests rather than assumed.)
- [~] [thread-safety] Thread safety (No concurrency surface. Pure function.)
- [~] [configurability] Configurability (Nothing to configure. The thresholds are the units themselves.)

## QA

Merged into feat/radio-traffic-redesign. Suite green at 290 files / 3031 tests, tsc and oxlint clean.

## Work Log

### 2026-08-19T02:18:34.912Z - countdownFor now splits an hours field off radio-core's unbounded MM:SS: <60s stays the bare-seconds short form, <60m is zero-padded MM:SS, >=60m is zero-padded HH:MM:SS. Tests pin 59:59, the 60:00 boundary (now 01:00:00), 01:30:00, 02:00:13 and the corpus's 8h18m tape. Commit 25853a6a on story/badge-work.


### 2026-08-19T02:28:06.485Z - Proof completeness set PROVEN: countdownFor renders bare seconds under a minute, zero-padded MM:SS under an hour and zero-padded HH:MM:SS at an hour or more. Merged; suite green at 290 files and 3031 tests.

### 2026-08-19T02:28:06.592Z - Proof feature-availability set PROVEN: Tests cover the 59:59 and 60:00 boundary and multi-hour durations.

### 2026-08-19T02:28:06.685Z - Proof robustness set PROVEN: Rounding still comes from radio-core countdownLabel and only the rendering is local, so the card and the tuner Coming Up list cannot disagree about how long is left. Hours split off here rather than in radio-core because ten other consumers already agree on the MM:SS form.

### 2026-08-19T02:28:06.787Z - Proof resilience set PROVEN: The sub-minute short form was kept rather than broken: an existing deliberate test pins bare seconds under a minute, and that was reported as a caveat against criterion 1 instead of being silently overridden.

### 2026-08-19T02:28:06.904Z - Proof security set NOT_APPLICABLE: No security surface. Pure string formatting of a duration.

### 2026-08-19T02:28:07.023Z - Proof defense-in-depth set PROVEN: Formatting is a pure function of the remaining milliseconds, so it cannot disagree with itself across cards.

### 2026-08-19T02:28:07.120Z - Proof input-validation set PROVEN: Zero-padding is applied in both formats and the boundary cases are pinned by tests rather than assumed.

### 2026-08-19T02:28:07.207Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface. Pure function.

### 2026-08-19T02:28:07.293Z - Proof configurability set NOT_APPLICABLE: Nothing to configure. The thresholds are the units themselves.

### 2026-08-19T02:28:07.435Z - Merged at 25853a6a with 041 and 042 - all three land in cardStatus.ts and splitting them would have meant three passes over the same forty lines. Caveat on criterion 1: a sub-minute countdown still renders bare seconds, not 00:04, because story 009 pins that short form with a deliberate test. Reported rather than silently overridden.

