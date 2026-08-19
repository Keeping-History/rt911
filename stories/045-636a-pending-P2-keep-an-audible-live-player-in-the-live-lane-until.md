---
id: "045-636a"
title: "Keep an audible LIVE player in the Live lane until muted or unselected"
status: in_progress
priority: P2
type: fix
created: 2026-08-19T02:48:20.224Z
updated: 2026-08-19T03:33:13.000Z
dependencies: []
---

# Keep an audible LIVE player in the Live lane until muted or unselected

## Problem Statement

In the Radio Traffic app, a LIVE player that is actively playing and unmuted can be moved out of the Live lane automatically. If the listener can hear it, it should stay put; only once it is muted or unselected may it move to the PREVIOUS lane.

## Acceptance Criteria

- [ ] A LIVE player that is playing and unmuted is never auto-removed from the Live lane
- [ ] Muting an audible LIVE player allows it to transition to the PREVIOUS lane
- [ ] Unselecting an audible LIVE player allows it to transition to the PREVIOUS lane
- [ ] Muted or unselected LIVE players continue to move to PREVIOUS as they do today
- [ ] Unit tests cover the audible-hold and the mute/unselect release paths

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

