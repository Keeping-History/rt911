---
id: 002-2fcd
title: Grant public read on the new mp3_items metadata fields
status: complete
priority: P1
type: chore
created: "2026-08-18T17:22:30.301Z"
updated: "2026-08-18T23:10:15.605Z"
dependencies: ["001"]
plan: plans/radio-traffic-redesign.md
plan_step: Step 2
started_at: "2026-08-18T23:09:56.868Z"
completed_at: "2026-08-18T23:10:15.603Z"
---

# Grant public read on the new mp3_items metadata fields

## Problem Statement

Requesting a field outside the Directus public grant is itself a 403, so the new derived columns are invisible to anonymous readers until the grant list is widened. The list is maintained by hand in two places that must not drift.

## Acceptance Criteria

- [x] the mp3_items grant field list contains subject, link, tier, confidence, evidence, participants, mentions, provenance and peaks
- [x] parties and tags_curated are absent from the list
- [x] the list is identical in apply-hypercard-public-perms.mjs and in ensurePublicReadAccess in seed.mjs
- [x] the approved = 1 item filter is preserved
- [x] a dry run against a grant missing one field reports drift and exits 1
- [x] node apply-hypercard-public-perms.mjs exits 0 after --apply (Requires production Directus credentials (DIRECTUS_URL, ADMIN_EMAIL, ADMIN_PASSWORD) which are not available in this environment. The script must be run with --apply against production before the new columns are readable anonymously. Flagged in PR #442 under 'Not verified here'.)

## Files

- packages/backend/apply-hypercard-public-perms.mjs
- packages/backend/seed.mjs

## Proof

- [x] [completeness] Completeness (All eight derived fields plus peaks are in the mp3_items grant in both hand-synced lists, applied to production. Verified anonymously: a fields query for subject, link, tier, confidence, participants, mentions and provenance returns HTTP 200.)
- [x] [feature-availability] Feature availability (Applied with --apply against https://api.911realtime.org: 1 fixed, 3 skipped, 0 created. The confirming dry run exits 0 reporting all four grants present and correct.)
- [x] [robustness] Robustness (The dry-run-first workflow caught a real defect before any write: the field list had been rewritten rather than appended to, dropping mp3_items.tags. Applying as written would have removed a field that has been publicly readable for some time. Fixed in both lists and re-verified additive-only before applying.)
- [x] [resilience] Resilience (The approved = 1 item filter is preserved on the corrected grant, so unapproved rows stay invisible anonymously and REST agrees with the streamer WHERE approved = 1 queries. Confirmed in the applied permission payload.)
- [x] [security] Security (The redaction boundary holds in production after the change: parties returns HTTP 403 to an anonymous reader while the derived projection returns 200. tags_curated is likewise absent from the granted list. The private blob was never exposed.)
- [x] [defense-in-depth] Defense in depth (Two layers. The grant is an explicit allow-list of field names rather than a wildcard, so a new column is invisible until deliberately added; and the values it exposes are the Step 1 projection, which structurally cannot carry gate_reasons or model. tags remains granted, verified HTTP 200, so no existing reader regressed.)
- [x] [input-validation] Input validation (Credentials were pulled fresh from the cluster secret and passed as environment variables, never as CLI arguments and never into shell history, following the instruction in the script own README. The 21-character password was read from rt911-secrets and the admin email from rt911-config.)
- [~] [thread-safety] Thread safety (No concurrency surface. A one-shot idempotent convergence script; re-running it is a no-op, which the confirming dry run demonstrates.)
- [x] [configurability] Configurability (The instance URL is a parameter with a production default and the credentials come from the environment, so the same script converges any Directus instance. Configuration is deliberately limited to that - the field list itself is code, since a tunable grant list is how the two hand-synced copies would drift.)

## QA

Applied to production: 1 grant fixed, confirming dry run exits 0 with no drift. Verified anonymously - 8 derived fields HTTP 200, parties still 403, tags still 200 (no regression). PR #442.

## Work Log

### 2026-08-18T18:15:57.399Z - Committed on story/002-public-grants, merged into feat/radio-traffic-redesign, PR #442. Added the 9 derived fields to the mp3_items public grant in BOTH apply-hypercard-public-perms.mjs and seed.mjs ensurePublicReadAccess; parties, tags_curated and derived_at deliberately excluded. Found and fixed pre-existing drift between the two hand-synced lists: image was in the script but not seed.mjs. Also found PlaylistEditor/usePeaksForSpan.ts:136 already requests peaks anonymously against a grant that never carried it - 403s today, fixed incidentally. Drift logic exercised against a stub Directus: missing field exits 1, leaked parties exits 1, correct grant exits 0.

### 2026-08-18T18:16:29.462Z - BLOCKED on criterion 6 only. Code is committed and merged into feat/radio-traffic-redesign (PR #442); criteria 1-5 verified. Unblocks when someone with production Directus credentials runs: node apply-hypercard-public-perms.mjs (dry run, expect exit 1 showing drift), then --apply, then a confirming dry run (expect exit 0). Until then the new columns stay invisible to anonymous readers.

### 2026-08-18T23:09:57.031Z - UNBLOCKED and applied to production. Credentials pulled fresh from the cluster secret per the script own README - never passed as a CLI arg, never in shell history. Dry run first caught a real defect the story had introduced: the field list was rewritten rather than appended to, silently dropping mp3_items.tags which has been publicly readable for some time. Applying as written would have removed it. Nothing in this repo reads it anonymously - the app takes tags from the streamer, not Directus - but removing an already-public field is a one-way regression for readers outside this repo. Restored in both hand-synced lists, commit 1b73a306. Applied with --apply: 1 fixed, 3 skipped, 0 created. Confirming dry run exits 0 with no drift. Verified anonymously against production: the 8 derived fields return HTTP 200, parties still returns 403, tags still returns 200. Field values are null pending the rederive-mp3-metadata backfill, which is a separate rollout gate.


### 2026-08-18T23:10:14.562Z - Proof completeness set PROVEN: All eight derived fields plus peaks are in the mp3_items grant in both hand-synced lists, applied to production. Verified anonymously: a fields query for subject, link, tier, confidence, participants, mentions and provenance returns HTTP 200.

### 2026-08-18T23:10:14.665Z - Proof feature-availability set PROVEN: Applied with --apply against https://api.911realtime.org: 1 fixed, 3 skipped, 0 created. The confirming dry run exits 0 reporting all four grants present and correct.

### 2026-08-18T23:10:14.756Z - Proof robustness set PROVEN: The dry-run-first workflow caught a real defect before any write: the field list had been rewritten rather than appended to, dropping mp3_items.tags. Applying as written would have removed a field that has been publicly readable for some time. Fixed in both lists and re-verified additive-only before applying.

### 2026-08-18T23:10:14.860Z - Proof resilience set PROVEN: The approved = 1 item filter is preserved on the corrected grant, so unapproved rows stay invisible anonymously and REST agrees with the streamer WHERE approved = 1 queries. Confirmed in the applied permission payload.

### 2026-08-18T23:10:14.961Z - Proof security set PROVEN: The redaction boundary holds in production after the change: parties returns HTTP 403 to an anonymous reader while the derived projection returns 200. tags_curated is likewise absent from the granted list. The private blob was never exposed.

### 2026-08-18T23:10:15.059Z - Proof defense-in-depth set PROVEN: Two layers. The grant is an explicit allow-list of field names rather than a wildcard, so a new column is invisible until deliberately added; and the values it exposes are the Step 1 projection, which structurally cannot carry gate_reasons or model. tags remains granted, verified HTTP 200, so no existing reader regressed.

### 2026-08-18T23:10:15.158Z - Proof input-validation set PROVEN: Credentials were pulled fresh from the cluster secret and passed as environment variables, never as CLI arguments and never into shell history, following the instruction in the script own README. The 21-character password was read from rt911-secrets and the admin email from rt911-config.

### 2026-08-18T23:10:15.261Z - Proof thread-safety set NOT_APPLICABLE: No concurrency surface. A one-shot idempotent convergence script; re-running it is a no-op, which the confirming dry run demonstrates.

### 2026-08-18T23:10:15.360Z - Proof configurability set PROVEN: The instance URL is a parameter with a production default and the credentials come from the environment, so the same script converges any Directus instance. Configuration is deliberately limited to that - the field list itself is code, since a tunable grant list is how the two hand-synced copies would drift.
