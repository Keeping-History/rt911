# Apex Domain Cutover — Design

**Date:** 2026-07-25
**Status:** Approved, pending implementation plan

Move the production site from `beta.911realtime.org` to the apex `911realtime.org`,
rename the backend hostnames off their `-beta` suffixes, and redirect the old
public names to the apex.

## Goal

`911realtime.org` becomes the canonical and only public address for the desktop
SPA. `www.911realtime.org` and `beta.911realtime.org` permanently redirect to it.
The Directus and streamer hostnames drop their `-beta` suffix in the same
cutover.

The old apex site — a static bundle in a Google Cloud Storage bucket behind a
Google load balancer at `34.117.146.46` — is decommissioned manually and is out
of scope. It is explicitly **not** a rollback target.

## Current state

The Cloudflare zone `911realtime.org` (`08e515063f366be3278cb3de2380469c`, Free
plan) proxies every public record.

| Name | Type | Value | Serves |
|---|---|---|---|
| `911realtime.org` | A | `34.117.146.46` | old GCS site |
| `www` | A | `34.117.146.46` | old GCS site |
| `beta` | CNAME | `dev.keepinghistory.org` | the SPA (cluster) |
| `api-beta` | CNAME | `dev.keepinghistory.org` | Directus (cluster) |
| `stream-beta` | CNAME | `dev.keepinghistory.org` | streamer (cluster) |
| `files` | CNAME | `dev.keepinghistory.org` | file-proxy (cluster) |
| `api` | CNAME | `admin.911realtime.org` | old stack leftover |
| `admin`, `cdn`, `cdn1-3` | A/CNAME | Google / Shopify | old stack, out of scope |

Two facts about the existing setup shape the whole plan:

- **cert-manager solves `911realtime.org` names via DNS-01 through Cloudflare**
  (`cluster/cert-manager/cluster-issuers.yaml`), not HTTP-01. Certificates can
  therefore be issued for hostnames whose DNS does not yet point at the cluster,
  which removes certificate issuance from the critical path.
- **The session cookie domain is already `.911realtime.org`**
  (`apps/rt911/configmap.yaml`), not `beta.911realtime.org`. Signed-in sessions
  survive the move without re-authentication.

## Target state

| Hostname | Resolves to | Serves |
|---|---|---|
| `911realtime.org` | cluster, proxied | the SPA — the only frontend host on the origin |
| `www.911realtime.org` | proxied, never reaches origin | Cloudflare 301 to apex, path and query preserved |
| `beta.911realtime.org` | proxied, never reaches origin | Cloudflare 301 to apex, path and query preserved |
| `api.911realtime.org` | cluster, proxied | Directus |
| `stream.911realtime.org` | cluster, proxied | streamer WSS and `/feedback` |
| `files.911realtime.org` | unchanged | file-proxy |
| `api-beta`, `stream-beta` | DNS records deleted | — |
| `admin`, `cdn`, `cdn1-3`, `openreplay`, `timemachine` | untouched | out of scope |

## Decisions

**Rename the backend hostnames in the same cutover.** `api-beta` becomes `api`
and `stream-beta` becomes `stream`, rather than leaving them and renaming later.
This costs a coordinated frontend image rebuild and OAuth console changes, but
avoids leaving the `-beta` names permanent by default.

**Hard cut on the backend hostnames — no dual-serve grace period.** The
ingresses switch to the new hosts only; `api-beta` and `stream-beta` stop
resolving to the cluster at cutover. Because `VITE_MEDIA_STREAM_URL` is baked
into the frontend image at build time, a browser tab that was already open when
ArgoCD syncs holds JavaScript that dials `stream-beta`, and that session drops
until the user reloads. This is accepted; the sequencing below confines the
window to the sync itself rather than a sustained outage.

The hard cut applies to the **backend** hostnames only. The frontend's `beta`
host is retained for two steps of the sequence below, so that the public site
never 404s between the ingress switch and the DNS flip. It is removed in the
final cleanup commit, once the edge redirect makes it unreachable anyway.

