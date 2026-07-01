# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The **version 2** rewrite of 911realtime.org: a Mac OS 8-style desktop, built on the [Classicy](https://www.npmjs.com/package/classicy) component library, that replays synchronized September 11, 2001 media (TV, radio, pagers, news, Usenet) as if it were happening live. A pnpm monorepo with three independently-deployed pieces:

| Package | What it is | Guidance |
|---|---|---|
| `packages/frontend` | Vite + React + TypeScript desktop SPA | [`packages/frontend/CLAUDE.md`](packages/frontend/CLAUDE.md) |
| `packages/backend` | Go WebSocket "streamer" — drives a per-client virtual clock over Postgres/Redis | [`packages/backend/CLAUDE.md`](packages/backend/CLAUDE.md), [`SPEC.md`](packages/backend/SPEC.md) |
| `packages/tools` | Offline data pipelines (`video-grabber`: IA ingest/encode/transcribe/usenet; `mbox_parser`: one-off Usenet mbox conversion) that populate the same Postgres/Directus + Wasabi the streamer and frontend read | [`packages/tools/video-grabber/CLAUDE.md`](packages/tools/video-grabber/CLAUDE.md) |

Read the nested `CLAUDE.md` before working inside a package — this file only covers what's true across all three.

## Commands

Toolchain versions are pinned in `mise.toml` (Node 25, pnpm 10, Go 1.25, Python 3.12) — `mise install` provisions everything.

From the repo root:

```sh
pnpm install
pnpm dev              # frontend dev server (vite -d), localhost:5173
pnpm build            # tsc -b && vite build (frontend)
pnpm test             # vitest run (frontend)
pnpm lint             # eslint . (frontend)
pnpm setup            # seed the backend data store (packages/backend/seed.mjs)
pnpm db:gen-epg       # generate EPG data
```

Single-test / package-scoped commands:

```sh
# frontend: one file, or one named test
pnpm --filter @rt911/frontend exec vitest run src/Providers/MediaStream/virtualClock.test.ts
pnpm --filter @rt911/frontend exec vitest run -t "test name"

# frontend e2e (Playwright) — needs the dev server; see e2e config for baseURL
pnpm --filter @rt911/frontend exec playwright test e2e/tests/feedback.spec.ts

# backend (Go), from packages/backend/
go test ./...
go test ./internal/session/... -run TestSessionName

# video-grabber (Python), from packages/tools/video-grabber/
pytest tests/ -v
pytest tests/test_resolve.py::test_name
ruff check video_grabber/ tests/
```

CI (`.github/workflows/build.yml`) runs `tsc -b`, `eslint .`, and `vitest run` for the frontend and `go test ./...` for the backend as required checks before building/pushing images; E2E runs but is `continue-on-error`.

## Cross-cutting things to know

- **Frontend ↔ backend contract is the WebSocket wire protocol** documented in [`packages/backend/docs/websocket-protocol.md`](packages/backend/docs/websocket-protocol.md) (binary MessagePack server→client, JSON text client→server). There is exactly one consumer (this frontend) and one producer (this backend) — if you change the wire format, update both sides in the same PR; no version negotiation exists.
- **The virtual clock is the spine of the whole product.** A single canonical `dateTime` (seeded to `2001-09-11T12:40:00.000Z` / UTC-4 in `packages/frontend/src/app.tsx`) drives what every app displays and what the backend streams. See `packages/frontend/CLAUDE.md` for how the frontend reads/seeks it, and `packages/backend/CLAUDE.md` for how the backend turns a client's clock position into windowed Redis/Postgres queries.
- **Deployment is GitOps, not imperative.** Both the frontend and backend images are built and pushed to GHCR by `.github/workflows/build.yml` (tagged by branch/SHA). Actual rollout happens via ArgoCD pulling from a **separate** repo, `github.com/Keeping-History/infra` — `automated.selfHeal: true` means `kubectl set image` or any other imperative cluster edit gets reverted within seconds. Landing on `main` and letting the infra repo's image-tag automation + ArgoCD sync do its thing is the correct way to ship. `packages/tools/video-grabber/CLAUDE.md`'s "Build & deploy workflow" section documents the exact mechanics; the same pattern applies to the streamer and frontend images.
- **`classicy` auto-updates on every commit.** `.husky/pre-commit` runs `pnpm update classicy --latest --recursive --silent` and stages `pnpm-lock.yaml` before every commit — the frontend's `package.json` pins `classicy` to `"latest"` deliberately. Don't be alarmed by an unrelated classicy version bump riding along in your diff, and don't hand-edit that version. When developing against an unpublished local Classicy build, use `pnpm use:local` / `pnpm use:published` from `packages/frontend` instead.
- **Media assets live outside this repo.** Video/audio/image/PDF bytes are hosted on Wasabi and served via `files.911realtime.org`; nothing here serves raw media. `packages/tools/video-grabber` populates Postgres/Directus metadata and uploads assets; the frontend and backend only ever reference URLs.
