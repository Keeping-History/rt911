# Account "Special" tab — delete my data / delete my account

**Date:** 2026-07-28
**Status:** Approved, not yet implemented

## Problem

The Account app lets a signed-in user edit their profile but never lets them
leave. There is no way to erase what the site has accumulated about them and no
way to close the account at all. Both are ordinary expectations for a site that
asks teachers and students to sign in, and neither is currently possible even
by hand — a user cannot delete their own `directus_users` row.

## Scope

A new **Special** tab in the Account app's profile editor, holding two
destructive actions:

- **Delete my data** — erases the user's content and settings; the account
  survives and stays signed in.
- **Delete my account** — the same erasure, plus removal of the account itself.

Explicitly out of scope, per the request: neither action removes uploaded
files (`directus_files`, Wasabi-backed) or OpenReplay session recordings.

## What the user actually owns

| Where | What | Delete data | Delete account |
|---|---|---|---|
| `directus_users` (own row) | names, screen name, location, school, educator role, grade levels, subjects, avatar link, filesystem link | blanked | row deleted |
| `playlists` | teacher-authored playlists (`user_created`) | deleted | deleted |
| `stacks` | HyperCard stacks (`user_created`) | deleted | deleted |
| `tm_bookmarks_personal` | Time Machine personal bookmarks | deleted | deleted |
| `chat_messages` | IM Buddies conversation history | deleted | deleted |
| `chat_blocks` | moderation blocks / cool-downs | **kept** | **kept** |
| `directus_files` | avatar image, filesystem JSON, uploads | **kept** | **kept** (orphaned) |
| localStorage | `classicyDesktopState`, `rt911AlertsEnabled`, `media-chrome-pref-*` | cleared | cleared |
| OpenReplay | session recordings | **kept** | **kept** |

### Why `chat_blocks` survives

`chat_blocks` is not conversation content — it is the moderation record the
chat guard writes when it detects abuse, deliberately persisted so a block
outlives a reconnect or a reworded resend (see `internal/chat/guard.go`). If
"Delete my data" cleared it, any student under a cool-down could self-unban
with one click and destroy the supporting evidence in the same motion. Blocks
describe the account's standing, not the person's content.

This is imperfect on account deletion — a new sign-up gets a fresh user id, so
a determined user evades a block regardless. Keeping the rows is for records,
not deterrence.

## Approach

Two new routes on the existing `profile-api` Directus extension
(`packages/directus-extensions/profile-api/src/index.js`).

This follows the precedent already set in that file. Verified email changes
live there because `email` is not writable through `/users/me`; account
deletion has the identical shape — the Teacher policy grants no delete on
`directus_users`, and `chat_messages` is not reachable with user credentials at
all. Client-side orchestration cannot implement this feature, not merely
inconvenience it.

Both routes take the caller's identity from `req.accountability.user` and never
from the request body, matching the existing routes' stance.

### Rejected alternatives

- **Client-side orchestration.** Cannot delete the user row or chat messages.
  Would also turn one irreversible action into ~8 independent requests whose
  partial failure leaves an account half-erased with no way to resume.
- **Hybrid** (client deletes what it can, extension deletes the user row).
  Duplicates the definition of "my data" across two codebases that will drift.

## Server design

```
profile-api/src/index.js
  ├─ eraseOwnedData(userId)   ← single source of truth for "what is mine"
  ├─ POST /delete-data        → eraseOwnedData + blank profile fields
  └─ POST /delete-account     → eraseOwnedData + blank + delete user row
```

`eraseOwnedData` existing exactly once is load-bearing: account deletion is
*defined* as data deletion plus the user row, so the two cannot disagree about
scope as collections are added later.

Deletion of `playlists`, `stacks` and `tm_bookmarks_personal` goes through
`ItemsService` with admin accountability, filtered on `user_created = userId`.
`chat_messages` is not a Directus-managed collection in the same sense and is
deleted with the context's knex instance.

**The `"user"` column must be quoted.** `chat_messages` and `chat_blocks` both
key on a column named `user`, a reserved word in Postgres. Unquoted it silently
resolves to `CURRENT_USER` and matches the wrong rows rather than erroring —
the Go code carries this warning at both call sites.

