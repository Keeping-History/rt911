# Account Profile Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
> Spec: `plans/2026-07-16-account-profile-design.md` (authority on semantics).

**Goal:** Self-service profile editing (names, verified email change, password for
email-provider accounts, optional demographics) in the Account app, plus the classicy
password-mask prerequisite and the custom rt911-api image that carries our first
Directus extension.

## Global Constraints

- Everything from the playlist-auth plan's Global Constraints still binds (test/gate
  commands, no client-side auth persistence, sequential api-beta fetches, secret
  handling, serial Directus schema ops, converge-style permission scripts).
- ALL demographic fields are OPTIONAL: no required validation anywhere; empty input
  saves as null; the UI must never block a save on an empty demographic.
- Direct `PATCH /users/me {email}` must return 403 (verified in the matrix) — the
  extension is the only email path.
- Extension secrets: sign email-change JWTs with the runtime `SECRET` env Directus
  already has; never a new secret.
- classicy work happens in `~/classicy` (push to main auto-publishes; rt911 pre-commit
  auto-bumps the dep). rt911 must not merge before the classicy release is on npm.

## Tasks

### T1 — classicy: `ClassicyInput` passthrough `type` prop
`~/classicy` repo. Add optional `type?: string` (default `"text"`) passed to the native
input; respect existing props; add a test mirroring the component's existing test style;
version bump per repo convention; push to main (auto-publish). Deliverable: npm release
containing the prop. THEN in the rt911 worktree run `pnpm update classicy --latest` and
switch the Account sign-in password field + (T6) password fields to
`type="password"`, with a test asserting the rendered input has the attribute.

### T2 — Directus fields + widened permissions (ops-as-code)
Extend `scripts/playlist-auth/apply.sh`: create the 7 demographic fields on
`directus_users` via `POST /fields/directus_users` (strings; `educator_role` string
with select-dropdown meta options; `grade_levels`/`subjects` type json with cast-json
special + select-multiple-checkbox meta options — values per spec); converge the update
permission fields to `[avatar, first_name, last_name, password, city, state, country,
school_name, educator_role, grade_levels, subjects]` and self-read fields to previous +
`provider` + demographics. Extend `verify.sh`: flip `A cannot update first_name` →
`A updates own names` 200; add 403 asserts for direct `email`, `role`, `status`
PATCHes; add a demographic save 200 (`{"city":"Memphis","grade_levels":["high_school"]}`)
and read-back; run both against prod → ALL CHECKS PASSED; commit.

### T3 — `packages/directus-extensions/profile-api` (code + unit tests)
Endpoint extension per spec §Email-change: two routes, stateless JWT (sign/verify with
`env.SECRET`, 24h), MailService send to the NEW address, uniqueness check via
UsersService, confirm requires `req.accountability.user === payload.sub`. Package has
its own vitest suite with mocked `context.services`/`env` covering: happy path,
expired token, tampered signature, wrong-user confirm, email already in use, invalid
format, unauthenticated 401. Built output committed-buildable via the package's
`build` script (directus-extensions-sdk or plain rollup — match Directus 12 extension
format, `host: ^12.0.0`).

### T4 — Custom rt911-api image + CI + infra switch + live verify
`packages/directus-extensions/Dockerfile`: `FROM directus/directus:12.1.1`, COPY built
extension into `/directus/extensions/directus-extension-profile-api`. New job in
`.github/workflows/build.yml` building/pushing `ghcr.io/keeping-history/rt911-api`
(branch/SHA tags, same pattern as frontend/streamer jobs). Infra repo: deployment image
→ the GHCR image (pinned tag), replacing `directus/directus:latest`. Deploy via GitOps;
verify: pod logs show `Loaded extensions: directus-extension-profile-api`; `/profile/…`
routes respond; then extend `verify.sh` with the live email-change round-trip (user A
requests change → intercepting the actual email is impossible in-script, so the live
check asserts the 204 request + a tampered-token confirm 403 + an admin-crafted valid
token confirm 200 — crafting the same JWT shape with the known SECRET pulled from the
cluster secret).

### T5 — Frontend `profileApi.ts` + AuthUser widening
`AuthUser` gains `provider` + the 7 demographic fields; `fetchMe` requests them.
New `src/Providers/Auth/profileApi.ts`: `updateProfile(patch)` (PATCH /users/me —
names/demographics/password only; never email), `requestEmailChange(newEmail)`,
`confirmEmailChange(token)` → `/profile/*` routes; 401/403 error-class mapping reused;
vitest suite incl. "email key rejected locally" guard test.

### T6 — Account app profile editor UI
Per-section saves (Names / About You / Email / Password / Avatar), Classicy-only:
inputs for names + city/state/country/school; `ClassicyPopUpMenu` for educator_role;
multi-select for grade_levels/subjects using depressed `ClassicyButton` toggles;
password section rendered ONLY when `user.provider === "default"` (masked via T1);
email section = current email + new-email input ×2 (must match) + "Send Confirmation
Link" + sent-state; boot handling of `?confirm-email=<token>` (signed-in → confirm +
result banner; signed-out → sign-in prompt, token kept in memory only). `refresh()`
after each successful save. Vitest per section incl. provider-gating and
empty-demographics-save-ok.

### T7 — Gate + docs
Full gate (build/lint/test + the two e2e specs), ops README updates (extension deploy
notes, email-change runbook), CLAUDE.md touch-up (extensions package exists now),
ledger close-out.

## Sequencing

T1 ⊥ T2 ⊥ T3 can proceed in any order (T1 first — it's the smallest and unblocks T6's
password fields). T4 needs T3. T6 needs T1+T5 (and T4 deployed for live email flow).
SDD discipline: one implementer at a time, task review after each, findings ledgered.
