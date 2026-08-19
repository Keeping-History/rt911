---
id: 011-b53f
title: Add a searchable multi-select picker for large namespaces
status: complete
priority: P2
type: feature
created: "2026-08-18T17:23:19.948Z"
updated: "2026-08-18T20:55:31.016Z"
dependencies: ["010"]
plan: plans/radio-traffic-redesign.md
plan_step: Step 11
completed_at: "2026-08-18T20:55:31.015Z"
---

# Add a searchable multi-select picker for large namespaces

## Problem Statement

The design shows about six values per sidebar group, but aircraft has 377, facility 372 and person 339. Those cannot be rendered as inline checkbox lists, so they open a searchable multi-select window instead.

## Acceptance Criteria

- [x] searchTags matches case-insensitively on value
- [x] prefix matches rank above substring matches
- [x] an empty query returns everything
- [x] the window lists a namespace values with checkboxes
- [x] typing narrows the list
- [x] checked values survive narrowing and are reported on confirm
- [x] Cancel discards pending changes
- [x] the search filters a prebuilt lowercased index rather than the raw array
- [x] vitest run tagSearch.test.ts TagPickerWindow.test.tsx passes

## Files

- packages/frontend/src/Applications/RadioTraffic/tagSearch.ts
- packages/frontend/src/Applications/RadioTraffic/TagPickerWindow.tsx

## Proof

- [x] [completeness] Completeness (tagSearch.ts and TagPickerWindow.tsx with 23 tests. tsc exit 0, vitest 2843 pass, lint 0 errors.)
- [x] [feature-availability] Feature availability (Case-insensitive match, prefix-above-substring ranking, empty query returns everything, typing narrows, checked survive narrowing and are reported on confirm, Cancel discards - all behavioural.)
- [x] [robustness] Robustness (Criterion 8 mutation-verified: swapping the prebuilt index for a per-keystroke toLowerCase failed only the counting test - expected 2262 to be 377 - while all nine other tagSearch tests still passed, proving that test is the only one that can distinguish the two implementations.)
- [x] [resilience] Resilience (The picker takes and returns the whole sidebar checked set, so the call site has no merge logic to get wrong; a test pins that facility and topic tags survive an aircraft confirm. Checkbox ids are namespaced so two pickers can be open at once, and the close box routes to cancel rather than confirm.)
- [~] [security] Security (No security surface. Client-side selection over vocabulary already delivered; no input leaves the browser.)
- [x] [defense-in-depth] Defense in depth (TagPickerForm is exported separately from the ClassicyWindow shell so the form is testable without window chrome, and searchTags trims the query so a whitespace-only search returns everything rather than nothing.)
- [x] [input-validation] Input validation (Query handling covers empty, whitespace-only, no-match and full-match cases; the index is built from the vocabulary rather than trusting caller-supplied shape.)
- [~] [thread-safety] Thread safety (No concurrency surface. Synchronous search over an in-memory index inside one component.)
- [~] [configurability] Configurability (Nothing to configure. Ranking and matching rules are fixed; which namespaces use the picker is owned by story 010 LARGE_NAMESPACES.)

## QA

tsc exit 0, vitest 2843 passed, lint 0 errors. Merged into feat/radio-traffic-redesign, PR #442. Only failure repo-wide is basemapStyles.test.ts, pre-existing and environmental.

## Work Log


### 2026-08-18T20:54:26.418Z - Proof completeness set PROVEN: tagSearch.ts and TagPickerWindow.tsx with 23 tests. tsc exit 0, vitest 2843 pass, lint 0 errors.

### 2026-08-18T20:54:26.510Z - Proof feature-availability set PROVEN: Case-insensitive match, prefix-above-substring ranking, empty query returns everything, typing narrows, checked survive narrowing and are reported on confirm, Cancel discards - all behavioural.

### 2026-08-18T20:54:26.600Z - Proof robustness set PROVEN: Criterion 8 mutation-verified: swapping the prebuilt index for a per-keystroke toLowerCase failed only the counting test - expected 2262 to be 377 - while all nine other tagSearch tests still passed, proving that test is the only one that can distinguish the two implementations.

### 2026-08-18T20:54:26.744Z - Proof resilience set PROVEN: The picker takes and returns the whole sidebar checked set, so the call site has no merge logic to get wrong; a test pins that facility and topic tags survive an aircraft confirm. Checkbox ids are namespaced so two pickers can be open at once, and the close box routes to cancel rather than confirm.

### 2026-08-18T20:54:26.843Z - Proof security set NOT_APPLICABLE: No security surface. Client-side selection over vocabulary already delivered; no input leaves the browser.

### 2026-08-18T20:54:26.934Z - Proof defense-in-depth set PROVEN: TagPickerForm is exported separately from the ClassicyWindow shell so the form is testable without window chrome, and searchTags trims the query so a whitespace-only search returns everything rather than nothing.

### 2026-08-18T20:54:27.024Z - Proof input-validation set PROVEN: Query handling covers empty, whitespace-only, no-match and full-match cases; the index is built from the vocabulary rather than trusting caller-supplied shape.

### 2026-08-18T20:54:27.117Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface. Synchronous search over an in-memory index inside one component.

### 2026-08-18T20:54:27.208Z - Proof configurability set NOT_APPLICABLE: Nothing to configure. Ranking and matching rules are fixed; which namespaces use the picker is owned by story 010 LARGE_NAMESPACES.