### Deleting the user row requires clearing blocking references first

Verified against the live schema on 2026-07-28. Every FK pointing at
`directus_users` falls into three groups:

| On delete | Tables | Consequence |
|---|---|---|
| `CASCADE` | `directus_sessions`, `directus_presets`, `directus_notifications.recipient`, `directus_access`, `directus_oauth_*` | handled automatically |
| `SET NULL` | `directus_dashboards`, `directus_panels`, `directus_shares`, `directus_flows`, `directus_operations`, `directus_versions.user_created`, `directus_comments.user_created`, `directus_deployment*` | handled automatically |
| **`NO ACTION`** | `directus_files.uploaded_by`, `directus_files.modified_by`, `directus_notifications.sender`, `directus_versions.user_updated`, `directus_comments.user_updated`, `tm_bookmarks_personal.user_created` | **blocks the delete** |

`NO ACTION` is not a silent data loss risk — it is a hard failure. Because
uploaded files are kept by requirement, `directus_files.uploaded_by` still
points at the departing user, and `UsersService.deleteOne` will be rejected by
the database for **any user who has ever uploaded an avatar**. That is nearly
every account that would want deleting, so this is not an edge case; it is the
default path.

The delete-account route must therefore, after `eraseOwnedData` and before
deleting the row, null the five non-owned blocking references:

```sql
UPDATE directus_files        SET uploaded_by  = NULL WHERE uploaded_by  = :id;
UPDATE directus_files        SET modified_by  = NULL WHERE modified_by  = :id;
UPDATE directus_notifications SET sender      = NULL WHERE sender       = :id;
UPDATE directus_versions     SET user_updated = NULL WHERE user_updated = :id;
UPDATE directus_comments     SET user_updated = NULL WHERE user_updated = :id;
```

Idempotent, so re-running a partially-failed deletion is safe. The sixth,
`tm_bookmarks_personal`, resolves itself — `eraseOwnedData` deletes those rows
outright, which is why data erasure must run *before* the row delete rather
than after.

`playlists`, `stacks`, `chat_messages` and `chat_blocks` carry plain `uuid`
ownership columns with **no** foreign key to `directus_users`. This is what
makes keeping `chat_blocks` after account deletion legal: the orphaned rows
reference a user id that no longer exists, and the database does not object.

### Response shape and partial failure

Each deletion group is wrapped independently. The route returns

```json
{ "data": { "deleted": { "playlists": 3, "stacks": 0, ... }, "failed": ["stacks"] } }
```

rather than aborting on the first error. A user who asked to be forgotten
should have as much removed as possible, and the UI can report what remains.

**Account deletion is the exception.** If `UsersService.deleteOne` fails, the
route returns 500 and the client does *not* clear local storage or reload —
the account still exists, and pretending otherwise would strand someone signed
in to an account they believe is gone.

## Client design

```
Account.tsx
  └─ ProfileEditor.tsx  → new tab entry
       └─ SpecialTab.tsx        ← buttons, risk copy, confirmation state
            ├─ ClassicyAlert ×2 (alertType="stop")
            └─ accountApi.ts    ← deleteMyData() / deleteMyAccount()
```

`SpecialTab` is its own file rather than a fifth inline entry in
`ProfileEditor`'s `tabs` array; that array is already ~160 lines of JSX and
this tab carries genuine interaction state.

### Confirmation

Friction scales with severity.

**Delete my data** — one `ClassicyAlert` (`alertType="stop"`), Cancel as the
default button, listing what goes and what stays:

```
(!) This cannot be undone.
    Deletes: profile, settings, playlists, stacks, bookmarks, chat history.
    Keeps: your files, your login.
            [Delete]  ((Cancel))
```

**Delete my account** — the same alert plus a text field. The Delete button
stays disabled until the typed text exactly matches the user's screen name
(falling back to email if no screen name is set):

```
(!) This cannot be undone.
    Your account and everything in it will be permanently removed.
    Type "mrbyrd" to confirm:
    [________________]
            [Delete]  ((Cancel))
```

### Local settings must be followed by a reload

