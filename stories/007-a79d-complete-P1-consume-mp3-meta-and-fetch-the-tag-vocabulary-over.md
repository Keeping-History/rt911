---
id: 007-a79d
title: Consume mp3_meta and fetch the tag vocabulary over HTTP
status: complete
priority: P1
type: feature
created: "2026-08-18T17:22:54.728Z"
updated: "2026-08-18T19:59:46.751Z"
dependencies: ["005", "006"]
plan: plans/radio-traffic-redesign.md
plan_step: Step 7
completed_at: "2026-08-18T19:59:46.750Z"
---

# Consume mp3_meta and fetch the tag vocabulary over HTTP

## Problem Statement

The frontend needs the per-item metadata from the socket and the tag vocabulary from HTTP, and must stay usable when either transport degrades. An empty filter tree is feature loss because tag filtering is the primary navigation.

## Acceptance Criteria

- [x] an mp3_meta frame populates mp3Meta keyed by item id
- [x] a later seek leaves mp3Meta intact
- [x] an id with no metadata yields undefined rather than throwing
- [x] fetchTagVocabulary never rejects
- [x] on any failure it returns the cached copy marked stale, and [] only when there is no cache
- [x] the vocabulary is fetched once per page load through a shared promise
- [x] a generation mismatch against the mp3_meta frame triggers exactly one refetch, not a loop
- [x] STREAM_HTTP_BASE reuses chatHttpBase(STREAM_URL) with no new VITE_ variable
- [x] metadata is exempt from reveal-gating and retention pruning
- [x] vitest run src/Providers/MediaStream/ passes

## Files

- packages/frontend/src/Providers/MediaStream/MediaStreamContext.ts
- packages/frontend/src/Providers/MediaStream/MediaStreamProvider.tsx
- packages/frontend/src/Applications/RadioTraffic/tagVocabulary.ts

## Proof

- [x] [completeness] Completeness (mp3Meta and mp3MetaGeneration on the MediaStream context, tagVocabulary.ts with the stale-fallback fetch, and STREAM_HTTP_BASE reusing chatHttpBase with no new VITE variable. tsc exit 0, vitest 2615 tests pass, lint 0 errors.)
- [x] [feature-availability] Feature availability (Exemption from reveal-gating and retention proven behaviourally: seeking ten minutes and asserting the seek went out and the answering frames landed, then ticking past a clip end_date to run the retention pass - metadata survives both.)
- [x] [robustness] Robustness (fetchTagVocabulary tested for non-ok, thrown fetch, non-JSON body, rejected promise, and a 200 with no vocabulary array; each returns the cached copy marked stale. With no cache it returns an empty list marked stale rather than rejecting.)
- [x] [resilience] Resilience (The plan sketch would have blanked a working filter tree: body.vocabulary ?? [] treats a malformed 200 as success. A non-array vocabulary is now a failure while a genuine empty array is accepted as a real answer, with tests pinning both directions. The single-refetch guard terminates even when a replica keeps answering the old generation.)
- [~] [security] Security (No security surface. An anonymous GET of public reference data the streamer already serves, with no credentials, no cookie and no request headers set.)
- [x] [defense-in-depth] Defense in depth (Two independent guards against a dead HTTP side. The fetch never rejects, and it falls back to last-known-good marked stale rather than empty, because tag filtering is the primary navigation and an empty tree is closer to feature loss than a cosmetic gap.)
- [x] [input-validation] Input validation (Every failure mode of the response is validated rather than assumed: status, JSON parseability, and the shape of the vocabulary field. Wire fidelity is tested against real msgpack bytes with integer map keys, matching what Go map[int]ItemMeta actually emits.)
- [~] [thread-safety] Thread safety (No concurrency surface beyond the shared in-flight promise, which is the standard pattern from stationLogos and is tested for concurrent callers issuing a single request.)
- [~] [configurability] Configurability (Nothing to configure. The endpoint derives from the existing STREAM_URL; adding a VITE variable would need a Dockerfile ARG and ENV plus a workflow build-arg, where a missing declaration shows up only as production silently using a default.)

## QA

