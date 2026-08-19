---
id: 020-7f21
title: Update docs and remove the RadioScanner shell
status: in_progress
priority: P2
type: chore
created: "2026-08-18T17:24:01.148Z"
updated: "2026-08-19T03:33:13.000Z"
dependencies: ["019"]
plan: plans/radio-traffic-redesign.md
plan_step: Step 20
---

# Update docs and remove the RadioScanner shell

## Problem Statement

After the radio-core extraction the only thing left in RadioScanner is the shell, but two of those files have external consumers that a file-list deletion would miss. Docs also need the new frame, HTTP routes and public fields.

## Acceptance Criteria

- [ ] websocket-protocol.md documents the mp3_meta frame
- [ ] a new http-api.md documents the three mp3 routes with shapes, caching and rate limits
- [ ] data-model.md documents the new public fields and that parties stays private
- [ ] party-identification.md documents the rederive-mp3-metadata stage
- [ ] radioTuneStation is moved before RadioScannerContext is deleted, since PlaylistProvider imports it
- [ ] the Radio app registration is swapped in Desktop.tsx, not app.tsx
- [ ] RadioScanner.tsx, RadioScannerContext.ts and NowPlayingList.tsx are removed with their tests
- [ ] TAG_INDEX_SQL dead code is removed from seed.mjs
- [ ] the full suite passes, not just the Radio tests
- [ ] pnpm lint, pnpm build, pnpm test and go test ./... all pass

## Files

- packages/backend/docs/
- packages/frontend/src/Desktop.tsx
- packages/backend/seed.mjs

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