Every app's settings — Feedback, RadioScanner, README, TimeMachine, TV
selections, window positions — persist through the Classicy store into a single
localStorage key, `classicyDesktopState`, alongside `rt911AlertsEnabled` and
the `media-chrome-pref-*` keys.

**Clearing those keys without reloading is a no-op.** The live `ClassicyStore`
holds the same state in memory and writes it straight back on its next
dispatch. The client sequence is therefore strictly ordered:

1. `await` the server wipe
2. `removeItem` each key
3. `window.location.reload()`

A hard reload, not a soft state reset — it also discards the in-memory
`FilesystemSync` tree, which would otherwise re-push itself to a `filesystem`
link the server just nulled.

After **Delete my account** the reload lands on the signed-out desktop, because
the session cookie now points at a user row that no longer exists.

## Scoped-in fix: `CONFIRM_BASE_URL`

`profile-api` hardcodes the email-change landing page to
`https://beta.911realtime.org/?confirm-email=`. Since the apex cutover, that
host 301s to `https://911realtime.org` preserving the query string, so links
still work — by accident of a redirect that will eventually be retired.

Until then, every email-change request mails a `beta.` URL in a message asking
someone to confirm an account change: the exact shape a spam filter and a
cautious teacher both distrust.

Replaced with an env-driven value defaulting to the apex, read inside `handler`
where `env` is in scope:

```js
const confirmBaseUrl = `${env.RT911_APP_URL || "https://911realtime.org"}/?confirm-email=`;
```

A custom variable, deliberately **not** Directus's built-in `PUBLIC_URL` —
that one holds the API's own public URL (`https://api.911realtime.org`), so
reusing it would mail people a confirmation link pointing into the Directus
API rather than the desktop app.

Included here because the new routes live in the same file; deploying either
requires the same new `rt911-api` image.

## Testing

- `accountApi.test.ts` — request shape, typed error mapping (401/403), and that
  a failed account deletion neither clears storage nor reloads.
- `SpecialTab.test.tsx` — the alert appears before any network call; Cancel
  issues no request; the account Delete button stays disabled until the typed
  name matches exactly.
- `ProfileEditor.test.tsx` — the Special tab is present for a signed-in user.

The extension has its own vitest suite at
`packages/directus-extensions/profile-api/src/index.test.mjs`, run in CI by the
`api-test` job, which gates the image build. It stubs the express router and
Directus's context services, then invokes each route with fake `req`/`res`. The
new routes extend that harness with an `ItemsService` stub, a knex-shaped
`database` stub, and an `ops` array recording every mutation **in call order**.

Ordering is the point. `nulls every blocking foreign key BEFORE deleting the
row` asserts index positions rather than mere occurrence, because nulling the
references *after* `deleteOne` would be useless — and that mutation was
confirmed to fail the test.

Manual verification against `api-beta` still runs before release, because no
stub proves what Postgres actually does with a real FK.

**The throwaway account must have an uploaded avatar and at least one row in
every affected collection.** A fresh account with no avatar has nothing
pointing at `directus_files.uploaded_by` and so deletes cleanly even if the
blocking-reference step is missing entirely — the manual test would pass while
the feature is broken for every real user. Verify afterwards that the avatar
file still exists and is still served.

## Consequences

**Orphaned files.** Uploaded files survive by request, so deleting the user row
should leave their avatar and filesystem JSON in `directus_files` — bytes still
on Wasabi, no owner, and no UI that lists them. That is the correct consequence
of the requirement, but it means account deletion is not a complete erasure and
should not be described as GDPR compliance without revisiting it.

Verified: the FK is `NO ACTION`, so files are in no danger of cascading away.
The cost is that the delete is *blocked* until `uploaded_by` is nulled — see
"Deleting the user row requires clearing blocking references first" above.

**Sign-out is automatic.** `directus_sessions.user` cascades, so deleting the
row invalidates every session that account holds server-side. The client's
reload is what makes the browser notice, not what causes it.

**Deployment.** The extension change ships as a new `rt911-api` image built
from `packages/directus-extensions/Dockerfile`, rolled out by ArgoCD from the
`Keeping-History/infra` repo. The frontend ships separately. **The extension
must be deployed before the frontend**, or the Special tab's buttons will call
routes that do not exist yet.
