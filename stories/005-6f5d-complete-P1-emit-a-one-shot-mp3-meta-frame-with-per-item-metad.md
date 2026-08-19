---
id: 005-6f5d
title: Emit a one-shot mp3_meta frame with per-item metadata
status: complete
priority: P1
type: feature
created: "2026-08-18T17:22:54.616Z"
updated: "2026-08-18T18:41:51.839Z"
dependencies: ["004"]
plan: plans/radio-traffic-redesign.md
plan_step: Step 5
started_at: "2026-08-18T18:36:23.388Z"
completed_at: "2026-08-18T18:41:51.838Z"
---

# Emit a one-shot mp3_meta frame with per-item metadata

## Problem Statement

mp3_history carries the entire back-catalogue and is re-sent wholesale on every seek, so inlining metadata would cost roughly 1.5MB of msgpack per Time Machine scrub. Metadata is immutable reference data and belongs on its own frame sent once per subscription.

## Acceptance Criteria

- [x] subscribing to mp3 emits exactly one mp3_meta frame
- [x] a subsequent seek re-emits mp3 and mp3_history but not mp3_meta
- [x] the frame carries no vocabulary field
- [x] mp3 and mp3_history payload sizes are unchanged from today
- [x] the metadata snapshot and vocabulary are cached under their own Redis keys built once per warm
- [x] InstallMp3Triggers also installs the notify trigger on mp3_tags and mp3_items_tags
- [x] a junction-row write invalidates the metadata snapshot
- [x] a shared generation id is stamped into the frame
- [x] go test ./internal/session/... ./internal/cache/... passes

## Files

- packages/backend/internal/session/session.go
- packages/backend/internal/cache/mp3.go
- packages/backend/internal/cache/mp3_listen.go

## Proof

- [x] [completeness] Completeness (mp3_meta frame, Mp3Meta assembler with mp3:meta / mp3:vocab / mp3:meta:etag Redis keys, tag-table triggers and a debounced rebuilder. go build, vet, gofmt, test ./... all clean, plus go test -race on internal/cache and internal/session.)
- [x] [feature-availability] Feature availability (Behavioural assertions on real code paths for criteria 1, 2, 3, 5, 7, 8, 9 using miniredis. The one-shot guard was mutation-verified: removing it fails with mp3_meta was sent twice and after a seek the session sent [mp3_meta mp3 mp3_history].)
- [x] [robustness] Robustness (Metadata build failure is non-fatal in both warm and resync: the columns land via a separate infra PR, so an image can legitimately meet a database without them, and propagating the error would disable the entire radio channel over decoration. LoadMp3Meta returns nil rather than an empty build when nothing is warm, so a one-shot frame cannot pin an empty corpus as truth for the connection lifetime.)
- [x] [resilience] Resilience (Cache invalidation for tag changes now exists where it previously did not. Rebuilds are coalesced behind a 2s debounce because rederive-mp3-metadata patches ~755 rows and delete-inserts each one junction rows; a rebuild per NOTIFY would re-read the corpus thousands of times.)
- [x] [security] Security (No new exposure. The frame carries model.ItemMeta, which structurally cannot hold gate_reasons or model. The metadata cache is derived from the same redacted columns story 001 writes.)
- [x] [defense-in-depth] Defense in depth (Two layers. Redaction is closed at derivation in story 001 and structurally impossible in the transport types from story 004. Separately, the tag trigger uses its own function rather than the item one: reusing the item function would publish a junction row id that applyMp3Change would act on as an mp3_items id, corrupting the item cache. Verified against origin/main before deviating from the brief.)
- [~] [input-validation] Input validation (No client input surface. The frame is server-emitted; the only client input on this path is the pre-existing subscribe/seek control messages, unchanged by this story.)
- [x] [thread-safety] Thread safety (go test -race passes on internal/cache and internal/session. This matters because the story adds a goroutine: the debounced rebuilder, scoped to the listener connection lifetime.)
- [~] [configurability] Configurability (Nothing to configure. Redis key names and the debounce interval are fixed constants; exposing them as tunables would invite drift between the WS and HTTP transports that share the assembler.)

## QA

Go build/vet/gofmt/test ./... clean, plus -race on cache and session. One-shot guard mutation-verified. Merged into feat/radio-traffic-redesign, PR #442.

## Work Log

