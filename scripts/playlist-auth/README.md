# Directus enforcement — Teacher role/permissions (ops-as-code)

Creates and verifies the Teacher role/policy on the `playlists` collection in the
live api-beta Directus instance (https://api-beta.911realtime.org). This is prod;
`verify.sh` creates and tears down its own throwaway users/playlists so it's safe
to run repeatedly.

## What the scripts do

- **`apply.sh`** — idempotent (checks-before-creates by name/field). Creates, if
  missing:
  - `playlists` schema fields: `user_created` (uuid, special `user-created`,
    readonly/hidden), `date_created`, `date_updated` (timestamps, readonly/hidden).
  - A `Teacher` policy (`app_access: false`, `admin_access: false`) and a `Teacher`
    role linked to it via `/access`.
  - Four permissions on `playlists` for that policy: `create` (fields limited to
    `title`/`definition`/`status`, validated to `status in [draft, published]`),
    `read`/`update`/`delete` (all row-filtered to `user_created == $CURRENT_USER`;
    `update` re-validates the same status constraint).
  - Echoes `TEACHER_POLICY_ID` and `TEACHER_ROLE_ID` on success.

- **`verify.sh`** — the enforcement matrix test suite *and* the prod acceptance
  checklist. Logs in as admin, resolves the Teacher role, creates two throwaway
  Teacher users (A, B) and exercises: create-as-draft, owner auto-stamping,
  forged-owner handling, cross-user read/update/delete denial, anonymous
  read-published-only, and invalid-status rejection — asserting exact HTTP status
  codes with plain curl. A `trap cleanup EXIT` deletes the throwaway
  users/playlists even on failure.

Both scripts take the instance URL as `$1` (default
`https://api-beta.911realtime.org`) and read `DIRECTUS_ADMIN_PASSWORD` from the
environment (never pass it as a CLI arg / never let it land in shell history —
pull it fresh from the cluster secret each time):

```sh
DIRECTUS_ADMIN_PASSWORD=$(kubectl get secret rt911-secrets -n rt911 -o jsonpath='{.data.ADMIN_PASSWORD}' | base64 -d) \
  bash scripts/playlist-auth/apply.sh
DIRECTUS_ADMIN_PASSWORD=$(kubectl get secret rt911-secrets -n rt911 -o jsonpath='{.data.ADMIN_PASSWORD}' | base64 -d) \
  bash scripts/playlist-auth/verify.sh
```

## Recorded ids (applied 2026-07-16 against https://api-beta.911realtime.org)

```
TEACHER_POLICY_ID=6f19b514-ae09-4e17-bdf1-9c3fc7c713be
TEACHER_ROLE_ID=7d65fc02-670c-44a9-914d-5fd6e2dcec17
```

Task 2 consumes `TEACHER_ROLE_ID` (self-registration assigns this role).

## Known deviation from the curl calls as originally drafted

Both scripts add a `-g`/`--globoff` flag to every `curl` call whose URL contains a
Directus `filter[field][_operator]=...` query string. Without it, curl's own URL
globbing parses the literal `[`/`]` characters as glob-range syntax and fails
client-side (`curl: (3) bad range in URL position ...`) before any request reaches
the server, on this box's curl build. This is a client-side compatibility fix, not
a change to any request body, assertion, or expected status code.

## Known verify.sh finding: "client-supplied user_created ignored" does not hold as written

The `create` permission's `fields` allow-list is `["title","definition","status"]`
(deliberately excludes `user_created`, since it's the readonly auto-stamped
owner field). On this Directus 12.1.1 instance, when a client's create payload
includes a field that is *not* on that allow-list — even `user_created` set to
another user's id — Directus rejects the **entire request** with `403 FORBIDDEN`
(`"You don't have permission to access field \"user_created\"..."`) rather than
silently stripping the disallowed field and proceeding with the server-derived
value. The brief's assertion `check "client-supplied user_created ignored" "$A_ID" "$OWNER2"`
assumes the latter (silent-ignore) behavior, so it fails: the create call 403s,
`A_PUB` is never assigned, and the subsequent `"B cannot update A's row"` check
inherits an empty `$A_PUB`, PATCHing the *collection* endpoint
(`/items/playlists/` with no id) instead of a real row — which Directus answers
with `400` instead of the intended `403`.

Manually reproduced against a real (non-empty) row to confirm the underlying
security property still holds: a Teacher who does **not** own a published row
gets `403 FORBIDDEN` on `PATCH` (`"You don't have permissions to perform
\"update\"..."`) — the ownership enforcement itself is correct; the way this
specific test constructs its forged-owner scenario is not.

Net effect: attempting to set `user_created` on create fails closed (403) rather
than being silently dropped — arguably a *stronger* guarantee than the brief
assumed, but not what the test asserts. Left the assertions untouched per
instructions (do not silently redefine expected behavior); flagged for the
task owner to decide whether to adjust the test's expectation to `403` on the
create call, or to widen the `create` permission's `fields` list to include
`user_created` (relying on Directus's `user-created` special-field auto-stamp
to still override any client value once the field is permitted). Either fix
belongs to whoever owns the test assertions, not to this apply/verify pass.

As a result, the current `verify.sh` run ends with `2 CHECK(S) FAILED` (of 12),
both traceable to this single root cause; the other 10 — including the full
ownership matrix (own-read, cross-user read/update/delete denial, anonymous
draft-vs-published gating, invalid-status rejection) and the pre-existing
anonymous smoke playlist (`2b2b1bc0-0e42-478f-a55a-5c89cac31c8c` → `200`) — all
pass.
