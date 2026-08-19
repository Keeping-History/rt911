---
id: 030-cdfa
title: Replace raw button elements in Radio Traffic with Classicy components
status: in_progress
priority: P1
type: refactor
created: "2026-08-19T00:53:03.216Z"
updated: "2026-08-19T03:33:13.000Z"
dependencies: ["022", "024", "027"]
plan: plans/radio-traffic-redesign.md
plan_step: Design parity
---

# Replace raw button elements in Radio Traffic with Classicy components

## Problem Statement

Radio Traffic renders eight raw HTML button elements across FilterTree, TrafficCard, CardTabBar, LaneSection and ToolPalette. Repo convention is to use Classicy components where one exists, so the app inherits Platinum styling, states and accessibility rather than reimplementing them per call site.

## Acceptance Criteria

- [ ] no raw button elements remain in RadioTraffic source, excluding tests
- [ ] the mute control uses ClassicyBevelButton in toggle mode with a controlled on state
- [ ] icon-only controls use the square prop rather than hand-rolled sizing
- [ ] existing behaviour and aria semantics are preserved, including the mute button stopPropagation guard that prevents a tool click and a button toggle firing from one press
- [ ] tests assert behaviour and state attributes rather than element tag names
- [ ] tsc, vitest and oxlint all pass

## Files

- packages/frontend/src/Applications/RadioTraffic/

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

