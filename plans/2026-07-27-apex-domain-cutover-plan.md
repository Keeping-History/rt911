# Apex Domain Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the desktop SPA from `911realtime.org`, rename the backend hosts to `api.911realtime.org` and `stream.911realtime.org`, and 301 `www` and `beta` to the apex.

**Architecture:** Two repositories and one control plane. The rt911 repo change is pure refactor plus CI config — it centralizes every backend URL into `src/lib/endpoints.ts` and repoints the compiled-in defaults. The infra repo change flips Ingress hosts and origin allowlists. Cloudflare changes are DNS records plus one Redirect Rule. Certificate issuance happens through DNS-01 ahead of any traffic change, so TLS is never on the critical path.

**Tech Stack:** Vite + React + TypeScript (vitest), Go (streamer), Kubernetes manifests via ArgoCD, Cloudflare API v4.

Design doc: `plans/2026-07-25-apex-domain-cutover-design.md`. Read it before starting — particularly the "Chat origin gates" section, which explains why `beta` stays in two allowlists until the very last task.

## Global Constraints

- **Zone ID:** `08e515063f366be3278cb3de2380469c` (`911realtime.org`, Free plan, all public records proxied).
- **Cluster CNAME target:** `dev.keepinghistory.org`.
- **Kubernetes namespace:** `rt911`.
- **Deployment is GitOps.** ArgoCD has `automated.selfHeal: true`. Never run `kubectl apply`, `kubectl set image`, or `kubectl edit` against rt911 resources — it is reverted within seconds. All cluster changes land as commits to `github.com/Keeping-History/infra`.
- **The infra repo is a separate checkout** at `/home/robbiebyrd/infra`. It is not a submodule of rt911.
- **Do not reorder Phase 2 tasks.** Each is a precondition for the next; the ordering is what keeps the site reachable throughout.
- **`beta.911realtime.org` must remain in `DefaultTrustedOrigins` and in the `streamer-cors` origin list until Task 13.** Removing it earlier signs out every user still on `beta` during the cutover window.
- **Frontend env vars are baked in at Docker build time.** A new `VITE_*` variable requires an `ARG` **and** an `ENV` line in `packages/frontend/Dockerfile`, plus a `build-args` entry in `.github/workflows/build.yml`. Docker silently ignores a `build-args` entry with no matching `ARG`.
- Tests: `pnpm --filter @rt911/frontend exec vitest run <path>`. Full gate: `pnpm test && pnpm lint && pnpm build` from the repo root, and `go test ./...` from `packages/backend/`.

## File Structure

**Created:**
- `packages/frontend/src/lib/endpoints.ts` — the single origin for every backend base URL the browser talks to. Exports `DIRECTUS_URL`, `STREAM_URL`, `FEEDBACK_URL`, `CHAT_BASE`, and the pure helper `chatHttpBase()`.
- `packages/frontend/src/lib/endpoints.test.ts` — unit tests for `chatHttpBase()`, the only logic in that module.

**Modified (rt911):** seven modules that each declare their own `DIRECTUS_URL`; nine modules that import it from `loadPlaylist.ts`; `usernameApi.ts`, `MediaStreamProvider.tsx`, `useFeedback.ts`, `authApi.ts`; `Dockerfile`; both workflow files; `.env` and `.env.example`; and in the final task, `origin.go`.

**Modified (infra):** `apps/rt911/frontend.yaml`, `directus.yaml`, `streamer.yaml`, `configmap.yaml`.

---

## Phase 0 — Prerequisites

### Task 1: Manual prerequisites

These are console operations outside both repositories. Every one of them blocks the cutover. Nothing in Phase 2 may start until all four are confirmed.

**Files:** none.

**Interfaces:**
- Produces: a Cloudflare API token with redirect permissions, exported as `$CF_REDIRECT_TOKEN` for Task 12; OAuth providers that accept the new callback URL.

- [ ] **Step 1: Add the Google OAuth redirect URI**

In Google Cloud Console → APIs & Services → Credentials → the rt911 OAuth 2.0 Client ID, add this to *Authorized redirect URIs*, keeping the existing `api-beta` entry:

```
https://api.911realtime.org/auth/login/google/callback
```

Directus derives this URI from `PUBLIC_URL`. The moment Task 10 changes `PUBLIC_URL`, Google starts receiving a `redirect_uri` it has never seen and fails closed with `redirect_uri_mismatch`. Keeping both entries means neither ordering breaks.

- [ ] **Step 2: Add the Apple OAuth return URL**

In the Apple Developer portal → Certificates, Identifiers & Profiles → the `org.911realtime.auth` Services ID → Configure → Return URLs, add:

```
https://api.911realtime.org/auth/login/apple/callback
```

The zone's `apple-domain=keugYYnIdg5DNIzv` TXT record is zone-level and needs no change.

- [ ] **Step 3: (RESOLVED 2026-07-27 — no token needed)**

Originally this step created a scoped API token for Task 12. In practice the
Cloudflare token UI on this account exposes no "Dynamic Redirect" permission:
a token granted the nearest equivalent could list ruleset phases and reach
`http_request_transform`, but `http_request_dynamic_redirect` returned
`request is not authorized`, and `http_request_dynamic_redirect` did not appear
among its visible phases at all.

Task 12 creates exactly one rule, once, and **verifying** that rule needs no
token — just `curl` against the two hostnames. So the rule is created in the
dashboard instead, and the token requirement is dropped. See Task 12.

The old cert-manager token still covers every DNS operation in Tasks 9, 11
and 13.

- [x] **Step 4: Confirm the zone's SSL mode and cache rules — DONE 2026-07-27**

**Cache: verified empirically, no action needed.** Rather than reading the rule
config, the behaviour itself was measured against `beta`, which sits in the same
zone under the same zone-wide rules:

| URL | `cache-control` | `cf-cache-status` |
|---|---|---|
| `/` and `/index.html` | `no-store, must-revalidate` | `BYPASS` |
| `/assets/index-<hash>.js` | `max-age=31536000, immutable` | `MISS` → `HIT` |

