# Playlist Authentication & Ownership — Design Spec

**Date:** 2026-07-16 (amended same day after the license-key spike — see History)
**Status:** Amended post-spike; awaiting user review
**Depends on:** Teacher Playlists (shipped 2026-07-16 — `plans/2026-07-16-teacher-playlists-design.md`)
**Scope:** Auth + accounts + playlist ownership + a secure CRUD path. The playlist **editor UI is
explicitly out of scope** (its own future spec); this project delivers the seam it will consume
(`playlistApi.ts`).

## Goal

Teachers sign in (Google, email+password, Facebook, Apple), own their playlists, and can
edit/save/publish/share them safely. Students keep consuming published playlists anonymously via
`?playlist=<uuid>` exactly as today.

## History / spike results (probed, not assumed)

1. **Morning:** Directus 12.1.1 on the Core (unlicensed) tier gates custom permission item rules
   (`custom_permission_rules_enabled RESTRICTED`) **and SSO** (local-container spike log: *"you
   have SSO providers configured these will be unavailable under the current license tier"*).
   The original draft of this spec therefore routed all enforcement through a custom endpoint
   extension.
2. **Then:** a production license key was provided and installed — `LICENSE_KEY` in the
   `rt911-secrets` Secret (injected via the deployment's existing `envFrom`; the Secret is
   manually managed, NOT in the infra repo — the key file itself lives at
   `~/directus-license-key.txt`, mode 0600, deliberately outside any git checkout).
3. **Verified un-gated on prod:** a `$CURRENT_USER` item rule now creates successfully
   (created + deleted as a probe). SSO is enforced by the same license mechanism per the
   [v12 release notes](https://github.com/directus/directus/releases/tag/v12.0.0); final
   confirmation happens when the first real provider is configured (Plan step zero).
4. **Already applied to prod** (was approved in the pre-amendment design, became possible with
   the license): the public read permission on `playlists` (id 16) is now row-filtered
   `status = published`. Verified: published playlist reads 200 anonymously, drafts read 403,
   and the student loader's fail-open dialog handles the 403 correctly.
5. **Consequence:** the endpoint extension, custom `rt911-api` image, and infra-repo change from
   the original draft are **deleted from this design**. Enforcement is native Directus
   permissions. Directus's endpoint-extension mechanism was also spike-verified working
   (loads, serves, `ItemsService` usable) — kept in the back pocket for future needs (e.g.
   server-side definition validation), required by nothing in v1.

## Decisions (from brainstorm)

| Question | Decision |
|---|---|
| Scope | Auth + ownership + CRUD path now; editor UI later (consumes `playlistApi.ts`) |
| Providers (v1) | Google, email+password, Facebook, Apple — all four |
| Sign-up | Open self-service, email-verified; no admin approval |
| Sharing | Publish → student link; plus **duplicate** (any teacher copies a published playlist into their account as a draft) |
| Architecture | Directus-native identity **and** native permission enforcement (license-unlocked) |
| Account UI styling | The Account app is built from Classicy components (`ClassicyWindow`, `ClassicyButton`, the Feedback app's form controls) — the sign-in window must read as a native Mac OS 8 dialog |

## §1 Identity & accounts (Directus)

- New role **`Teacher`** + attached policy (see §3): `app_access: false` — teachers never see the
  Directus admin app; their only surface is our frontend.
- **SSO:** `AUTH_PROVIDERS=google,facebook,apple` via env (OpenID Connect for Google/Apple,
  OAuth2 for Facebook) in `rt911-config` + client secrets in `rt911-secrets`. Each provider sets
  `AUTH_<P>_DEFAULT_ROLE_ID` = Teacher so first sign-in auto-provisions the account.
- **Email+password:** `public_registration: true` with `PUBLIC_REGISTRATION_ROLE` = Teacher and
  **verify-email required** before first login (spike-verified registration works on 12.1.1).
- **External prerequisites (ops, not code):**
  1. Google OAuth client (free)
  2. Meta developer app (free)
  3. Apple Developer Program membership + Services ID + signing key (**paid**; provider list is
     config, so Apple may lag launch)
  4. An SMTP path (`EMAIL_TRANSPORT`, e.g. SES/Mailgun/Postmark) for verification + password
     reset — the cluster has none today. **SSO-only works without it; email+password does not.**
- **Plan step zero:** configure the Google provider with a real client and prove one live login
  round-trip on beta (confirms SSO un-gating end-to-end before UI work).
- **Ops notes (from the license spike):** the deployment runs `directus/directus:latest` — pin
  to a specific version tag (image choice lives in the infra repo) so Directus doesn't silently
  upgrade on pod restarts; license validation is **online mode** (periodic revalidation against
  Directus's licensing service — outbound network required, which the cluster has).

## §2 Sessions & frontend sign-in surface

- **Directus session cookies** (`session` auth mode): httpOnly, secure, `SameSite=Lax`,
  `SESSION_COOKIE_DOMAIN=.911realtime.org`. Frontend (`beta.911realtime.org`) and API
  (`api-beta.911realtime.org`) share the registrable domain, so the cookie flows on
  `fetch(..., { credentials: "include" })`.
- CORS: `CORS_CREDENTIALS=true`; keep the explicit origin list (credentials forbid `*`). The
  GitHub-Pages PR-preview origin is cross-site → no sessions there; the Account app shows a
  "sign-in unavailable on previews" note (detect: `/users/me` 401 + known preview host).
- **Nothing auth-shaped ever touches `localStorage` or the ClassicyStore** — same discipline as
  playlist runtime state. The httpOnly cookie is the whole session.
- **Flows:** SSO = navigate to `…/auth/login/<provider>?redirect=<frontend URL>`, Directus sets
  the cookie and bounces back; on return the app re-asks `GET /users/me`. Email = `POST
  /auth/login` (`mode: "session"`); registration = `POST /users/register` + verification email.
- **`AuthProvider`** (non-persisted React context, sibling of `PlaylistProvider`): calls
  `/users/me` with credentials at boot; exposes `{ user, signInWithProvider, signInWithEmail,
  register, signOut }`. Signed-out is the default; everything that exists today keeps working
  anonymously — auth is purely additive for authoring.
- **Account app** (new Classicy app, desktop icon + one window):
  - Signed out: Mac OS 8-style sign-in dialog — provider buttons + email form + register link.
    **Built strictly from Classicy components so it matches the system style closely.**
  - Signed in: identity display, sign-out button, and a reserved spot for the future editor's
    "My Playlists" list.
  - No other auth UI anywhere in v1 (no menu-bar items).

## §3 Enforcement — native Directus permissions

- **Schema:** `playlists` gains `user_created` (uuid, `user-created` special — Directus stamps
  it automatically), `date_created`, `date_updated`. Existing rows stay ownerless
  (admin-editable only; migration is out of scope).
- **Public policy** (already live): read `playlists` where `status = published`.
- **Teacher policy** (all rules use `user_created = $CURRENT_USER`):

| Action | Rule | Field limits |
|---|---|---|
| create | — (owner auto-stamped) | `title`, `definition`, `status` only; validation: `status` ∈ {draft, published} |
| read | own rows, any status (public published-read also applies) | `*` |
| update | own rows only | `title`, `definition`, `status` only; same status validation |
| delete | own rows only | — |

  Field limits are part of the same license unlock — the plan verifies them with a probe before
  relying on them (fallback: allow `*` fields; `user_created` is still non-forgeable because the
  `user-created` special ignores client-supplied values).
- **Duplicate is client-side** — no server code: `playlistApi.duplicate(id)` = `GET` the source
  (works for published rows via public read, and for the caller's own drafts via own-read) then
  `POST` a copy (`"Copy of <title>"`, `status: draft`). Ownership of the copy stamps
  automatically.
- **Definition validation is client-side** (`parsePlaylist` already exists and runs pre-save in
  the future editor). A malformed definition saved by other means breaks only its author's own
  playlist (students get the existing fail-open dialog). Server-side deep validation is the
  documented first use-case for an endpoint extension if it's ever needed — not in v1.
- **Abuse guards:** none custom in v1; Directus `RATE_LIMITER` env can be enabled as independent
  ops hardening.

## §4 Frontend integration

- **`playlistApi.ts`** (beside `loadPlaylist.ts`): thin client over `/items/playlists` +
  `/users/me`, always `credentials: "include"` — `listMine` (`filter[user_created][_eq]=$CURRENT_USER`
  is implicit via permissions; a plain list returns exactly own+published, so `listMine` filters
  client-side on `user_created`), `get`, `create`, `update`, `remove`, `duplicate`. **This
  module is the editor project's entire seam.** Sequential fetches only (api-beta
  response-mixing bug).
- **`loadPlaylist.ts`: unchanged** — the public `/items/playlists/:id` read is now
  published-only at the permission layer, which is exactly the semantics it already assumes.
- `AuthProvider` + Account app as in §2.

## §5 Error handling

| Case | Behavior |
|---|---|
| 401 from any authed call | "You need to sign in" + Account app window focuses |
| 403 (not owner / draft not yours) | Classicy error dialog |
| SSO provider failure | Redirect lands with `?reason=`; sign-in window shows it |
| Unverified email login | Directus's "verify first" error shown verbatim |
| Student loads unknown/draft/deleted playlist | Existing fail-open dialog ("This playlist could not be loaded.") — unchanged (draft now 403s, verified live) |
| PR-preview origin | Account app shows "sign-in unavailable on previews"; rest of app normal |

## §6 Testing

- **Permission model (the enforcement tests):** a table-driven integration script run against a
  disposable local Directus 12.1.1 container (the spike showed this takes seconds): two teacher
  users + anonymous, asserting the full matrix — read own draft ✓ / other's draft ✗ / published ✓
  anonymously; update/delete own ✓ / other's ✗; `user_created` not forgeable; duplicate
  semantics. The same script doubles as the prod verification checklist after the permissions
  are applied.
- **Frontend:** vitest for `AuthProvider` (mocked fetch: signed-in/anonymous/preview) and
  `playlistApi` (URL/credential/error mapping, duplicate composition). `afterEach(cleanup)` per
  repo convention.
- **Playwright:** one spec — mocked `/users/me` + sign-in form → Account app state flips
  signed-out → signed-in; mocked 403 → error dialog.
- **Live (unmockable):** the Google SSO round-trip = Plan step zero, performed manually on beta
  with the real client. Documented as an ops checklist item, not an automated test.

## Out of scope (explicit)

- The playlist editor UI (next project; consumes `playlistApi.ts`).
- Teacher-to-teacher collaboration/co-ownership (only duplicate ships).
- Migrating existing ownerless playlists to an owner.
- Server-side definition validation (extension mechanism verified available if ever needed).