**301 permanent redirects, preserving path and query.** `beta` and `www` both
redirect to the apex at the Cloudflare edge, so the request never reaches the
cluster. 301 consolidates search-engine signal onto the apex. Browsers cache
301s near-indefinitely, so `beta.911realtime.org` cannot later serve something
different for returning visitors. A future pre-production host must use a fresh
name such as `staging.`.

**Redirect at the edge, not in Traefik.** Cloudflare Redirect Rules keep the
cluster out of the path entirely, so no ingress, certificate, or middleware is
needed for `www` or `beta` in the end state.

## Change set

### rt911 repository

`VITE_DIRECTUS_URL` is set in `pr-preview.yml` but not in `build.yml`, so the
production Directus URL comes from a hardcoded fallback duplicated across eight
source files. Editing only the CI configuration would miss production entirely.

- **New `packages/frontend/src/lib/endpoints.ts`** — one module exporting
  `DIRECTUS_URL`, `STREAM_URL`, and `FEEDBACK_URL`, each reading
  `import.meta.env` with an apex-era default. It replaces the duplicated
  `?? "https://api-beta.911realtime.org"` fallbacks in:
  - `src/Providers/Playlist/loadPlaylist.ts`
  - `src/Applications/PlaylistEditor/directusQueue.ts`
  - `src/Applications/README/useReadmeArticles.ts`
  - `src/Applications/FlightTracker/useRouteIndex.ts`
  - `src/Applications/FlightTracker/useFlightTrack.ts`
  - `src/Applications/FlightTracker/useMapPois.ts`
  - `src/Applications/FlightTracker/useNotableCrashSites.ts`
  - `src/Applications/FlightTracker/useAltitudeProfile.ts`
- `src/Providers/Auth/authApi.ts` — the fallback landing origin becomes the apex.
- `packages/backend/internal/handler/origin.go` — trim `DefaultTrustedOrigins`
  to the apex plus `keeping-history.github.io`. `www` and `beta` become dead
  entries once the edge redirects them. This file landed on `main` in commit
  `3c232a64`.
- `.github/workflows/build.yml` — point `FE_VITE_MEDIA_STREAM_URL` and
  `FE_VITE_FEEDBACK_URL` at `stream.911realtime.org`, and **add**
  `FE_VITE_DIRECTUS_URL` for `api.911realtime.org`.
- `.github/workflows/pr-preview.yml` — the same three variables.
- `packages/frontend/.env` and `.env.example`.
- Tests asserting on `beta` origins in `authApi.test.ts`,
  `AuthProvider.test.tsx`, and `origin_test.go`.

### infra repository

- New `Certificate` resources for the apex, `api`, and `stream`, applied ahead
  of any traffic change so the TLS secrets exist before the ingresses switch.
- `apps/rt911/frontend.yaml` — Ingress host and TLS SAN to the apex.
- `apps/rt911/directus.yaml` — three `api-beta` host blocks to `api`.
- `apps/rt911/streamer.yaml` — Ingress host to `stream`; the `streamer-cors`
  middleware's `accessControlAllowOriginList` to the apex.
- `apps/rt911/configmap.yaml` — `PUBLIC_URL`, `CORS_ORIGIN`,
  `AUTH_GOOGLE_REDIRECT_ALLOW_LIST`, `AUTH_APPLE_REDIRECT_ALLOW_LIST`, and
  `USER_REGISTER_URL_ALLOW_LIST`. `SESSION_COOKIE_DOMAIN` is already correct and
  does not change.

### Cloudflare

- The apex `A` record replaced by a proxied `CNAME` to `dev.keepinghistory.org`,
  relying on Cloudflare's CNAME flattening.
