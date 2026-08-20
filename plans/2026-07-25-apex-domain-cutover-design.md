# Apex Domain Cutover — Design

**Date:** 2026-07-25
**Revised:** 2026-07-27 — account for the IM Buddies app and the chat streamer
endpoints, which landed after this design was first written.
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
| `stream.911realtime.org` | cluster, proxied | streamer: `/stream` WSS, `/chat/username-available`, `/feedback`, `/clock`, `/health`, `/ready` |
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

**Trim the compiled-in chat origin list in cleanup, not at cutover.** See below.

## Chat origin gates

The IM Buddies system, which landed after this design was first written, puts
two *independent* origin gates in front of the streamer host. Both must accept
the apex, and they are updated through different mechanisms.

`stream.911realtime.org` now serves `/stream` (WebSocket), `/feedback`,
`/clock`, `/health`, `/ready`, and — new — `/chat/username-available`.

**Gate 1: the Traefik `streamer-cors` middleware.** Already carries
`accessControlAllowCredentials: true`, because `checkUsername` calls the
endpoint with `credentials: "include"` so the streamer can resolve the Directus
session cookie. Its `accessControlAllowOriginList` still names `beta` and must
gain the apex. Credentialed CORS cannot use a wildcard, so this list is the only
thing standing between the apex and a dropped response.

**Gate 2: the Go `OriginAllowlist`** (`handler.NewOriginAllowlist`), which gates
*identity* on both `/stream` and `/chat/username-available`. An untrusted origin
still streams media anonymously; it simply cannot turn a session cookie into a
chat identity.

Two properties of gate 2 matter for this cutover:

- **`CHAT_TRUSTED_ORIGINS` is deliberately unset in production**
  (`apps/rt911/streamer.yaml` documents why). The production trust list is
  therefore *compiled into the streamer image*. Unlike every other allowlist
  here, it cannot be corrected by editing a configmap — a wrong value requires
  an image rebuild and redeploy. If a faster escape hatch is wanted during the
  cutover window, `CHAT_TRUSTED_ORIGINS` can be set temporarily to add an origin
  without a rebuild; note the file's warning against reintroducing it to name
  the streamer's *own* host, which is a different and unsafe use.
- **`beta` must stay in the list until cleanup.** Steps 5 through 7 keep `beta`
  serving the SPA from the cluster, and that SPA dials `stream.911realtime.org`
  with `Origin: https://beta.911realtime.org`. Trimming `beta` in the cutover PR
  would deny identity to everyone still on `beta` and sign them out of chat
  mid-window.

**The failure mode here is silent.** `checkUsername` returns `"unknown"` for
anything that is not a clear yes or no — including a CORS rejection — and the UI
treats `"unknown"` as "no opinion" rather than surfacing an error. A broken
origin list does not throw; the sign-on and Account screens simply stop warning
about names that are already taken, and the unique index catches it later. This
will pass a smoke test that only checks the page loads, so the verification
section below asserts on a *positive* `available`/`taken` answer.

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
- `packages/backend/internal/handler/origin.go` — **no change during the
  cutover.** `DefaultTrustedOrigins` already lists the apex, `www`, `beta`, and
  `keeping-history.github.io`, which is exactly the set needed while `beta` is
  still serving. Trimming `www` and `beta` is deferred to the cleanup phase; see
  "Chat origin gates" below for why doing it earlier signs users out of chat.
- `src/Providers/Auth/usernameApi.ts` — derives its HTTP base by rewriting
  `VITE_MEDIA_STREAM_URL` (`ws`→`http`, stripping the trailing `/stream`). This
  transform moves into `endpoints.ts` rather than staying duplicated, so
  `STREAM_URL` and the chat REST base come from one place.
- `.github/workflows/build.yml` — point `FE_VITE_MEDIA_STREAM_URL` and
  `FE_VITE_FEEDBACK_URL` at `stream.911realtime.org`, and **add**
  `FE_VITE_DIRECTUS_URL` for `api.911realtime.org`.
- `.github/workflows/pr-preview.yml` — the same three variables.
- `packages/frontend/.env` and `.env.example`.
- `authApi.test.ts` — the two assertions covering the off-domain fallback.
  `origin_test.go` changes in the cleanup phase, not the cutover.
  `AuthProvider.test.tsx` needs **no** change despite naming `beta`: it uses
  that hostname only as a stand-in origin to prove `signInWithProvider` strips
  the query string, an assertion that holds for any hostname.

### infra repository

