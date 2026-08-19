---
id: 029-1caa
title: Replace px literals in Radio Traffic styles with CSS variables
status: in_progress
priority: P2
type: refactor
created: "2026-08-19T00:05:01.158Z"
updated: "2026-08-19T03:33:13.000Z"
dependencies: ["022", "023", "024", "025", "026", "027", "028", "030", "034"]
plan: plans/radio-traffic-redesign.md
plan_step: Design parity
---

# Replace px literals in Radio Traffic styles with CSS variables

## Problem Statement

The Radio Traffic stylesheets use around 100 hardcoded px values across seven files. The house pattern is classicy CSS custom properties such as --window-border-size, --window-padding-size and --window-control-size, composed with calc, so the UI scales with the system settings rather than being pinned to one pixel grid.

## Acceptance Criteria

- [ ] px literals in the Radio Traffic SCSS are replaced with classicy CSS variables or calc expressions over them
- [ ] --window-border-size, --window-padding-size and --window-control-size are used where they apply
- [ ] all seven RadioTraffic stylesheets are covered including tabs
- [ ] the rendered layout is unchanged at default settings
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

