# IM Buddies Plan A — carry-forward findings

Findings raised during Plan A's implementation reviews that were deliberately **not** fixed on
that branch. Recorded here because the review workspace is transient and these matter to the
plans that build on this foundation.

Branch: `feat/im-buddies-plan-a` (`3d4d6345..16caa00c`, 13 commits)

---

## Must be resolved before Plan B ships message history

### 1. Cookie-authenticated identity rides a socket with no origin check — RESOLVED 2026-07-25

Fixed in `internal/handler/origin.go`. `NewOriginAllowlist` gates *identity* on an allowlist of
origins we publish — `https://911realtime.org`, `https://www.911realtime.org`,
`https://beta.911realtime.org`, and `https://keeping-history.github.io` (PR previews) — with
`CHAT_TRUSTED_ORIGINS` appending dev and preview origins so they never ship in production config.
An untrusted origin still connects and streams every other channel anonymously; only the cookie→
identity step is refused, and the refusal is logged because it is otherwise invisible.

**Known scope of the grant:** an `Origin` is scheme+host only, so trusting
`https://keeping-history.github.io` trusts everything that org publishes to GitHub Pages, not just
rt911 PR previews. Accepted deliberately (human decision, 2026-07-25) to let reviewers exercise chat
in a preview.

The original finding, retained for context:

`internal/handler/ws.go` sets `CheckOrigin: func(r *http.Request) bool { return true }`, and Plan A
now attaches a Directus user id to that connection. The reasoning in `internal/db/directus_session.go`
— that `SameSite=lax` protects the cookie — holds against an unrelated origin, but **Lax's boundary is
the site, not the origin.** Other hosts under `911realtime.org` serve archived third-party content;
a script running there is same-site to `stream-beta`, so the browser sends `directus_session_token`
and the streamer accepts the socket as that user.

**Today the exposure is limited**: the chat channel carries only the buddy roster (admin-authored
public config) and presence. Nothing private is reachable.

**It becomes account-level the moment `chat_messages` history rides this channel** — i.e. Plan D.

Do **not** fix by tightening `CheckOrigin` globally: GitHub Pages PR previews dial the production
streamer and would break. The surgical fix is to gate *identity* rather than the connection — honour
the session cookie only when `Origin` is on an allowlist, leaving anonymous media streaming reachable
from anywhere. The allowlist needs a deliberate value (production frontend, local dev, PR previews)
and is therefore a decision, not a mechanical change.

### 2. The chat gate is never re-evaluated when the tick crosses the window boundary

`chat_state` is emitted only from init, seek, pause, and resume. A session running continuously
across `chat.WindowEnd` receives `chat_presence(offline)` for every buddy from `syncChatPresence`
while its last `chat_state` still says `enabled: true` — an internally inconsistent client state.

Harmless in Plan A because no send path exists. It is a hard prerequisite for any plan that accepts
messages. `syncChatPresence` (`internal/session/session.go`) is the natural home.

---

## Do not copy this pattern into production UI

### 3. `chatdev.html` is a dev harness, not a template

The harness was fixed to build rows with `createElement` + `textContent` rather than interpolating
into `innerHTML`. That fix must survive into the real Classicy chat UI: once Plans C and D introduce
AI-generated and user-supplied content, string-interpolating a screen name or message body into
markup is a live XSS path.

---

## Known rough edges, safe to ship

4. **`SendChatRoster`'s split critical section** (`internal/session/session.go`) can, on one specific
   interleaving with `syncChatPresence`, deliver `chat_presence(online)` before `chat_roster(offline)`
   for the same buddy and leave the client settled on the wrong state — the server's `presenceSeen`
   then agrees with itself and never corrects. Window is microseconds and requires a transition on
   that exact tick. Fix by computing the roster and updating `presenceSeen` in one critical section;
   `chat.Roster` is pure, does no I/O, and sorts a handful of elements.

5. **`outMsg.Profile int`** carries the same `omitempty` hazard that `Enabled`/`Online` are `*bool`
   to avoid — a buddy with id `0` would send `chat_presence` with no `profile` field. Unreachable
   while Directus auto-increment ids start at 1.

6. **Profiles are loaded once at boot** with no reload path, so seeding `chat_profiles` requires a
   streamer restart. Worth a line in the deploy runbook.

7. **`sendChatStateIfSubscribed` duplicates `Subscribed()`** — four correct lines; the local form
   keeps the lock discipline visible at the call site.

8. **`syncChatPresence` populates `ScreenName`** into its changed-set but the emitted frame uses only
   `Profile`/`Online`.

9. **`Number(getBigUint64/getBigInt64)`** in the harness loses precision above 2^53. Unreachable with
   current field types.

10. **`internal/db/sources_cache_test.go` is not gofmt-clean.** Pre-existing at the merge base and
    untouched by this branch, but `gofmt -l ./internal/` is therefore not silent repo-wide.

---

## Test coverage gaps accepted on this branch

- **`LookupSessionUser` is untested** — no expiry case, no `ErrNoRows` case, no NULL-user share-link
  case. That is the whole authentication boundary, verified by reading rather than by running.
  This repo has no Postgres fixture and Plan A forbade adding one. The `expires > now()` predicate
  and the NULL-user handling are the two things to re-verify by hand after any Directus upgrade,
  since they read a Directus-internal table whose schema Directus owns.
- **`LoadProfiles`' scan** is likewise unverified — the `*string` nullable handling and the
  `active = 1` integer-boolean convention both match the established `approved = 1` pattern in
  `internal/db/postgres.go`.

---

## Operational state

**The Directus collections are APPLIED to api-beta** (2026-07-25 00:57Z) — all nine tables with the
expected column counts (`chat_profiles` 21, `chat_messages` 12, `chat_blocks` 8) and all seven
indexes. Verified via `information_schema`.

They were applied with `packages/backend/apply-chat-schema.mjs`, **not** `seed.mjs`. Never use
`seed.mjs` against a live instance to add a collection: its top level runs `createCollections` and
then `importSources`, `importMediaItems`, `importMp3Items`, `importNewsItems`, and `importPagerItems`
(seed.mjs:1180-1197), bulk-loading local JSON into the target database. The apply script shares its
collection definitions with the seed via `packages/backend/chat-collections.mjs` so the two cannot
drift; it is dry-run by default and needs `--apply` to mutate anything.

**No Directus permissions were granted, and none are needed for Plan A.** The streamer reads
`chat_profiles` over its own `pgxpool`, bypassing the Directus permission layer entirely, and the
frontend receives the roster over the WebSocket rather than REST. Newly created Directus collections
default to no access for any policy, so `chat_messages` and `chat_blocks` are currently
administrator-only — the correct failure mode.

**Plan D must grant and then verify** `chat_messages` / `chat_blocks` read+create scoped to
`{"user": {"_eq": "$CURRENT_USER"}}`, and prove the scoping holds with a two-account cross-read
probe. A policy misconfiguration there leaks one student's conversation to another, and no test in
any plan would catch it.

**No profiles are seeded**, so the live behaviour today is: boot logs a warning, every session gets
an empty roster, and the `chat` channel is subscribable but empty. Profiles load once at boot with
no reload path, so seeding rows requires a streamer restart.

`chat_profiles.sort` is `NOT NULL DEFAULT 0` — a deliberate change from the original plan, because a
nullable `sort` mapped to Go's zero value would sort an unset buddy *first* while the query's
`NULLS LAST` implied last.

Until the collections exist and at least one profile row is seeded, the shipped behaviour is: boot
logs a warning, every session gets an empty roster, and the `chat` channel is subscribable but empty.
