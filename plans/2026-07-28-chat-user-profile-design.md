# IM Buddies — Full User Profile in the Chat Prompt

**Date:** 2026-07-28 · **Status:** Approved (brainstorm sign-off)
**Depends on:** IM Buddies chat (`plans/2026-07-24-im-buddies-chatbot-design.md`), account
profile editing (`plans/2026-07-16-account-profile-design.md`)

## Goal

A buddy currently knows one thing about the person messaging it: a screen name. Give it
the signed-in user's whole self-reported profile — real name, where they live, what they
do — so it can talk to them as someone it knows rather than as an anonymous stranger.

The mechanism must be self-extending: a profile field added to `directus_users` next
month must be able to reach the prompt without a Go change or a deploy.

## Decisions

| Question | Decision |
|---|---|
| Fields exposed | Everything on the account profile — name, `city`/`state`/`country`, `school_name`, `educator_role`, `grade_levels`, `subjects` — plus any field added later |
| How the buddy uses it | **Background only.** It knows these things; it answers if asked and lets them colour a reply, but never volunteers them and never lists them back |
| Which fields are buddy-visible | A new curator-editable Directus collection, `chat_user_fields` — one row per exposed column. Fail-closed: nothing reaches the prompt without a row |
| Consent | None. Implied by using chat; the account holder is an adult educator whose typed messages already go to the same providers |
| Freshness | Re-read when the `chat` channel is subscribed (plus at connect). Opening IM Buddies picks up an edit made moments earlier in the Account app |
| Address-by name | `first_name` when set, then today's existing chain (`username` → email local part → first+last) |
| Frontend | **No change.** Entirely server-side; no wire-protocol change, so backend hard rule #8 does not apply |

## Why a config collection and not introspection

Three mechanisms were considered for "pick up future fields automatically":

1. A Directus **field group** on `directus_users` — membership, order and choice labels
   all read from `directus_fields`.
2. A **config collection** (`chat_user_fields`) — one row per exposed column. *Chosen.*
3. **Every custom field minus a denylist** — literally zero-touch. *Rejected.*

Option 3 is fail-open in the direction that bites. `directus_fields` on `directus_users`
holds nine rows today, and one of them is `filesystem` — a pointer to the user's Classicy
virtual-filesystem blob on Wasabi. Under a denylist rule that blob would have been pasted
into an LLM system prompt from day one, and every field added afterwards would leak by
default until someone remembered to deny it. This repo has been burned by exactly this
shape before (the `TRANSCRIPT_RADIO_SOURCES` empty-env-var fail-open).

Option 1 was the original recommendation but cannot reach `first_name`/`last_name`:
those are Directus **system** fields and have no `directus_fields` row at all. Referencing
a bare column name sidesteps that.

Option 2 keeps the allowlist explicit and curator-owned. Its one cost — re-typing labels
Directus already knows — is avoided for *values*: the streamer joins
`directus_fields.options->'choices'` for each column, so `high_school` renders as
"High School" and `us_history` as "US History" automatically, for any future select
field, with no config work.

## Schema — `chat_user_fields`

| column | type | notes |
|---|---|---|
| `id` | integer, pk | |
| `field` | string, required | a `directus_users` column name |
| `label` | string, required | how the prompt names it ("school", not "school_name") |
| `sort` | integer | render order |
| `active` | boolean, default true | switch a field off without deleting the row |

Seeded rows, in order: `first_name`, `last_name`, `city`, `state`, `country`,
`school_name`, `educator_role`, `grade_levels`, `subjects`.

Applied by a new `packages/backend/apply-chat-user-fields.mjs`, following the existing
`apply-chat-schema.mjs` / `apply-username-field.mjs` pattern (idempotent, `--apply` gated).
Permissions: **admin only**. This is curator configuration, not user data — no public and
no Teacher read.

## `internal/chat/userprofile.go`

### Loading the field list

`LoadUserFields(ctx, pool) ([]UserField, error)` reads `active = true` rows ordered by
`sort, id`. Called **once at boot** into the existing config holder that already carries
profiles, beacons, phases and schedules — sessions never query for config.

Field names now arrive as *data* and are interpolated into a `SELECT`. Each row is
validated at load and **dropped with a `logger.Warn`** — never fatal, never injected —
unless it passes all three:

1. matches `^[a-z][a-z0-9_]*$`
2. names a real column on `directus_users`, checked against `information_schema.columns`
3. is absent from a hard-coded `neverExpose` set: `password`, `token`, `tfa_secret`,
   `auth_data`, `external_identifier`, `email`, `id`, `role`, `status`, `policies`,
   `filesystem`, `avatar`

