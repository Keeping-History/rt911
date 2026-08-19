---
id: 020-7f21
title: Update docs and remove the RadioScanner shell
status: complete
priority: P2
type: chore
created: "2026-08-18T17:24:01.148Z"
updated: "2026-08-19T03:33:37.000Z"
dependencies: ["019"]
plan: plans/radio-traffic-redesign.md
plan_step: Step 20
---

# Update docs and remove the RadioScanner shell

## Problem Statement

After the radio-core extraction the only thing left in RadioScanner is the shell, but two of those files have external consumers that a file-list deletion would miss. Docs also need the new frame, HTTP routes and public fields.

## Acceptance Criteria

- [x] websocket-protocol.md documents the mp3_meta frame
- [x] a new http-api.md documents the three mp3 routes with shapes, caching and rate limits
- [x] data-model.md documents the new public fields and that parties stays private
- [x] party-identification.md documents the rederive-mp3-metadata stage
- [x] radioTuneStation is moved before RadioScannerContext is deleted, since PlaylistProvider imports it
- [x] the Radio app registration is swapped in Desktop.tsx, not app.tsx
- [x] RadioScanner.tsx, RadioScannerContext.ts and NowPlayingList.tsx are removed with their tests
- [x] TAG_INDEX_SQL dead code is removed from seed.mjs
- [x] the full suite passes, not just the Radio tests
- [x] pnpm lint, pnpm build, pnpm test and go test ./... all pass

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

### 2026-08-19T03:33:37.000Z - Docs and dead-code removal complete

Moved `radioTuneStation` (+ `RadioRemoteCommand`) from `RadioScannerContext.ts`
into a new `Applications/radio-core/radioTuneStation.ts` (with its own test),
then repointed `Providers/Playlist/PlaylistProvider.tsx`'s import at it before
deleting `RadioScanner.tsx`, `RadioScannerContext.ts` and `NowPlayingList.tsx`
(each with its test) from `Applications/RadioScanner/`, plus the now-empty
directory and its `app.png`. Swapped the Radio app registration in
`Desktop.tsx` (removed the `RadioScanner` import/render, kept `RadioTraffic`;
`app.tsx` was never involved). Followed the resulting build breaks to their
source: removed the `RadioScanner.app` manifest case + side-effect import from
`appManifests.test.ts`, renamed the `RadioScanner.app` entry to `RadioTraffic.app`
in `Components/AboutApp/appWiring.test.tsx` and `data/provenance.ts`/
`provenance.test.ts` (appName "Radio Traffic", same sources/blurb/method).
Removed the dead `TAG_INDEX_SQL` (indexed a `mp3_items.tags` column that no
longer exists now that `tags` is an m2m alias) and its `createStreamerIndexes`
call from `seed.mjs`. Updated `packages/frontend/CLAUDE.md`'s app list and
clock-reader list to name `RadioTraffic`/`RadioTuner` instead of the deleted
`RadioScanner`, and documented `radio-core/` as the shared library apps read
from.

`websocket-protocol.md`'s `mp3_meta` section and the new `http-api.md`'s three
`/mp3/*` routes were already complete from earlier steps on this branch — no
changes needed. Added the missing docs: `data-model.md` gained an `mp3_items`
"Radio Traffic metadata columns" section (the public projection columns vs.
private `parties`/`tags_curated`/`derived_at`) and an `mp3_tags`/
`mp3_items_tags` section; `party-identification.md` gained a "The public
projection" section documenting `public_meta.build_public_meta` and the
`rederive-mp3-metadata` flow that supersedes `rebuild-tags`, correcting a
stale claim (borrowed from `flows.py`'s own comment) that junction writes
fire no invalidation trigger — they do, via `rt911_mp3_tags_changed`/
`rt911_mp3_items_tags_changed`.

Left untouched (out of scope, confirmed non-breaking): `Providers/Playlist/
playlistApps.ts`, `parsePlaylist.ts`, `PlaylistEditor/EntryForm.tsx` and
`playlistMenus.ts`, and `Mobile/screens/RadioScreen.tsx` all still reference
the `"RadioScanner.app"` id string as playlist/menu metadata rather than
importing the deleted module — the plan explicitly calls out that the
PlaylistEditor and Mobile suites must pass **unchanged**. Also left
`public/stacks/getting-started.stack.json`'s tutorial button (`openApp:
"RadioScanner.app"`) alone — fixing its stale content is a content-authoring
task outside this story's docs/deletion scope, not a build or test break.

Verified: `pnpm lint` (clean, pre-existing warnings only), `pnpm build`
(`tsc -b && vite build`, clean), `pnpm test` (291 files / 3111 tests green),
`go test ./...` from `packages/backend` (all packages ok).