The zone-wide rule is not overriding nginx on `index.html`. Re-confirm on the
apex at Task 11 Step 3, which already does exactly this.

**SSL mode: could not be read** — the setting requires Zone Settings Read, which
neither available token has. This is **non-blocking**, because Task 8 makes the
SANs exist regardless of mode. The risk it guards against was demonstrated
directly:

```
SNI beta.911realtime.org -> CN = beta.911realtime.org        (real LE cert)
SNI api.911realtime.org  -> CN = TRAEFIK DEFAULT CERT        (self-signed)
```

No Ingress claims `api.911realtime.org` yet, so Traefik serves its default
cert. Under Full (strict) that is a **526 at the edge, not a 404** — harmless
while nothing consumes the hostname, but it is why Task 8 must precede Task 11.

- [x] **Step 5: Record completion — Task 1 COMPLETE 2026-07-27**

All prerequisites are cleared. Phase 2 is unblocked.

---

## Phase 1 — rt911 repository

One PR. Tasks 2 through 7 are a pure refactor plus configuration: no behavior changes on the currently-live `beta` site, because every default it introduces is only read when the corresponding `VITE_*` variable is unset, and Task 7 sets them all explicitly.

### Task 2: Create the endpoints module

**Files:**
- Create: `packages/frontend/src/lib/endpoints.ts`
- Test: `packages/frontend/src/lib/endpoints.test.ts`

**Interfaces:**
- Produces: `DIRECTUS_URL: string`, `STREAM_URL: string`, `FEEDBACK_URL: string`, `CHAT_BASE: string`, and `chatHttpBase(streamUrl: string): string`. Tasks 3 through 6 import from here.

The constants are plain environment reads evaluated once at module load; the only logic worth testing is `chatHttpBase`, which converts the WebSocket URL into the HTTP base the chat REST endpoint lives on. That transform currently sits inline in `usernameApi.ts` and is the piece that would silently break if someone changed the stream URL format.

- [ ] **Step 1: Write the failing test**

Create `packages/frontend/src/lib/endpoints.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { chatHttpBase } from "./endpoints";

describe("chatHttpBase", () => {
	it("converts a wss stream URL to an https base", () => {
		expect(chatHttpBase("wss://stream.911realtime.org/stream")).toBe(
			"https://stream.911realtime.org",
		);
	});

	it("converts a plain ws URL to http for local development", () => {
		expect(chatHttpBase("ws://localhost:8080/stream")).toBe("http://localhost:8080");
	});

	// The rewrite must not fire on a host that merely starts with "ws".
	it("only rewrites the scheme, never the host", () => {
		expect(chatHttpBase("wss://ws.example.org/stream")).toBe("https://ws.example.org");
	});

	// Only a trailing /stream is the path to strip.
	it("leaves a stream segment alone when it is not the final path element", () => {
		expect(chatHttpBase("wss://example.org/stream/v2")).toBe("https://example.org/stream/v2");
	});
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/lib/endpoints.test.ts`
Expected: FAIL — `Failed to resolve import "./endpoints"`.

- [ ] **Step 3: Write the implementation**

Create `packages/frontend/src/lib/endpoints.ts`:

```typescript
/**
 * Every backend base URL the browser talks to, in one place.
 *
 * These are read from `import.meta.env` at module load, which means Vite
 * inlines them at BUILD time — a deployed bundle cannot be repointed without a
 * rebuild. The defaults below are the production hosts, so an image built
 * without the VITE_* variables set still reaches production rather than
 * silently falling back to a dead hostname.
 *
 * Adding a variable here is not enough on its own: it also needs an ARG and an
 * ENV line in packages/frontend/Dockerfile and a build-args entry in
 * .github/workflows/build.yml. Docker ignores a build-arg with no matching ARG
 * without failing, so a missing declaration shows up only as production
 * quietly using the default below.
 */

/** Directus REST base, read anonymously for static reference data. No trailing slash. */
export const DIRECTUS_URL: string =
	(import.meta.env.VITE_DIRECTUS_URL as string | undefined) ?? "https://api.911realtime.org";

/** Streamer WebSocket endpoint. */
export const STREAM_URL: string =
	(import.meta.env.VITE_MEDIA_STREAM_URL as string | undefined) ??
	"wss://stream.911realtime.org/stream";

/** Streamer HTTP base, used by the Feedback app to POST /feedback. */
export const FEEDBACK_URL: string =
	(import.meta.env.VITE_FEEDBACK_URL as string | undefined) ?? "https://stream.911realtime.org";

/**
 * The HTTP origin serving the streamer's REST endpoints, derived from the
 * WebSocket URL so there is exactly one place to point at an environment. The
 * streamer serves both from the same host.
 */
export function chatHttpBase(streamUrl: string): string {
	return streamUrl.replace(/^ws/, "http").replace(/\/stream$/, "");
}

/** Base for the streamer's chat REST endpoints, e.g. /chat/username-available. */
export const CHAT_BASE: string = chatHttpBase(STREAM_URL);
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/lib/endpoints.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/lib/endpoints.ts packages/frontend/src/lib/endpoints.test.ts
git commit -m "feat(frontend): add a single module for backend base URLs"
```

### Task 3: Move the shared DIRECTUS_URL out of loadPlaylist

**Files:**
- Modify: `packages/frontend/src/Providers/Playlist/loadPlaylist.ts:7-9`
- Modify (import line only): `src/Providers/Auth/playlistApi.ts:5`, `src/Providers/Auth/authApi.ts:4`, `src/Providers/Auth/authApi.test.ts:3`, `src/Providers/Auth/stackApi.ts:5`, `src/Providers/Auth/profileApi.ts:10`, `src/Providers/FilesystemSync/directusFilesystemApi.ts:7`, `src/Providers/FilesystemSync/directusFilesystemApi.test.ts:3`, `src/Applications/TimeMachine/useBookmarks.ts:4`, `src/Applications/TimeMachine/bookmarksApi.ts:6`, `src/Applications/HyperCard/extensions/directusCollections.ts:13`