- The new hostnames added to each Ingress's `tls.hosts` **without** touching
  `rules.host`, ahead of any traffic change. cert-manager's ingress-shim owns
  the `rt911-frontend-tls`, `rt911-api-tls`, and `rt911-streamer-tls`
  Certificates (it names them after `secretName`), so extending `tls.hosts`
  re-issues each cert with the extra SAN while routing stays put. Standalone
  `Certificate` resources are deliberately avoided: they would contend with
  ingress-shim for ownership of the same secret.
- `apps/rt911/frontend.yaml` — Ingress host and TLS SAN to the apex.
- `apps/rt911/directus.yaml` — three `api-beta` host blocks to `api`.
- `apps/rt911/streamer.yaml` — Ingress host to `stream`; the `streamer-cors`
  middleware's `accessControlAllowOriginList` gains the apex and keeps `beta`
  until cleanup, matching the compiled-in Go list. `accessControlAllowCredentials`
  is already `true` and needs no change. The chat LLM provider keys
  (`ANTHROPIC_API_KEY` and friends) are outbound-only and unaffected.
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
2. **infra commit A** — extend each Ingress's `tls.hosts` with its new
   hostname, leaving `rules.host` unchanged. No traffic change. Wait for all
   three Certificates to report `Ready` with the new SAN present.
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
8. **Cleanup commit** — drop `beta` from the frontend ingress; remove `beta` and
   `www` from the `streamer-cors` origin list and from `DefaultTrustedOrigins`
   in `origin.go` (an rt911 change, so it ships as an image rebuild, not a
   config edit); delete the `api-beta` and `stream-beta` DNS records.

Steps 5 and 6 leave no frontend gap, because `beta` continues to serve from the
cluster until step 7.

**`beta` during that window is gap-filler, not a tested fallback.** It exists so
that no request 404s between the ingress switch and the DNS flip, and it is
expected to work — both origin gates deliberately retain `beta` until cleanup,
so chat from `beta` should behave exactly as it does from the apex. It is not
separately verified, and step 7 should follow step 6 as soon as the apex checks
pass rather than pausing to re-test a hostname that is being retired. The
consequence to accept knowingly: if the apex is healthy but `beta` is not, that
is discovered by a user on a bookmark during a window of a few minutes, not by
this checklist.

## Verification

- The apex returns 200 with the SPA, and `index.html` carries `no-store` as
  observed at the edge.
- `www` and `beta` return 301 with a `Location` that preserves path and query.
- A WSS handshake succeeds against `stream.911realtime.org`.
- A CORS preflight from the apex origin to `api.911realtime.org` succeeds.
- Full Google **and** Apple sign-in round trips complete. IM Buddies derives
  chat identity from the resulting session cookie, so a broken OAuth redirect
  degrades chat to anonymous rather than only breaking login.
- **`/chat/username-available` returns a real `available` or `taken` from the
  apex origin — not `"unknown"`.** This is the canary for both origin gates;
  see "Chat origin gates". Check a name known to be taken, so a wrong answer is
  distinguishable from a missing one.
- IM Buddies signs on from the apex, the buddy roster is non-empty, and a
  message round-trips to a buddy and back.
- The session cookie is set on `.911realtime.org`, and chat identity resolves
  from the apex origin.
- `go test ./...`, `pnpm test`, `tsc -b`, and `eslint .` all pass.

## Rollback

Revert the infra commit and let ArgoCD re-sync, then remove the Redirect Rule.
The old GCS origin is not a rollback target — it is being decommissioned.

One asymmetry to plan for: everything in this cutover is revertible by editing
infra config **except the chat origin allowlist**, which is compiled into the
streamer image. Because the cutover PR leaves `DefaultTrustedOrigins` alone,
that asymmetry costs nothing during the risky window — the list already covers
both the apex and `beta`. It only becomes live at step 8, which is why the trim
belongs there and not earlier. If chat identity does break unexpectedly
mid-cutover, setting `CHAT_TRUSTED_ORIGINS` on the streamer Deployment adds an
origin without waiting for a rebuild.

Step 7 is last because the 301 is the one irreversible act in the sequence —
browsers cache it near-indefinitely, so it cannot be cleanly withdrawn. That is
the reason for the ordering, not a tested `beta` fallback: as noted above,
`beta` is expected to work during the window but is not verified. Rollback runs
through reverting the infra commit, not through diverting users to `beta`.

## Out of scope

- Decommissioning the old GCS bucket and its load balancer.
- The `admin`, `cdn`, and `cdn1-3` DNS records.
- Per-path SEO mapping from old-site URLs. nginx serves `index.html` for every
  path (`packages/frontend/nginx.conf`), so old deep links boot the desktop SPA
  rather than hard-404ing.
