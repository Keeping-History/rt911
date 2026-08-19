---
id: 010-17f4
title: Group the tag vocabulary and filter items by checked tags
status: complete
priority: P2
type: feature
created: "2026-08-18T17:23:19.895Z"
updated: "2026-08-18T20:55:30.731Z"
dependencies: ["007"]
plan: plans/radio-traffic-redesign.md
plan_step: Step 10
completed_at: "2026-08-18T20:55:30.730Z"
---

# Group the tag vocabulary and filter items by checked tags

## Problem Statement

The sidebar groups 1131 vocabulary rows into 8 namespaces and filters the card lanes. Three namespaces hold over 300 values each, so grouping must stay cheap and the large ones must be marked for the picker rather than inline rendering.

## Acceptance Criteria

- [x] vocabulary groups into the 8 namespaces ordered by sort NULLS LAST then value
- [x] aircraft, facility and person are marked large
- [x] an empty checked-set matches every item
- [x] checked tags OR together within a namespace
- [x] checked tags AND together across namespaces
- [x] an item with no tags is excluded once any filter is active
- [x] a namespace with 300+ values groups in a single pass
- [x] vitest run tagFilter.test.ts passes

## Files

- packages/frontend/src/Applications/RadioTraffic/tagFilter.ts
- packages/frontend/src/Applications/RadioTraffic/tagFilter.test.ts

## Proof

- [x] [completeness] Completeness (tagFilter.ts with groupVocabulary and matchesFilter, 15 tests. tsc exit 0, vitest 2843 tests pass, lint 0 errors.)
- [x] [feature-availability] Feature availability (All 8 namespaces group correctly and the OR-within AND-across asymmetry has a dedicated test holding item and checked-count constant, varying only whether the second checked tag shares the first namespace.)
- [x] [robustness] Robustness (Mutation verified three ways: multi-pass grouping failed only the single-pass test, OR-everywhere failed 4 tests, AND-everywhere failed 3. The single-pass fixture is 1131 rows at true live cardinality with namespace as a counting getter, so a multi-pass strategy reads it nine times.)
- [x] [resilience] Resilience (An empty checked-set matches everything and an item with no tags is excluded once any filter is active, both tested. Grouping preserves server order rather than re-sorting, so a curator sort cannot be silently discarded client-side.)
- [~] [security] Security (No security surface. Pure functions over vocabulary and tag data already delivered to the client.)
- [x] [defense-in-depth] Defense in depth (TagDef is imported from MediaStreamContext rather than redefined, so the client type cannot drift from the wire type independently.)
- [x] [input-validation] Input validation (matchesFilter handles undefined tags, an empty checked-set and tags absent from the vocabulary without throwing; groupVocabulary omits namespaces with no values.)
- [~] [thread-safety] Thread safety (No concurrency surface. Synchronous pure functions with no shared state.)
- [~] [configurability] Configurability (Nothing to configure. LARGE_NAMESPACES is a closed set fixed by measured live cardinality.)

## QA

tsc exit 0, vitest 2843 passed, lint 0 errors. Merged into feat/radio-traffic-redesign, PR #442. Only failure repo-wide is basemapStyles.test.ts, pre-existing and environmental.

## Work Log

### 2026-08-18T20:07:22.146Z - tagFilter.ts + tagFilter.test.ts landed TDD (RED verified before implementation). 15 tests. groupVocabulary buckets into a Map in one pass, preserving the server's ORDER BY sort NULLS LAST, tag order — TagDef carries no sort field (backend model.Tag omits it deliberately), so re-sorting client-side would discard a curator's ordering. matchesFilter ORs within a namespace and ANDs across, derived by splitting each checked tag at its first colon. Proved by mutation: multi-pass grouping -> 10179 namespace reads vs 1131; OR-everywhere fails 4 tests; AND-everywhere fails 3.

### 2026-08-18T20:19:40.247Z - Merged into feat/radio-traffic-redesign, PR #442, commit f5321cae. Reasoned deviation on criterion 1: TagDef carries no sort field by design - model/item.go says sort exists only to order the vocabulary and both queries apply that order server-side - so the client receives the result of the ordering, not its input, and cannot re-derive it. groupVocabulary therefore preserves incoming order; re-sorting by value client-side would discard a curator sort, the opposite of the criterion intent. Single-pass grouping proven by a 1131-row fixture at true live cardinality with namespace as a counting getter: a multi-pass strategy reads it nine times, 10179 reads, and only the single-pass test discriminates.


### 2026-08-18T20:54:25.480Z - Proof completeness set PROVEN: tagFilter.ts with groupVocabulary and matchesFilter, 15 tests. tsc exit 0, vitest 2843 tests pass, lint 0 errors.

### 2026-08-18T20:54:25.569Z - Proof feature-availability set PROVEN: All 8 namespaces group correctly and the OR-within AND-across asymmetry has a dedicated test holding item and checked-count constant, varying only whether the second checked tag shares the first namespace.

### 2026-08-18T20:54:25.662Z - Proof robustness set PROVEN: Mutation verified three ways: multi-pass grouping failed only the single-pass test, OR-everywhere failed 4 tests, AND-everywhere failed 3. The single-pass fixture is 1131 rows at true live cardinality with namespace as a counting getter, so a multi-pass strategy reads it nine times.

### 2026-08-18T20:54:25.761Z - Proof resilience set PROVEN: An empty checked-set matches everything and an item with no tags is excluded once any filter is active, both tested. Grouping preserves server order rather than re-sorting, so a curator sort cannot be silently discarded client-side.

### 2026-08-18T20:54:25.857Z - Proof security set NOT_APPLICABLE: No security surface. Pure functions over vocabulary and tag data already delivered to the client.

### 2026-08-18T20:54:25.973Z - Proof defense-in-depth set PROVEN: TagDef is imported from MediaStreamContext rather than redefined, so the client type cannot drift from the wire type independently.

### 2026-08-18T20:54:26.063Z - Proof input-validation set PROVEN: matchesFilter handles undefined tags, an empty checked-set and tags absent from the vocabulary without throwing; groupVocabulary omits namespaces with no values.

### 2026-08-18T20:54:26.221Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface. Synchronous pure functions with no shared state.

### 2026-08-18T20:54:26.324Z - Proof configurability set NOT_APPLICABLE: Nothing to configure. LARGE_NAMESPACES is a closed set fixed by measured live cardinality.