**Interfaces:**
- Consumes: `DIRECTUS_URL` from Task 2.
- Produces: `loadPlaylist.ts` no longer exports `DIRECTUS_URL`.

`loadPlaylist.ts` is the de-facto shared constant already — ten modules import `DIRECTUS_URL` from it, which is an odd home for a playlist loader. Moving it to `endpoints.ts` is what lets Task 4 collapse the duplicates.

- [ ] **Step 1: Delete the declaration from loadPlaylist.ts**

Remove these lines (currently 7-9):

```typescript
export const DIRECTUS_URL: string =
	(import.meta.env.VITE_DIRECTUS_URL as string | undefined) ??
	"https://api-beta.911realtime.org";
```

`loadPlaylist.ts` uses `DIRECTUS_URL` itself, so add an import at the top of the file alongside its existing imports:

```typescript
import { DIRECTUS_URL } from "../../lib/endpoints";
```

- [ ] **Step 2: Run the type checker to enumerate every broken import**

Run: `pnpm --filter @rt911/frontend exec tsc -b --force`
Expected: FAIL, one error per module still importing `DIRECTUS_URL` from `loadPlaylist`. Use this list to drive the next step rather than trusting the list in **Files** above.

- [ ] **Step 3: Repoint each importer**

In each file the type checker named, change the import source to `endpoints`. The relative depth differs per file — let the type checker confirm each one. For files under `src/Providers/Auth/`:

```typescript
import { DIRECTUS_URL } from "../../lib/endpoints";
```

For files under `src/Applications/TimeMachine/`:

```typescript
import { DIRECTUS_URL } from "../../lib/endpoints";
```

For `src/Applications/HyperCard/extensions/directusCollections.ts`:

```typescript
import { DIRECTUS_URL } from "../../../lib/endpoints";
```

Where a file imports `DIRECTUS_URL` alongside other symbols from `loadPlaylist`, split it into two imports rather than removing the original line.

- [ ] **Step 4: Verify the type checker is clean and tests pass**

Run: `pnpm --filter @rt911/frontend exec tsc -b --force && pnpm --filter @rt911/frontend exec vitest run`
Expected: no type errors; the full suite passes.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src
git commit -m "refactor(frontend): source DIRECTUS_URL from the endpoints module"
```

### Task 4: Collapse the seven duplicate DIRECTUS_URL declarations

**Files:**
- Modify: `src/Applications/FlightTracker/useRouteIndex.ts:10-12`, `useFlightTrack.ts:6-8`, `useMapPois.ts:5-7`, `useNotableCrashSites.ts:15-17`, `useAltitudeProfile.ts:9-11`
- Modify: `src/Applications/README/useReadmeArticles.ts:87-88`
- Modify: `src/Applications/PlaylistEditor/directusQueue.ts:4-5`

**Interfaces:**
- Consumes: `DIRECTUS_URL` from Task 2.

Each of these declares its own private copy with a hardcoded `api-beta` fallback. These are the copies that would have kept production on the old hostname even after the CI variable was added.

- [ ] **Step 1: Replace each local declaration with an import**

In the five FlightTracker hooks, delete the local `const DIRECTUS_URL = ...` block and add:

```typescript
import { DIRECTUS_URL } from "../../lib/endpoints";
```

Keep each file's surrounding explanatory comment — it documents why that hook reads Directus over REST instead of the stream, which is still true. Only the declaration goes.

In `src/Applications/README/useReadmeArticles.ts`, delete lines 87-88 and add the same import.

In `src/Applications/PlaylistEditor/directusQueue.ts`, delete lines 4-5 and add the same import. Note this file's declaration uses `import.meta.env?.VITE_DIRECTUS_URL` with an optional chain rather than a cast; the replacement is identical to the others.

- [ ] **Step 2: Verify no hardcoded fallback survives**

Run:

```bash
grep -rn "api-beta.911realtime.org\"" --include="*.ts" --include="*.tsx" packages/frontend/src
```

Expected: no output. Any remaining hit is a declaration this task missed.

- [ ] **Step 3: Run the type checker and the full suite**

Run: `pnpm --filter @rt911/frontend exec tsc -b --force && pnpm --filter @rt911/frontend exec vitest run`
Expected: no type errors; full suite passes. The FlightTracker tests exercise these hooks' URL construction, so a wrong import path surfaces here.

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/src
git commit -m "refactor(frontend): collapse seven duplicate Directus base URLs"
```

### Task 5: Point the streamer consumers at the endpoints module

**Files:**
- Modify: `src/Providers/Auth/usernameApi.ts:15-21`
- Modify: `src/Providers/MediaStream/MediaStreamProvider.tsx:50-52`
- Modify: `src/Applications/Feedback/useFeedback.ts:71`

**Interfaces:**
- Consumes: `STREAM_URL`, `FEEDBACK_URL`, `CHAT_BASE` from Task 2.

- [ ] **Step 1: Replace usernameApi's inline derivation**

In `src/Providers/Auth/usernameApi.ts`, delete this block:

```typescript
// Derived from the WebSocket URL so there is one place to point at an
// environment. The streamer serves both from the same host.
const STREAM_BASE: string = (
	(import.meta.env.VITE_MEDIA_STREAM_URL as string | undefined) ?? "ws://localhost:8080/stream"
)
	.replace(/^ws/, "http")
	.replace(/\/stream$/, "");
```

Add at the top of the file:

```typescript
import { CHAT_BASE } from "../../lib/endpoints";
```

Then update the single use site (currently line 37) from `${STREAM_BASE}` to `${CHAT_BASE}`:

```typescript
		const res = await fetchFn(
			`${CHAT_BASE}/chat/username-available?name=${encodeURIComponent(name)}`,
			{ credentials: "include", signal },
		);
```