### 2026-08-18T18:36:31.434Z - Implemented on branch story/005-mp3-meta-frame. Added Mp3MetaMessage (type+generation+items, no vocabulary field) and Session.SendMp3Meta/Mp3MetaSent with a one-shot guard; refactored the outbound path into sendFrame so a non-outMsg envelope can be sent. cache/mp3.go gained mp3:meta / mp3:vocab / mp3:meta:etag, a pure AssembleMp3Meta (sha256 content hash serving as both generation and ETag), StoreMp3Meta/LoadMp3Meta and BuildMp3Meta; the assembler returns built bytes plus the ETag so story 006's HTTP handlers reuse it verbatim. InstallMp3Triggers now also installs a notify trigger on mp3_tags and mp3_items_tags via a second function that publishes {op:tags} with no id -- reusing the item function would have published a junction-row id as an mp3_items id. Rebuilds are coalesced behind a 2s debounce because the rederive flow patches ~755 rows. Handler sends the frame ahead of mp3/mp3_history on the first snapshot only. go build/vet/gofmt/test all clean; also clean under -race.

### 2026-08-18T18:41:05.193Z - Merged into feat/radio-traffic-redesign, PR #442, commit dd18e786. Deliberate deviation from the brief: did NOT reuse rt911_notify_mp3_items_change on the tag tables. That function publishes NEW.id, which on mp3_items_tags is a junction row id that applyMp3Change would feed to Mp3ItemByID and act on an unrelated mp3_items row. A second function publishes {op:tags} with no id on the same channel. Verified the claim independently against origin/main - the deviation is correct and my original instruction would have corrupted the item cache. Also added beyond brief and flagged: 2s debounce on rebuilds (rederive-mp3-metadata touches ~755 rows and delete-inserts each one's junction rows), generation is a sha256 of built content rather than a per-process id so multi-replica clients cannot see a permanent mismatch, and metadata build failure is non-fatal so a missing column cannot disable the whole radio channel.


### 2026-08-18T18:41:32.096Z - Proof completeness set PROVEN: mp3_meta frame, Mp3Meta assembler with mp3:meta / mp3:vocab / mp3:meta:etag Redis keys, tag-table triggers and a debounced rebuilder. go build, vet, gofmt, test ./... all clean, plus go test -race on internal/cache and internal/session.

### 2026-08-18T18:41:32.185Z - Proof feature-availability set PROVEN: Behavioural assertions on real code paths for criteria 1, 2, 3, 5, 7, 8, 9 using miniredis. The one-shot guard was mutation-verified: removing it fails with mp3_meta was sent twice and after a seek the session sent [mp3_meta mp3 mp3_history].

### 2026-08-18T18:41:32.277Z - Proof robustness set PROVEN: Metadata build failure is non-fatal in both warm and resync: the columns land via a separate infra PR, so an image can legitimately meet a database without them, and propagating the error would disable the entire radio channel over decoration. LoadMp3Meta returns nil rather than an empty build when nothing is warm, so a one-shot frame cannot pin an empty corpus as truth for the connection lifetime.

### 2026-08-18T18:41:32.364Z - Proof resilience set PROVEN: Cache invalidation for tag changes now exists where it previously did not. Rebuilds are coalesced behind a 2s debounce because rederive-mp3-metadata patches ~755 rows and delete-inserts each one junction rows; a rebuild per NOTIFY would re-read the corpus thousands of times.

### 2026-08-18T18:41:32.486Z - Proof security set PROVEN: No new exposure. The frame carries model.ItemMeta, which structurally cannot hold gate_reasons or model. The metadata cache is derived from the same redacted columns story 001 writes.

### 2026-08-18T18:41:32.668Z - Proof input-validation set NOT_APPLICABLE: No client input surface. The frame is server-emitted; the only client input on this path is the pre-existing subscribe/seek control messages, unchanged by this story.

### 2026-08-18T18:41:32.849Z - Proof configurability set NOT_APPLICABLE: Nothing to configure. Redis key names and the debounce interval are fixed constants; exposing them as tunables would invite drift between the WS and HTTP transports that share the assembler.

### 2026-08-18T18:41:51.344Z - Proof defense-in-depth set PROVEN: Two layers. Redaction is closed at derivation in story 001 and structurally impossible in the transport types from story 004. Separately, the tag trigger uses its own function rather than the item one: reusing the item function would publish a junction row id that applyMp3Change would act on as an mp3_items id, corrupting the item cache. Verified against origin/main before deviating from the brief.

### 2026-08-18T18:41:51.432Z - Proof thread-safety set PROVEN: go test -race passes on internal/cache and internal/session. This matters because the story adds a goroutine: the debounced rebuilder, scoped to the listener connection lifetime.