- `www` likewise repointed off the dead GCS address. Its origin value is
  functionally irrelevant once the Redirect Rule is live — the edge answers
  before contacting an origin — but the record must stay **proxied** for the
  rule to run at all, and pointing it at a decommissioned IP in the meantime
  invites a confusing failure mode.
- `api` repointed from `admin.911realtime.org` to the cluster.
- `stream` created as a proxied `CNAME` to `dev.keepinghistory.org`.
- A Redirect Rule matching `www.911realtime.org` and `beta.911realtime.org`,
  issuing a 301 to the apex with the request URI appended.
- `api-beta` and `stream-beta` deleted after cutover.

## Prerequisites

These are manual and block the cutover.

1. **Google Cloud Console** — add
   `https://api.911realtime.org/auth/login/google/callback` to the OAuth
   client's authorized redirect URIs. Directus derives this URI from
   `PUBLIC_URL`; without the console change, Google sign-in fails at cutover.
2. **Apple Developer** — add the equivalent return URL to the Services ID. The
   zone-level `apple-domain` TXT record remains valid.
3. **A Cloudflare API token scoped to Zone → Dynamic Redirect → Edit.** The
   existing cert-manager token is DNS-edit only and returns an authentication
   error against the rulesets API. DNS work can use the existing token;
   Redirect Rules cannot.
4. **Confirm the zone's SSL mode**, and confirm the zone-wide "Cache everything"
   rule left over from the 2026-07-24 cache incident does not cache the apex's
   `index.html`. nginx sends `no-store` on that path, but a Cloudflare Cache
   Rule overrides origin headers, and a stale `index.html` 404s on its old
   hashed bundle after every deploy.

## Cutover sequence

1. Complete the prerequisites above.
2. **infra commit A** — `Certificate` resources only. No traffic change. Wait
   for all three TLS secrets to report `Ready`.
3. **Cloudflare** — create the `stream` record, repoint `api` to the cluster.
   Traefik returns 404 for both; harmless.
4. **rt911 PR merged to `main`** — CI builds the image with the new backend URLs
   and pushes it to GHCR.
5. **infra commit B**, one ArgoCD sync — ingress hosts switched, configmap
   origins updated, frontend image tag bumped. The frontend ingress **retains
   `beta` as a second host** at this step. This is the open-tab break window for
   the hard-cut backends.
6. **Cloudflare** — repoint the apex and `www` at the cluster. Verify the apex
   serves the application end to end.
7. **Cloudflare** — create the 301 Redirect Rule for `www` and `beta`. Only now
   does `beta` stop reaching the origin.
8. **Cleanup commit** — drop `beta` from the frontend ingress; delete the
   `api-beta` and `stream-beta` DNS records.

Steps 5 and 6 leave no frontend gap, because `beta` continues to serve from the
cluster until step 7.

## Verification

- The apex returns 200 with the SPA, and `index.html` carries `no-store` as
  observed at the edge.
- `www` and `beta` return 301 with a `Location` that preserves path and query.
- A WSS handshake succeeds against `stream.911realtime.org`.
- A CORS preflight from the apex origin to `api.911realtime.org` succeeds.
- Full Google **and** Apple sign-in round trips complete.
- The session cookie is set on `.911realtime.org`, and chat identity resolves
  from the apex origin.
- `go test ./...`, `pnpm test`, `tsc -b`, and `eslint .` all pass.

## Rollback

Revert the infra commit and let ArgoCD re-sync, then remove the Redirect Rule.
The old GCS origin is not a rollback target — it is being decommissioned.

This is why step 7 is last. Before it, `beta.911realtime.org` is a fully working
escape hatch. After it, the 301 is cached in browsers and cannot be cleanly
withdrawn.

## Out of scope

- Decommissioning the old GCS bucket and its load balancer.
- The `admin`, `cdn`, and `cdn1-3` DNS records.
- Per-path SEO mapping from old-site URLs. nginx serves `index.html` for every
  path (`packages/frontend/nginx.conf`), so old deep links boot the desktop SPA
  rather than hard-404ing.