Leave the file's leading doc comment untouched — it explains why this endpoint exists at all and is still accurate.

- [ ] **Step 2: Replace MediaStreamProvider's declaration**

In `src/Providers/MediaStream/MediaStreamProvider.tsx`, delete:

```typescript
const WS_URL: string =
	(import.meta.env.VITE_MEDIA_STREAM_URL as string | undefined) ??
	"ws://localhost:8080/stream";
```

Add to the file's imports:

```typescript
import { STREAM_URL } from "../../lib/endpoints";
```

Then replace every `WS_URL` reference in the file with `STREAM_URL`. Find them with:

```bash
grep -n "WS_URL" packages/frontend/src/Providers/MediaStream/MediaStreamProvider.tsx
```

- [ ] **Step 3: Replace useFeedback's inline default**

In `src/Applications/Feedback/useFeedback.ts`, change line 71 from:

```typescript
		const base = import.meta.env.VITE_FEEDBACK_URL || "http://localhost:8080";
```

to use the shared constant. Add to the imports:

```typescript
import { FEEDBACK_URL } from "../../lib/endpoints";
```

and replace the `base` local with `FEEDBACK_URL` at its use site on the following line:

```typescript
			const res = await fetch(`${FEEDBACK_URL}/feedback`, { method: "POST", body });
```

- [ ] **Step 4: Verify**

Run: `pnpm --filter @rt911/frontend exec tsc -b --force && pnpm --filter @rt911/frontend exec vitest run`
Expected: no type errors; full suite passes.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src
git commit -m "refactor(frontend): source streamer URLs from the endpoints module"
```

### Task 6: Repoint the registration landing fallback

**Files:**
- Modify: `packages/frontend/src/Providers/Auth/authApi.ts:171`
- Test: `packages/frontend/src/Providers/Auth/authApi.test.ts:226-238`

**Interfaces:**
- Produces: no signature change; `registrationLandingUrl` keeps its two optional parameters.

`registrationLandingUrl` already returns the caller's own origin whenever the page is on the product domain, so the apex is handled correctly today. Only the fallback — used when the page is somewhere else, such as a GitHub Pages preview — names `beta`.

- [ ] **Step 1: Update the failing assertion first**

In `packages/frontend/src/Providers/Auth/authApi.test.ts`, change the two assertions that expect the `beta` fallback. The off-domain case (currently around line 237):

```typescript
		expect(registrationLandingUrl("evil911realtime.org", "https://evil911realtime.org")).toBe(
			"https://911realtime.org/",
		);
```

Leave the `beta.911realtime.org` and `911realtime.org` cases alone — both are hosts of the product domain, so both correctly return their own origin, and that behavior does not change.

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Providers/Auth/authApi.test.ts`
Expected: FAIL — received `"https://beta.911realtime.org/"`, expected `"https://911realtime.org/"`.

- [ ] **Step 3: Update the implementation**

In `packages/frontend/src/Providers/Auth/authApi.ts`, change line 171:

```typescript
	return isHostOf(hostname, "911realtime.org") ? `${origin}/` : "https://911realtime.org/";
```

Update the comment three lines above it, which says "future root-domain move" — that move is this change:

```typescript
// Registration verification links must land on an allow-listed URL
// (USER_REGISTER_URL_ALLOW_LIST). The frontend's own origin when it's already
// on the product domain; the apex otherwise, for previews served elsewhere.
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Providers/Auth/authApi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Providers/Auth
git commit -m "fix(frontend): land off-domain registration links on the apex"
```

### Task 7: Repoint the build-time configuration

**Files:**
- Modify: `packages/frontend/Dockerfile:21-34`
- Modify: `.github/workflows/build.yml:24-31` and `:135-141`
- Modify: `.github/workflows/pr-preview.yml:37-42`
- Modify: `packages/frontend/.env` and `packages/frontend/.env.example`

**Interfaces:**
- Consumes: the `VITE_*` names defined in Task 2.

This is the task that actually changes what a deployed bundle talks to. Everything before it was a refactor.

- [ ] **Step 1: Declare the new build arg in the Dockerfile**

`VITE_DIRECTUS_URL` has never been a build arg — production has been relying on the source fallback. Docker ignores a `build-args` entry with no matching `ARG` **without failing**, so this step must come before the workflow change or the workflow change does nothing.

In `packages/frontend/Dockerfile`, add to the `ARG` block (after line 27):

```dockerfile
ARG VITE_DIRECTUS_URL
```

and extend the `ENV` block, adding a continuation to the previous line:

```dockerfile
ENV VITE_PROXY_PROTOCOL=$VITE_PROXY_PROTOCOL \
    VITE_PROXY_HOST=$VITE_PROXY_HOST \
    VITE_PROXY_PORT=$VITE_PROXY_PORT \
    VITE_MEDIA_STREAM_URL=$VITE_MEDIA_STREAM_URL \
    VITE_OPENREPLAY_PROJECT_KEY=$VITE_OPENREPLAY_PROJECT_KEY \
    VITE_OPENREPLAY_INGEST_URL=$VITE_OPENREPLAY_INGEST_URL \
    VITE_FEEDBACK_URL=$VITE_FEEDBACK_URL \
    VITE_DIRECTUS_URL=$VITE_DIRECTUS_URL
```

- [ ] **Step 2: Repoint the production workflow**

In `.github/workflows/build.yml`, update the `env:` block (lines 24-31) to:

```yaml
env:
  # Public backend URLs compiled into the frontend bundle.
  FE_VITE_PROXY_PROTOCOL: "https:"
  FE_VITE_PROXY_HOST: "timemachine.911realtime.org"
  FE_VITE_PROXY_PORT: "443"
  FE_VITE_MEDIA_STREAM_URL: "wss://stream.911realtime.org/stream"
  FE_VITE_OPENREPLAY_PROJECT_KEY: "fsiCRmSeFQkdKxDDwD0C"
  FE_VITE_OPENREPLAY_INGEST_URL: "https://openreplay.911realtime.org/ingest"
  FE_VITE_FEEDBACK_URL: "https://stream.911realtime.org"
  FE_VITE_DIRECTUS_URL: "https://api.911realtime.org"
```

