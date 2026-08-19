---
id: 015-2440
title: Build the filter tree sidebar
status: complete
priority: P2
type: feature
created: "2026-08-18T17:23:39.050Z"
updated: "2026-08-18T20:55:33.806Z"
dependencies: ["011"]
plan: plans/radio-traffic-redesign.md
plan_step: Step 15
completed_at: "2026-08-18T20:55:33.805Z"
---

# Build the filter tree sidebar

## Problem Statement

The 141px sidebar lists the 8 tag namespaces. The five small ones expand inline with checkboxes; the three large ones open the searchable picker and show a checked count instead.

## Acceptance Criteria

- [x] one row renders per namespace
- [x] the five small namespaces expand inline with checkboxes
- [x] the three large namespaces open the picker rather than expanding
- [x] a large namespace row shows its checked count
- [x] checking a value calls back with the tag string
- [x] checked state renders the check marker
- [x] a namespace with no values is omitted
- [x] the repo-local Disclosure component is used rather than ClassicyDisclosure, since only the former supports defaultOpen
- [x] vitest run FilterTree.test.tsx passes

## Files

- packages/frontend/src/Applications/RadioTraffic/FilterTree.tsx

## Proof

- [x] [completeness] Completeness (FilterTree.tsx with styles and 14 tests. tsc exit 0, vitest 2843 pass, lint 0 errors.)
- [x] [feature-availability] Feature availability (One row per namespace, five small ones expanding inline, three large ones opening the picker with a checked count, toggle callbacks, check markers, and empty-namespace omission - all behavioural.)
- [x] [robustness] Robustness (Counts intersect the group own values with the checked set rather than prefix-matching, so a checked tag the vocabulary no longer carries is not counted - it has no box in the picker either, so counting it would advertise a filter the user cannot reach to clear. There is a test for that.)
- [x] [resilience] Resilience (Decision 5 is implemented as one notice computed in one place: tags unavailable when nothing loaded, may be out of date when stale, rendered above an otherwise complete tree. A stale vocabulary keeps every row, checkbox and checked mark and is only annotated, so a dead HTTP side degrades rather than blanking the primary navigation.)
- [~] [security] Security (No security surface. Presentational sidebar over vocabulary already delivered.)
- [x] [defense-in-depth] Defense in depth (The blank case is reachable only when no good copy ever loaded, and it says so rather than rendering 141px of nothing. Two tests pin the stale and blank states separately.)
- [x] [input-validation] Input validation (Checkbox ids are namespaced as rt_filter_ so a label in the sidebar cannot address a box in the picker, which uses its own rt_tag_picker_ prefix. Empty namespaces are omitted rather than rendering an empty disclosure.)
- [~] [thread-safety] Thread safety (No concurrency surface. Props-only component with no internal state.)
- [x] [configurability] Configurability (OPEN_BY_DEFAULT is tier, link, agency and role - 18 values, sized to fit the tree area below the toolbar in a 601px window. topic 25 would more than double that so it opens on request; large namespaces are excluded since they have no disclosure to open.)

## QA

tsc exit 0, vitest 2843 passed, lint 0 errors. Merged into feat/radio-traffic-redesign, PR #442. Only failure repo-wide is basemapStyles.test.ts, pre-existing and environmental.

## Work Log

### 2026-08-18T20:46:18.595Z - FilterTree.tsx + FilterTree.test.tsx + filterTree.module.scss on story/015-filter-tree (58345445, GPG-signed). 14 tests green; full frontend suite 283 files / 2783 tests green; tsc -b and oxlint clean. Stale vocabulary renders in full with a role=status notice per Decision 5.


### 2026-08-18T20:55:13.240Z - Proof completeness set PROVEN: FilterTree.tsx with styles and 14 tests. tsc exit 0, vitest 2843 pass, lint 0 errors.

### 2026-08-18T20:55:13.338Z - Proof feature-availability set PROVEN: One row per namespace, five small ones expanding inline, three large ones opening the picker with a checked count, toggle callbacks, check markers, and empty-namespace omission - all behavioural.

### 2026-08-18T20:55:13.433Z - Proof robustness set PROVEN: Counts intersect the group own values with the checked set rather than prefix-matching, so a checked tag the vocabulary no longer carries is not counted - it has no box in the picker either, so counting it would advertise a filter the user cannot reach to clear. There is a test for that.

### 2026-08-18T20:55:13.522Z - Proof resilience set PROVEN: Decision 5 is implemented as one notice computed in one place: tags unavailable when nothing loaded, may be out of date when stale, rendered above an otherwise complete tree. A stale vocabulary keeps every row, checkbox and checked mark and is only annotated, so a dead HTTP side degrades rather than blanking the primary navigation.

### 2026-08-18T20:55:13.610Z - Proof security set NOT_APPLICABLE: No security surface. Presentational sidebar over vocabulary already delivered.

### 2026-08-18T20:55:13.698Z - Proof defense-in-depth set PROVEN: The blank case is reachable only when no good copy ever loaded, and it says so rather than rendering 141px of nothing. Two tests pin the stale and blank states separately.

### 2026-08-18T20:55:13.788Z - Proof input-validation set PROVEN: Checkbox ids are namespaced as rt_filter_ so a label in the sidebar cannot address a box in the picker, which uses its own rt_tag_picker_ prefix. Empty namespaces are omitted rather than rendering an empty disclosure.

### 2026-08-18T20:55:13.886Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface. Props-only component with no internal state.

### 2026-08-18T20:55:13.975Z - Proof configurability set PROVEN: OPEN_BY_DEFAULT is tier, link, agency and role - 18 values, sized to fit the tree area below the toolbar in a 601px window. topic 25 would more than double that so it opens on request; large namespaces are excluded since they have no disclosure to open.
