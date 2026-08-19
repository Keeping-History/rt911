---
id: "047-d872"
title: "Set collapsed rtLaneSlot flex to 0 0 calc(20% - gap/2)"
status: pending
priority: P3
type: fix
created: 2026-08-19T02:51:53.382Z
updated: 2026-08-19T02:51:53.382Z
dependencies: []
---

# Set collapsed rtLaneSlot flex to 0 0 calc(20% - gap/2)

## Problem Statement

In the Radio Traffic app, the rtLaneSlot[data-collapsed=true] rule needs its flex property set to "0 0 calc(20% - var(--rt-lane-gap) / 2)" so collapsed lanes size correctly.

## Acceptance Criteria

- [ ] rtLaneSlot[data-collapsed=true] declares flex: 0 0 calc(20% - var(--rt-lane-gap) / 2)
- [ ] [VISUAL] Collapsed lanes render at the intended width with correct gap spacing

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