and add the matching line to the `build-args` block (after line 141):

```yaml
            VITE_DIRECTUS_URL=${{ env.FE_VITE_DIRECTUS_URL }}
```

- [ ] **Step 3: Repoint the preview workflow**

In `.github/workflows/pr-preview.yml`, update lines 40-42:

```yaml
  VITE_MEDIA_STREAM_URL: "wss://stream.911realtime.org/stream"
  VITE_FEEDBACK_URL: "https://stream.911realtime.org"
  VITE_DIRECTUS_URL: "https://api.911realtime.org"
```

- [ ] **Step 4: Update the local env files**

In both `packages/frontend/.env` and `packages/frontend/.env.example`, change:

```
VITE_MEDIA_STREAM_URL=wss://stream.911realtime.org/stream
```

In `.env.example` only, also update the commented default under the `VITE_DIRECTUS_URL` block:

```
# Default: https://api.911realtime.org
VITE_DIRECTUS_URL=https://api.911realtime.org
```

- [ ] **Step 5: Verify no stale hostname remains outside tests and docs**

Run:

```bash
grep -rn "stream-beta\|api-beta" --include="*.ts" --include="*.tsx" --include="*.yml" \
  --include="*.env*" --include="Dockerfile" packages/ .github/ | grep -v node_modules
```

Expected: only prose comments referencing the historical `api-beta` response-mixing bug. No assignment, no URL literal.

- [ ] **Step 6: Run the full gate**

Run from the repo root: `pnpm build && pnpm lint && pnpm test`
Expected: all pass.

- [ ] **Step 7: Commit and open the PR**

```bash
git add packages/frontend/Dockerfile packages/frontend/.env packages/frontend/.env.example .github/workflows
git commit -m "build: point the frontend bundle at the apex-era backend hosts"
git push -u origin HEAD
gh pr create --title "Apex cutover: repoint frontend at api/stream hostnames" \
  --body "Implements Phase 1 of plans/2026-07-27-apex-domain-cutover-plan.md. No infra or DNS change — the new hostnames do not resolve to the cluster until Phase 2, so this PR must NOT be merged until Task 8 and Task 9 are done."
```

**Do not merge this PR yet.** Merging triggers a build and an ArgoCD image bump; the new hostnames must exist first. Task 11 is where it merges.

---

## Phase 2 — Cutover

Ordered and not interchangeable. Tasks 8 through 10 are reversible; Task 12 is not.

### Task 8: Extend the TLS certificates

**Files:**
- Modify (infra): `apps/rt911/frontend.yaml:57`, `apps/rt911/directus.yaml:208,298,322`, `apps/rt911/streamer.yaml:138`

Adds the new hostnames to each Ingress's `tls.hosts` while leaving `rules.host` alone. cert-manager's ingress-shim owns these Certificates and names them after `secretName`, so extending `tls.hosts` re-issues each cert with the extra SAN. Routing is untouched, so this is a no-op for users.

Standalone `Certificate` resources are deliberately not used here: they would contend with ingress-shim for ownership of the same secret.

- [ ] **Step 1: Extend each tls.hosts list**

In `/home/robbiebyrd/infra`, edit `apps/rt911/frontend.yaml`:

```yaml
  tls:
    - hosts: [beta.911realtime.org, 911realtime.org]
      secretName: rt911-frontend-tls
```

`apps/rt911/streamer.yaml`:

```yaml
  tls:
    - hosts: [stream-beta.911realtime.org, stream.911realtime.org]
      secretName: rt911-streamer-tls
```

`apps/rt911/directus.yaml` — three separate `tls:` blocks at lines 208, 298 and 322. Each becomes:

```yaml
    - hosts: [api-beta.911realtime.org, api.911realtime.org]
```

Leave every `rules.host` and `- host:` line untouched in all three files. Confirm before committing:

```bash
cd /home/robbiebyrd/infra && git diff | grep "^[-+].*host:" 
```

Expected: no output. Only `hosts: [...]` array lines should appear in the diff.

- [ ] **Step 2: Commit and push**

```bash
cd /home/robbiebyrd/infra
git add apps/rt911/frontend.yaml apps/rt911/directus.yaml apps/rt911/streamer.yaml
git commit -m "rt911: add apex-era hostnames to the TLS SAN lists"
git push
```

- [ ] **Step 3: Wait for ArgoCD to sync and cert-manager to re-issue**

```bash
kubectl get certificate -n rt911 -w
```

Wait until all three report `READY=True` again. Re-issuance takes roughly one to three minutes per cert via DNS-01.

- [ ] **Step 4: Verify each certificate actually carries the new SAN**

A `READY=True` that predates the change proves nothing — check the SANs:

```bash
for s in rt911-frontend-tls rt911-api-tls rt911-streamer-tls; do
  echo "--- $s"
  kubectl get secret -n rt911 $s -o jsonpath='{.data.tls\.crt}' | base64 -d \
    | openssl x509 -noout -text | grep -A1 "Subject Alternative Name"
done
```

Expected: `911realtime.org` in the frontend cert, `api.911realtime.org` in the api cert, `stream.911realtime.org` in the streamer cert — each **alongside** its existing `-beta` name.

If a SAN is missing, do not proceed. Task 10 depends on these certs existing.

- [ ] **Step 5: Verify Traefik actually serves the new cert for the new SNI**

A correct SAN in the secret is necessary but not sufficient — Traefik picks a
certificate by SNI from the Ingress TLS config, and the point of this task is
that it should now answer for a hostname whose `rules.host` it does not yet
serve. Before this task, that SNI gets the self-signed fallback:

```bash
for h in 911realtime.org api.911realtime.org stream.911realtime.org; do
  printf "%-28s " "$h"
  echo | openssl s_client -connect dev.keepinghistory.org:443 -servername "$h" 2>/dev/null \
    | openssl x509 -noout -subject
done
```

