# Account Profile Editing — Design Spec (addendum to playlist-auth)

**Date:** 2026-07-16 · **Status:** Approved (brainstorm sign-off)
**Depends on:** playlist-auth (this branch — SSO/sessions/avatars live)

## Goal

Teachers edit their own account record in the Account app: names, email (verified
round-trip), password (email-provider accounts only), and optional demographic fields —
plus the already-shipped avatar.

## Decisions

| Question | Decision |
|---|---|
| Editable fields | names + email + password + demographics (below) |
| Email changes | **Full verification round-trip** via our first Directus endpoint extension; direct `PATCH email` must 403 |
| Password | Only for `provider === "default"` accounts (hidden for SSO); gated on the classicy `type="password"` input fix, which we implement in classicy itself (`~/classicy`, auto-publishes) |
| Demographics | `city`, `state`, `country`, `school_name` (strings); `educator_role` (select: teacher/librarian/professor/homeschool/museum_educator/administrator/other); `grade_levels` (json multi: elementary/middle/high_school/college/adult); `subjects` (json multi: us_history/world_history/social_studies/civics/english/journalism/media_studies/stem/other). All optional, self-reported, never publicly readable |
| UI | Signed-in Account view becomes a profile editor with per-section saves (Names / About You / Email / Password / Avatar), Classicy components only |

## Security spine

- Teacher `directus_users` **update** fields: `[avatar, first_name, last_name, password,
  city, state, country, school_name, educator_role, grade_levels, subjects]`. Email
  EXCLUDED — the extension is the only email-change path.
- Teacher `directus_users` **read** (own row) fields: previous + `provider` + the
  demographic fields. Never `password`, `role`, `status`, `auth_data`.
- verify.sh matrix: names PATCH flips to 200 (was a 403 assertion); NEW 403 asserts for
  direct `email`, `role`, `status` PATCHes; one demographic save 200.

## Email-change extension (`packages/directus-extensions/profile-api`)

- Endpoint bundle at `/profile`:
  - `POST /profile/email-change` `{newEmail}` — authed; validates format + uniqueness;
    signs a stateless JWT with Directus's `SECRET` (`{sub: userId, email: newEmail}`,
    24h exp); sends the confirmation link to the NEW address via Directus MailService
    (Resend SMTP, already live). Link: `https://beta.911realtime.org/?confirm-email=<jwt>`.
  - `POST /profile/email-change/confirm` `{token}` — authed; verifies signature/expiry
    AND that `req.accountability.user === token.sub`; applies via UsersService with
    service accountability; returns the new email.
- No schema, no pending-state table (JWT is the state). Rate limiting: rely on Directus
  RATE_LIMITER (ops toggle) — same posture as the rest of v1.
- **Deployment:** rt911-api becomes a custom image (`FROM directus/directus:12.1.1` +
  extension dist), built/pushed by rt911 CI (new job in build.yml, GHCR), infra repo
  deployment switches from `directus/directus:latest` to the pinned custom image —
  retiring the pin-the-version follow-up.

## Frontend

- classicy: `ClassicyInput` gains a passthrough `type` prop (text default) — implemented
  in `~/classicy`, auto-published; unblocks password masking here, in the sign-in form,
  and future registration.
- `profileApi.ts` beside authApi: `updateProfile(patch)` (PATCH /users/me, names +
  demographics + password), `requestEmailChange(newEmail)`, `confirmEmailChange(token)`.
  Sequential fetches, credentials, same 401/403 error classes.
- `AuthUser` gains `provider` + demographic fields; fetchMe requests them.
- Account app: per-section editor; email section shows current email + "Send
  Confirmation Link" flow; on boot, a `?confirm-email=<token>` param triggers the
  confirm call and shows success/failure (signed-out → prompt to sign in first, token
  preserved until confirmed or expired).

## Testing

- Extension: unit suite against mocked services (valid/expired/tampered token,
  wrong-user token, email-in-use, bad format).
- Matrix: the flips + new 403s above, plus email-change request/confirm happy path
  exercised live by verify.sh once deployed (two throwaway users).
- Frontend: vitest per section (names save, provider-gated password visibility,
  email-flow states, confirm-param handling); classicy prop tested in classicy's suite.

## Out of scope

- Public visibility of any profile field (future: author attribution on playlists).
- Account deletion, data export (future compliance pass).
- Email-change for the admin account (admin uses the Directus app).
