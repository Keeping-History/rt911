# Playlist Authentication & Ownership — Design Spec

**Date:** 2026-07-16
**Status:** Approved (brainstorm sign-off, section by section)
**Depends on:** Teacher Playlists (shipped 2026-07-16 — `plans/2026-07-16-teacher-playlists-design.md`)
**Scope:** Auth + accounts + playlist ownership + a secure CRUD API. The playlist **editor UI is
explicitly out of scope** (its own future spec); this project delivers the seam it will consume.

## Goal

Teachers sign in (Google, email+password, Facebook, Apple), own their playlists, and can
edit/save/publish/share them safely. Students keep consuming published playlists anonymously via
`?playlist=<uuid>` exactly as today.

## Load-bearing constraint (probed, not assumed)

The API is **Directus 12.1.1** and custom permission item rules are **license-gated** on this
instance: creating a permission with `{"user_created": {"_eq": "$CURRENT_USER"}}` fails with
`custom_permission_rules_enabled is a restricted resource` (verified 2026-07-16; the only
rules-bearing permissions present are Directus system built-ins). Therefore **Directus's
permission engine cannot enforce per-teacher ownership here** — enforcement lives in a custom
endpoint extension (code we control, not license-gated). Related: the current public read
permission on `/items/playlists` cannot be row-filtered, so **drafts are publicly readable by
UUID today** — this design closes that hole.

## Decisions (from brainstorm)