Expected: a real Let's Encrypt subject for each. Seeing `CN = TRAEFIK DEFAULT
CERT` means Traefik is still falling back, and pointing DNS at it in Task 11
would return 526 under Full (strict) rather than serving the site.

An HTTP 404 over a *valid* certificate is the correct state at this point —
routing does not switch until Task 10.

### Task 9: Pre-stage the DNS records

**Files:** none — Cloudflare API.

Creates `stream` and repoints `api`. Neither hostname is in any Ingress `rules.host` yet, so Traefik returns 404 for both. That is expected and harmless; it makes the records real so Task 10 has nothing left to wait on.

- [ ] **Step 1: Export the DNS token**

```bash
export CF_DNS_TOKEN=$(kubectl get secret -n cert-manager cloudflare-api-token -o jsonpath='{.data.api-token}' | base64 -d)
export ZONE=08e515063f366be3278cb3de2380469c
```

- [ ] **Step 2: Create the stream record**

```bash
curl -sS -X POST -H "Authorization: Bearer $CF_DNS_TOKEN" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records" \
  --data '{"type":"CNAME","name":"stream","content":"dev.keepinghistory.org","proxied":true,"ttl":1}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['success'], d['result']['name'] if d['success'] else d['errors'])"
```

Expected: `True stream.911realtime.org`.

- [ ] **Step 3: Repoint the api record**

`api.911realtime.org` currently CNAMEs to `admin.911realtime.org`, part of the old stack. Its record ID is `152c825a28aa3c73b7c4126c2b915a06`:

```bash
curl -sS -X PATCH -H "Authorization: Bearer $CF_DNS_TOKEN" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records/152c825a28aa3c73b7c4126c2b915a06" \
  --data '{"content":"dev.keepinghistory.org","proxied":true}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['success'], d['result']['content'] if d['success'] else d['errors'])"
```

Expected: `True dev.keepinghistory.org`.

- [ ] **Step 4: Verify both resolve to the Cloudflare edge**

```bash
dig +short stream.911realtime.org @1.1.1.1
dig +short api.911realtime.org @1.1.1.1
```

Expected: Cloudflare anycast addresses (`104.21.*` / `172.67.*`) for both, matching what `beta.911realtime.org` returns.

### Task 10: Switch the ingress hosts and origin allowlists

**Files:**
- Modify (infra): `apps/rt911/frontend.yaml`, `directus.yaml`, `streamer.yaml`, `configmap.yaml`

This is the step where users notice something. The backends hard-cut: a tab already open holds JavaScript that dials `stream-beta` and loses its stream until reloaded.

**Merge the Task 7 PR first** so the new image exists in GHCR before the backend hostnames move.

- [ ] **Step 1: Merge the Phase 1 PR and wait for the image**

```bash
gh pr merge --squash --auto
gh run watch
```

Wait for the build workflow to push `ghcr.io/keeping-history/rt911-frontend:main`.

- [ ] **Step 2: Switch the routing hosts**

In `/home/robbiebyrd/infra/apps/rt911/frontend.yaml`, change the rule host to the apex while **keeping `beta` in `tls.hosts`**:

```yaml
  tls:
    - hosts: [beta.911realtime.org, 911realtime.org]
      secretName: rt911-frontend-tls
  rules:
    - host: 911realtime.org
```

Then add a second rule block for `beta`, duplicating the path block, so the site stays reachable on both until Task 12:

```yaml
    - host: beta.911realtime.org
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: rt911-frontend
                port:
                  number: 80
```

In `streamer.yaml` and `directus.yaml`, change each `- host:` line to the new hostname. Unlike the frontend, these do **not** keep a second rule — this is the hard cut.

- [ ] **Step 3: Update the streamer CORS origin list**

In `apps/rt911/streamer.yaml`, the `streamer-cors` middleware. Add the apex and keep `beta`:

```yaml
    accessControlAllowOriginList:
      - "https://911realtime.org"
      # Retained until the edge redirect lands (see the cutover plan, Task 13):
      # the SPA is still served from beta until then, and a page loaded there
      # sends Origin: https://beta.911realtime.org to this host.
      - "https://beta.911realtime.org"
      # rt911 PR-preview site (GitHub Pages) — previews POST /feedback here.
      - "https://keeping-history.github.io"
```

Leave `accessControlAllowCredentials: true` as it is — `/chat/username-available` needs it.

- [ ] **Step 4: Update the Directus origin and redirect allowlists**

In `apps/rt911/configmap.yaml`, keeping the `beta` entries alongside the new ones for the same reason:

```yaml
  PUBLIC_URL: "https://api.911realtime.org"
  CORS_ORIGIN: "https://911realtime.org,https://beta.911realtime.org,https://keeping-history.github.io"
  AUTH_GOOGLE_REDIRECT_ALLOW_LIST: "https://911realtime.org,https://911realtime.org/,https://beta.911realtime.org,https://beta.911realtime.org/"
  AUTH_APPLE_REDIRECT_ALLOW_LIST: "https://911realtime.org,https://911realtime.org/,https://beta.911realtime.org,https://beta.911realtime.org/"
  USER_REGISTER_URL_ALLOW_LIST: "https://911realtime.org/,https://911realtime.org,https://beta.911realtime.org/,https://beta.911realtime.org"
```

Leave `SESSION_COOKIE_DOMAIN: ".911realtime.org"` alone — it is already correct and is why sessions survive the move.

Do **not** touch `packages/backend/internal/handler/origin.go`. It already lists both the apex and `beta`, which is exactly the set needed now.

- [ ] **Step 5: Commit, push, and watch the sync**

```bash
cd /home/robbiebyrd/infra
git add apps/rt911/
git commit -m "rt911: serve the SPA from the apex, rename api/stream hosts"
git push
kubectl rollout status deployment/rt911-directus -n rt911
```

Directus restarts to pick up the new configmap. The streamer restarts only if its own manifest changed.

- [ ] **Step 6: Verify the old frontend host still works**

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://beta.911realtime.org/
```

