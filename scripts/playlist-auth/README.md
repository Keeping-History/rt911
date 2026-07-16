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
  - Four permissions on `playlists` for that policy:

    | action | fields | row filter | notes |
    |---|---|---|---|
    | `create` | `title`, `definition`, `status` | — | validated to `status in [draft, published]`; any other field in the payload (e.g. `user_created`) is rejected outright by Directus (403), not silently stripped |
    | `read` | `*` | `user_created == $CURRENT_USER` **OR** `status == published` | own rows regardless of status, plus any teacher's published rows — see "Teacher published-read" below |
    | `update` | `title`, `definition`, `status` | `user_created == $CURRENT_USER` | re-validates the same status constraint |
    | `delete` | `*` | `user_created == $CURRENT_USER` | |

    The `read` permission is *converged* on every `apply.sh` run (fetch existing
    id → `PATCH` to the target rule, or `POST` if missing) rather than
    skip-if-present, so re-running `apply.sh` always brings a previously-applied
    `read` permission up to the current OR rule.
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

## Directus 12 rejects creates containing fields outside the permission's field list (403)

The `create` permission's `fields` allow-list is `["title","definition","status"]`
(deliberately excludes `user_created`, since it's the readonly auto-stamped
owner field). On this Directus 12.1.1 instance, when a client's create payload
includes a field that is *not* on that allow-list — even `user_created` set to
another user's id — Directus rejects the **entire request** with `403 FORBIDDEN`
(`"You don't have permission to access field \"user_created\"..."`), rather than
silently stripping the disallowed field and proceeding with the server-derived
value.

This fail-closed behavior is the enforcement we rely on for non-forgeable
ownership: a Teacher can never set their own or another user's `user_created`
by including it in a create payload — the request is rejected outright before
any row is written. `verify.sh` encodes this directly: it asserts a create
attempt with a forged `user_created` returns `403`
(`forged user_created rejected on create`), then separately verifies that a
legitimate create (payload without `user_created`) gets the correct owner
auto-stamped by Directus (`user_created auto-stamped on published row`).

**Frontend implication**: playlist-create calls must never include
`user_created` (or any field outside the create permission's allow-list) in the
payload — Directus rejects the whole request rather than ignoring the extra
field.

## Teacher published-read: why the `read` permission is an OR rule, not two rows

`verify.sh`'s `"B reads published"` check (Teacher B, authenticated,
non-owner, reading Teacher A's published row) initially failed: actual `403`,
not the expected `200`. Manually reproduced in isolation (fresh users, single
request) to rule out a script artifact — confirmed:

- anonymous GET of the published row → `200`
- Teacher B (authenticated, non-owner) GET of the same row → `403 FORBIDDEN`
  (`"You don't have permission to access this."`)

Root cause per Directus docs (confirmed via Context7 `/directus/docs`): "The
Public role manages permissions for unauthenticated requests" / "The public
role applies to all unauthenticated requests" — the Public policy (permission
id 16, `status=published` row filter) is **not** merged in as a baseline for
authenticated users. `plans/2026-07-16-playlist-auth-design.md` §3 intends
"own rows, any status (public published-read also applies)" for Teacher
reads, and its client-side duplicate requires an authenticated teacher to be
able to `GET` another teacher's published row — the spec assumed the Public
policy would cascade to authenticated requests, but Directus 12 does not
cascade it.

Resolution: encode published-read directly in the Teacher policy's own `read`
permission, as a single permission with an `_or` rule (not two separate
permission rows):

```json
{"_or":[{"user_created":{"_eq":"$CURRENT_USER"}},{"status":{"_eq":"published"}}]}
```

This grants a Teacher read access to: (a) every row they own, regardless of
status (`draft` included), and (b) any row — theirs or another teacher's —
once it's `published`. Critically, it does **not** grant access to another
teacher's `draft` rows: `"B cannot read A's draft"` still asserts (and
passes) `403`, since neither side of the `_or` matches a non-owned draft.