| Question | Decision |
|---|---|
| Scope | Auth + ownership + CRUD API now; editor UI later (consumes `playlistApi.ts`) |
| Providers (v1) | Google, email+password, Facebook, Apple — all four |
| Sign-up | Open self-service, email-verified; no admin approval |
| Sharing | Publish → student link; plus **duplicate** (any teacher copies a published playlist into their account as a draft) |
| Architecture | **A: Directus-native identity + custom endpoint extension** for enforcement (B = own Go BFF is the documented fallback if the SSO spike fails) |
| Account UI styling | The Account app is built from Classicy components (`ClassicyWindow`, `ClassicyButton`, the Feedback app's form controls) — the sign-in window must read as a native Mac OS 8 dialog |

## §1 Identity & accounts (Directus)

- New role **`Teacher`** + attached policy: `app_access: false` (teachers never see the Directus
  admin app), **no direct `items` permissions on `playlists`** — the extension is the only path.
- **SSO:** `AUTH_PROVIDERS=google,facebook,apple` via env (OpenID Connect for Google/Apple,
  OAuth2 for Facebook) in `rt911-config` + client secrets in `rt911-secrets`. Each provider sets
  `AUTH_<P>_DEFAULT_ROLE_ID` = Teacher so first sign-in auto-provisions the account.
- **Email+password:** `public_registration: true` with `PUBLIC_REGISTRATION_ROLE` = Teacher and
  **verify-email required** before first login.
- **External prerequisites (ops, not code):**
  1. Google OAuth client (free)
  2. Meta developer app (free)
  3. Apple Developer Program membership + Services ID + signing key (**paid**; provider list is
     config, so Apple may lag launch)
  4. An SMTP path (`EMAIL_TRANSPORT`, e.g. SES/Mailgun/Postmark) for verification + password
     reset — the cluster has none today. **SSO-only works without it; email+password does not.**
- **Step zero is a verification spike:** configure Google on a scratch basis and prove a live
  login round-trip on beta **before any other work**. If SSO turns out license-gated like the
  permission rules, stop and pivot to Approach B (own Go auth/BFF service) reusing this spec's
  API contract (§3 routes) unchanged.

## §2 Sessions & frontend sign-in surface

- **Directus session cookies** (`session` auth mode): httpOnly, secure, `SameSite=Lax`,
  `SESSION_COOKIE_DOMAIN=.911realtime.org`. Frontend (`beta.911realtime.org`) and API
  (`api-beta.911realtime.org`) share the registrable domain, so cookies flow on
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

## §3 Enforcement extension

- **Directus endpoint extension** mounted at `/playlist-api`, new monorepo package
  `packages/directus-extensions/playlist-api`. Deployment: `rt911-api` image becomes a thin
  custom image (`FROM directus/directus:12.1.1` + `COPY` extension dist), built/pushed by this
  repo's CI; one infra-repo change points the deployment at it.
- Every route reads `req.accountability` (session user) and uses `ItemsService`, which stamps
  `user_created` automatically on create.

| Route | Auth | Rule |
|---|---|---|
| `GET /playlist-api/:id` | public | Row only if `status = published`, else 404. Response keeps the `{ data: … }` shape so the student loader changes one URL. |
| `GET /playlist-api/mine` | teacher | Caller's playlists, any status. |
| `POST /playlist-api` | teacher | Create draft owned by caller. Server-side structural validation of `definition` (version 1, valid mode, entries array). Soft cap 100 playlists/user (abuse guard). |
| `PATCH /playlist-api/:id` | owner | Edit `title`/`definition`/`status` (publish = `status: "published"`); 403 when `user_created` ≠ caller. Same validation as create. |
| `DELETE /playlist-api/:id` | owner | Delete; 403 otherwise. |
| `POST /playlist-api/:id/duplicate` | teacher | Source must be published **or** owned by caller → new draft `"Copy of <title>"` owned by caller. |

- **Schema:** `playlists` gains `user_created` (uuid, `user-created` special), `date_created`,
  `date_updated`. Existing rows stay ownerless (admin-editable only).
- **Permissions:** DELETE the current public read permission (id 16) on `playlists` — closes the
  draft leak; the extension becomes the only public read path (published-only). Teacher policy
  gets no direct `items` permissions.

## §4 Frontend integration

- **`playlistApi.ts`** (beside `loadPlaylist.ts`): thin client for the six routes, always
  `credentials: "include"`. **This module is the editor project's entire seam** — the editor
  consumes it without knowing Directus exists.
- **`loadPlaylist.ts`**: one-line change — fetch `/playlist-api/:id` instead of
  `/items/playlists/:id`.
- `AuthProvider` + Account app as in §2.

## §5 Error handling

| Case | Behavior |
|---|---|
| 401 from any authed call | "You need to sign in" + Account app window focuses |
| 403 (not owner) | Classicy error dialog |
| SSO provider failure | Redirect lands with `?reason=`; sign-in window shows it |
| Unverified email login | Directus's "verify first" error shown verbatim |
| Student loads unknown/draft/deleted playlist | Existing fail-open dialog ("This playlist could not be loaded.") — unchanged |
| PR-preview origin | Account app shows "sign-in unavailable on previews"; rest of app normal |

## §6 Testing

- **Extension package:** its own unit suite — route handlers against a mocked `ItemsService`;
  table-driven cases for ownership (owner/other/anonymous), published-only reads, duplicate
  rules (published-not-owned, owned-not-published, neither), validation rejects, the 100-cap.
- **Frontend:** vitest for `AuthProvider` (mocked fetch: signed-in/anonymous/preview) and
  `playlistApi` (URL/credential/error mapping). `afterEach(cleanup)` per repo convention.
- **Playwright:** one spec — mocked `/users/me` + sign-in form → Account app state flips
  signed-out → signed-in; mocked 403 → error dialog.
- **Live (unmockable):** the SSO round-trip = the §1 spike, performed manually on beta with the
  real Google client. Documented as an ops checklist item, not an automated test.

## Out of scope (explicit)

- The playlist editor UI (next project; consumes `playlistApi.ts`).
- Teacher-to-teacher collaboration/co-ownership (only duplicate ships).
- Migrating existing ownerless playlists to an owner.
- Rate limiting beyond the per-user cap (Directus `RATE_LIMITER` env can be enabled as ops
  hardening independently).