Expected: `200`. The apex is not live yet — that is Task 11.

### Task 11: Flip the apex and www records

**Files:** none — Cloudflare API.

- [ ] **Step 1: Replace the apex A record with a proxied CNAME**

Cloudflare flattens a CNAME at the apex. The existing A record `5a6e2d873a9934ce849bb593397257b4` points at the old Google load balancer and must be replaced rather than patched, because the type changes:

```bash
curl -sS -X PUT -H "Authorization: Bearer $CF_DNS_TOKEN" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records/5a6e2d873a9934ce849bb593397257b4" \
  --data '{"type":"CNAME","name":"911realtime.org","content":"dev.keepinghistory.org","proxied":true,"ttl":1}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['success'], d['result']['content'] if d['success'] else d['errors'])"
```

Expected: `True dev.keepinghistory.org`.

- [ ] **Step 2: Repoint www off the decommissioned address**

Record ID `c061645c13698aa7aef55d282ac172dd`. Once Task 12 lands, the edge answers before contacting any origin, so this value is never used — but it must stay **proxied** for the Redirect Rule to run, and pointing at a dead IP in the meantime invites a confusing failure:

```bash
curl -sS -X PUT -H "Authorization: Bearer $CF_DNS_TOKEN" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records/c061645c13698aa7aef55d282ac172dd" \
  --data '{"type":"CNAME","name":"www","content":"dev.keepinghistory.org","proxied":true,"ttl":1}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['success'], d['result']['content'] if d['success'] else d['errors'])"
```

- [ ] **Step 3: Verify the apex serves the SPA**

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://911realtime.org/
curl -sSI https://911realtime.org/index.html | grep -i "cache-control"
```

Expected: `200`, and `cache-control: no-store, must-revalidate`. If the cache header is missing or shows a max-age, the zone-wide Cache Rule from Task 1 Step 4 is overriding nginx — fix that before continuing, or every future deploy serves a stale `index.html`.

- [ ] **Step 4: Verify the backends from the apex origin**

The chat CORS canary. A CORS failure here returns `"unknown"` in the UI rather than an error, so assert on a real answer rather than on the request merely completing.

Get a username that definitely exists straight from the database:

```bash
TAKEN=$(kubectl exec -n rt911 deploy/rt911-directus -- \
  psql "$DATABASE_URL" -tAc \
  "select username from directus_users where username is not null limit 1")
echo "using: $TAKEN"
```

If that pod has no `psql`, use your own signed-in screen name instead — any name you can confirm exists works.

```bash
curl -sS -H "Origin: https://911realtime.org" \
  "https://stream.911realtime.org/chat/username-available?name=$TAKEN"
```

Expected: `{"available":false}`.

Three distinct failures to watch for, all of which mean stop: a CORS rejection, a 404 (the route is not reachable at this hostname), or `{"available":true}` for a name you just read out of the users table — the last means the endpoint is answering but not seeing the database.

Also check a name that certainly does not exist, so a stuck `false` is distinguishable from a real answer:

```bash
curl -sS -H "Origin: https://911realtime.org" \
  "https://stream.911realtime.org/chat/username-available?name=zzz-not-a-real-name-9137"
```

Expected: `{"available":true}`.

Check the preflight carries both required headers:

```bash
curl -sS -X OPTIONS -o /dev/null -D - \
  -H "Origin: https://911realtime.org" \
  -H "Access-Control-Request-Method: GET" \
  "https://stream.911realtime.org/chat/username-available" 2>&1 | grep -i "access-control-allow"
```

Expected: both `access-control-allow-origin: https://911realtime.org` and `access-control-allow-credentials: true`. Credentialed CORS requires an explicit origin; if the origin echoes as `*`, the browser drops the response.

Check Directus:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" \
  -H "Origin: https://911realtime.org" \
  "https://api.911realtime.org/items/readme_articles?limit=1"
```

Expected: `200`.

- [ ] **Step 5: Verify interactively in a browser**

Load `https://911realtime.org/`, then confirm:
- The desktop boots and TV or Radio plays — proves the WebSocket reached `stream.911realtime.org`.
- Sign in with Google, and again with Apple. Both must complete the round trip. IM Buddies derives chat identity from the resulting session cookie, so a broken redirect degrades chat to anonymous rather than throwing a visible error.
- Open IM Buddies, sign on, confirm the buddy roster is **not empty**, and send a message that gets a reply.

An empty roster with a working sign-on is the known `LoadProfiles` failure signature, not a cutover problem — but it must be distinguished before continuing.

Do not proceed to Task 12 until all of these pass. Task 12 is the irreversible one.

### Task 12: Create the redirect rule

**Files:** none — Cloudflare dashboard.

Created through the UI, not the API: this account's token editor exposes no
"Dynamic Redirect" permission (see Task 1 Step 3). It is one rule, created once,
and every check below is token-free.

**This is the irreversible step**: browsers cache a 301 near-indefinitely, so `beta.911realtime.org` cannot cleanly serve anything else afterward.

- [ ] **Step 1: Create the rule in the dashboard**

Go to the `911realtime.org` zone → **Rules → Redirect Rules** →
**Create rule** → *Single Redirect*.

| Field | Value |
|---|---|
| Rule name | `Apex consolidation: www + beta` |
| When incoming requests match | **Custom filter expression** |
| Expression (use the *Edit expression* text box) | `(http.host eq "www.911realtime.org") or (http.host eq "beta.911realtime.org")` |
| Type | **Dynamic** |
| Expression (URL) | `concat("https://911realtime.org", http.request.uri.path)` |
| Status code | **301** |
| Preserve query string | **checked** |

Then **Deploy**.

Two settings that are easy to get wrong:

- **Type must be Dynamic, not Static.** A static target sends every request to
  one fixed URL, discarding the path.