tsc exit 0, vitest 2615 passed, lint 0 errors. Stale fallback and single-refetch both test-locked; wire fidelity tested against real msgpack bytes with integer map keys. PR #442.

## Work Log

### 2026-08-18T19:54:48.523Z - Implemented on story/007-consume-mp3-meta: mp3Meta + mp3MetaGeneration on the MediaStream context (exempt from reveal gate, retention and the seek clear); RadioTraffic/tagVocabulary.ts reading GET /mp3/tags through STREAM_HTTP_BASE (chatHttpBase(STREAM_URL)) with a shared in-flight promise, stale-but-usable fallback and a single refetch per mismatched generation. 24 new tests; frontend suite 2569 passed, tsc -b clean, lint clean.

### 2026-08-18T19:59:05.107Z - Merged into feat/radio-traffic-redesign, PR #442, commit edb90388. Two catches worth keeping. First, the plan code sketch used body.vocabulary ?? [] which would treat a malformed 200 as success and blank a working filter tree; a non-array vocabulary is now treated as failure while a genuine empty array is still accepted, with tests pinning both. Second, Go sends map[int]ItemMeta so items carries integer keys, and the msgpack JS encoder cannot emit a non-string map key - it serialises a JS Map as empty object. The provider test hand-assembles frame bytes with int keys so it tests the shape the streamer actually sends. Single-refetch guard is a module-level generation marker set inside the shared promise then-callback, so two synchronous reconciles cannot both pass it; tested against a server that keeps answering the old generation, the N-replica disagreement case that would otherwise never terminate.


### 2026-08-18T19:59:31.798Z - Proof completeness set PROVEN: mp3Meta and mp3MetaGeneration on the MediaStream context, tagVocabulary.ts with the stale-fallback fetch, and STREAM_HTTP_BASE reusing chatHttpBase with no new VITE variable. tsc exit 0, vitest 2615 tests pass, lint 0 errors.

### 2026-08-18T19:59:31.896Z - Proof feature-availability set PROVEN: Exemption from reveal-gating and retention proven behaviourally: seeking ten minutes and asserting the seek went out and the answering frames landed, then ticking past a clip end_date to run the retention pass - metadata survives both.

### 2026-08-18T19:59:31.988Z - Proof robustness set PROVEN: fetchTagVocabulary tested for non-ok, thrown fetch, non-JSON body, rejected promise, and a 200 with no vocabulary array; each returns the cached copy marked stale. With no cache it returns an empty list marked stale rather than rejecting.

### 2026-08-18T19:59:32.081Z - Proof resilience set PROVEN: The plan sketch would have blanked a working filter tree: body.vocabulary ?? [] treats a malformed 200 as success. A non-array vocabulary is now a failure while a genuine empty array is accepted as a real answer, with tests pinning both directions. The single-refetch guard terminates even when a replica keeps answering the old generation.

### 2026-08-18T19:59:32.175Z - Proof security set NOT_APPLICABLE: No security surface. An anonymous GET of public reference data the streamer already serves, with no credentials, no cookie and no request headers set.

### 2026-08-18T19:59:32.269Z - Proof defense-in-depth set PROVEN: Two independent guards against a dead HTTP side. The fetch never rejects, and it falls back to last-known-good marked stale rather than empty, because tag filtering is the primary navigation and an empty tree is closer to feature loss than a cosmetic gap.

### 2026-08-18T19:59:32.361Z - Proof input-validation set PROVEN: Every failure mode of the response is validated rather than assumed: status, JSON parseability, and the shape of the vocabulary field. Wire fidelity is tested against real msgpack bytes with integer map keys, matching what Go map[int]ItemMeta actually emits.

### 2026-08-18T19:59:32.455Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface beyond the shared in-flight promise, which is the standard pattern from stationLogos and is tested for concurrent callers issuing a single request.

### 2026-08-18T19:59:32.551Z - Proof configurability set NOT_APPLICABLE: Nothing to configure. The endpoint derives from the existing STREAM_URL; adding a VITE variable would need a Dockerfile ARG and ENV plus a workflow build-arg, where a missing declaration shows up only as production silently using a default.