The collection is the allowlist; `neverExpose` is a backstop so a mistyped config row
cannot leak a secret. Identifiers are quoted with `pgx.Identifier{}.Sanitize()` regardless
of validation — the regex is a policy check, not the injection defence.

`email` appears in `neverExpose`, which does **not** contradict `db.displayName` still
falling back to the email local part for an address-by name. Those are different paths:
`displayName` derives a screen name from an address the user already sees rendered as
their own name, while `neverExpose` blocks the full address from being stated as a fact
in the prompt.

Choice labels are resolved in the same pass: one query against `directus_fields` for the
`options->'choices'` of each surviving column, cached with the field list.

### Loading a user's values

`LoadUserProfile(ctx, pool, userID string, fields []UserField) (UserProfile, error)`
builds `SELECT "col", … FROM directus_users WHERE id = $1` and renders each value:

- string → trimmed; empty is omitted from the block entirely
- json array → comma-joined
- select-backed value → its choice text, falling back to the raw value

Every rendered value then passes through the existing `Sanitize(v, userFieldMaxRunes)`.
This is not cosmetic. `school_name` and `city` are free text the user types, and they are
about to land in a **system prompt**; `Sanitize` already strips markdown, URLs, control
characters and non-ASCII, and collapses whitespace, which blunts the injection surface and
enforces era-correct typography in one call. The rune cap stops a 5,000-character
`school_name` from swamping the cached prefix.

A profile with no non-empty values is the zero value, and renders nothing.

## Wiring and freshness

- `Session.SetUserProfile(chat.UserProfile)`, alongside the existing `SetUserName`.
- **At connect:** loaded inside the bounded 2-second lookup already wrapping
  `db.LookupSessionUser` in `internal/handler/ws.go`. Failure degrades to name-only and is
  non-fatal, exactly like today's identity lookup — a profile read must never reject a
  connection or stall the shared pool.
- **On chat subscribe:** the `ChannelChat` branch in `ws.go`'s `case "subscribe"` already
  special-cases chat and has `pool` and `r.Context()` in scope. The re-read goes there,
  before `SendChatState()`, under its own bounded context. A failed re-read **keeps the
  previous value** rather than blanking it.
- `handleChatSend` sets `job.UserProfile` beside the existing `job.UserName`.
- `db.displayName` promotes `first_name` to the front of its fallback chain
  (`first_name` → `username` → email local part → `first + last`). Its existing tests
  change with it.

Deliberately **not** re-read per generated reply: the backend guidance is explicit that
unbounded lookups on that path can starve the usenet and weather tick goroutines sharing
the pool.

## Prompt rendering

`ComposeInput` gains `UserProfile`. `persona()` emits, directly after
`whoTheyAreTalkingTo(userName)`:

```
Some things you know about them, the way you would know them about a friend:
- first name: Dave
- last name: Byrd
- city: Columbus
- state: Ohio
- school: Lincoln High School
- role: Teacher
- grade levels: High School
- subjects: US History, Civics
Do not bring these up unprompted and never list them back. Use them only if
the conversation goes there on its own.
```

The block lives in the **`StabilityStable`** segment. That segment is already per-user —
the name is in it — so this adds no new cache fragmentation; it grows the cached prefix by
roughly 60–100 tokens, paid once per conversation rather than per turn.

`whoTheyAreTalkingTo`'s "they are not anyone described in your own background above"
denial is untouched. That line is what stopped a persona written as "Danny's aunt"
greeting every user as Danny, and a richer profile block makes it more load-bearing, not
less.

An empty profile omits the block entirely.

## Testing

Co-located Go tests, per package convention:

- `userprofile_test.go` — the validator drops non-matching, denylisted and nonexistent
  columns; choice-label mapping; json array joining; `Sanitize` applied to free text;
  empty values omitted.
- **Mutation check on the validator.** Removing `neverExpose` must turn a test red. A
  fail-closed guard that no test actually exercises is decoration, and this is the second
  time this codebase has needed that assertion.
- `composer_test.go` — block rendered, ordered by `sort`, omitted when empty, present in
  the *stable* segment (not volatile), the "do not volunteer" instruction intact, and the
  existing denial line preserved.
- `directus_session_test.go` — the `first_name`-first fallback chain, including every
  fallback step.
- `ws_test.go` — chat subscribe re-reads the profile, and survives a nil pool without
  panicking.

## Non-goals

- No opt-out toggle and no consent UI.
- No frontend change of any kind.
- No wire-protocol change.
- No per-message profile refresh.