- **Use `http.request.uri.path`, not `http.request.uri`.** The latter already
  contains the query string, so combined with *Preserve query string* it emits
  a doubled query (`?x=1?x=1`). Step 2 tests for exactly this.

If the zone already has redirect rules, add this one rather than replacing
them — the UI appends by default, but confirm the existing list survives.

- [ ] **Step 3: Verify both redirects preserve path and query**

```bash
curl -sSI "https://beta.911realtime.org/some/path?x=1&y=2" | grep -i "^HTTP/\|^location"
curl -sSI "https://www.911realtime.org/some/path?x=1&y=2" | grep -i "^HTTP/\|^location"
```

Expected for both: `HTTP/2 301` and `location: https://911realtime.org/some/path?x=1&y=2`.

A `location` missing the query string means `preserve_query_string` did not apply. A doubled query (`?x=1&y=2?x=1&y=2`) means the target expression used `http.request.uri` instead of `http.request.uri.path`.

- [ ] **Step 4: Confirm the apex did not start redirecting to itself**

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://911realtime.org/
```

Expected: `200`, not `301`. A redirect loop here means the expression matched the apex.

### Task 13: Cleanup

Only run this once the apex has been healthy for as long as you want the safety margin to be. Everything here removes a fallback.

**Files:**
- Modify: `packages/backend/internal/handler/origin.go`, `packages/backend/internal/handler/origin_test.go`
- Modify (infra): `apps/rt911/frontend.yaml`, `apps/rt911/streamer.yaml`, `apps/rt911/configmap.yaml`

- [ ] **Step 1: Update the Go allowlist test first**

In `packages/backend/internal/handler/origin_test.go`, the table currently asserts `beta` is trusted. Change that case and its neighbours to assert the opposite:

```go
		{"beta is retired", "https://beta.911realtime.org", false},
		{"http scheme is a different origin", "http://911realtime.org", false},
		{"port makes a different origin", "https://911realtime.org:8443", false},
		{"path is not part of an origin", "https://911realtime.org/app", false},
		{"trailing slash is tolerated", "https://911realtime.org/", true},
		{"whitespace is trimmed", "  https://911realtime.org  ", true},
```

Also update the standalone assertion near line 49 from `beta` to the apex:

```go
	if !a.Trusted("https://911realtime.org") {
```

- [ ] **Step 2: Run the test and verify it fails**

Run from `packages/backend/`: `go test ./internal/handler/ -run TestOrigin -v`
Expected: FAIL — `beta` still reports trusted.

- [ ] **Step 3: Trim the compiled-in allowlist**

In `packages/backend/internal/handler/origin.go`:

```go
var DefaultTrustedOrigins = []string{
	"https://911realtime.org",
	"https://keeping-history.github.io",
}
```

`www` goes too: it 301s at the edge and can never produce a browser origin.

- [ ] **Step 4: Run the test and verify it passes**

Run from `packages/backend/`: `go test ./internal/handler/ -v`
Expected: PASS.

Then run the whole backend suite, since `DefaultTrustedOrigins` is referenced by the WebSocket handler's tests as well:

Run from `packages/backend/`: `go test ./...`
Expected: PASS across all packages.

- [ ] **Step 5: Commit and merge**

```bash
git add packages/backend/internal/handler
git commit -m "chore(chat): retire the beta origin from the chat allowlist"
git push
```

This ships as a streamer image rebuild, not a config edit — `CHAT_TRUSTED_ORIGINS` is deliberately unset in production, so the trust list lives only in the binary. Wait for the build and the ArgoCD image bump before Step 6.

- [ ] **Step 6: Remove beta from the infra manifests**

In `/home/robbiebyrd/infra`:

- `apps/rt911/frontend.yaml` — delete the `beta.911realtime.org` rule block added in Task 10, and reduce `tls.hosts` to `[911realtime.org]`.
- `apps/rt911/streamer.yaml` — drop `https://beta.911realtime.org` from `accessControlAllowOriginList` and reduce `tls.hosts` to `[stream.911realtime.org]`.
- `apps/rt911/directus.yaml` — reduce all three `tls.hosts` blocks to `[api.911realtime.org]`.
- `apps/rt911/configmap.yaml` — drop every `beta.911realtime.org` entry from `CORS_ORIGIN`, both `AUTH_*_REDIRECT_ALLOW_LIST`s, and `USER_REGISTER_URL_ALLOW_LIST`.

```bash
cd /home/robbiebyrd/infra
git add apps/rt911/
git commit -m "rt911: retire the beta hostname"
git push
```

- [ ] **Step 7: Delete the retired DNS records**

```bash
for id in e19180da2f41980cd17b04692ed4934e 6be8e5ac008203e664fa30676cd01bb9; do
  curl -sS -X DELETE -H "Authorization: Bearer $CF_DNS_TOKEN" \
    "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records/$id" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['success'])"
done
```

Those IDs are `api-beta.911realtime.org` and `stream-beta.911realtime.org`.

Keep the `beta.911realtime.org` record (`775d3ac6c3e933aa30885b56e7f0af1a`) — deleting it would break the Redirect Rule, which needs a proxied record to run on.

- [ ] **Step 8: Final verification**

```bash
curl -sS -o /dev/null -w "apex %{http_code}\n" https://911realtime.org/
curl -sSI https://beta.911realtime.org/ | grep -i "^location"
dig +short api-beta.911realtime.org @1.1.1.1
```

Expected: `apex 200`; a `location` header pointing at the apex; and no output from the `dig` — `api-beta` no longer resolves.

Then reconfirm in a browser that IM Buddies still signs on from the apex and the roster loads, since Step 3 changed the gate that governs it.

---

## Out of scope

- Decommissioning the old GCS bucket and its Google load balancer.
- The `admin`, `cdn`, `cdn1`, `cdn2`, and `cdn3` DNS records.
- Removing the `api-beta` response-mixing comments from source. They document a live Directus behaviour that is unrelated to the hostname.
