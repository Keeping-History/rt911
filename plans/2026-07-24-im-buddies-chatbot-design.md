# IM Buddies — time-gated AI chat backend

**Date:** 2026-07-24
**Status:** Design approved, not yet planned or implemented
**Scope:** Backend only (`packages/backend`) plus Directus schema and one offline ingest pipeline. The Classicy UI is a follow-up project.

---

## What this is

A set of configurable "buddies" — AI personas on a simulated 2001 instant-messaging service — that a signed-in user can chat with while the rt911 desktop's virtual clock sits between **2001-09-11 08:00 ET and 2001-09-12 00:00 ET** (`2001-09-11T12:00:00Z` to `2001-09-12T04:00:00Z`).

Each buddy has a distinct voice, education level, and emotional arc across the day. A buddy knows only what a person could plausibly have known at the user's current virtual time — not what investigators established later. Buddies send scheduled proactive messages and reply live to what the user types. Every message, both directions, is logged to the user's Directus record.

Non-goals for this project: the Classicy chat application, group chats, buddy-to-buddy conversation, voice, and any use of the chat channel outside the 16-hour window.

---

## Decisions

These were settled during design and are not open questions:

| # | Decision | Rationale |
|---|---|---|
| 1 | **Two-way live chat, tightly bounded** | Users type freely and get live LLM replies, with per-user rate limits, short outputs, a strict system prompt, and grounded retrieval. |
| 2 | **Generation runs inside the Go streamer** | One deployable, one WebSocket, one auth path, no extra network hop. The cost is an outbound API dependency and an API key in the streamer. |
| 3 | **Three knowledge tiers with fixed precedence** | Curated public-knowledge timeline (primary) → broadcast transcripts (secondary) → `news_items` (tertiary). |
| 4 | **Beacon-anchored phases carrying prose + numeric dials** | Emotional state is keyed to named story beacons, not repeated wall-clock times. |
| 5 | **Cookie → `directus_sessions` lookup for WebSocket auth** | No frontend change, no new endpoint, no shared secret, no Directus API round-trip. |
| 6 | **Live generation at delivery time, with inbound moderation** | Scheduled messages generate when the clock crosses them, in the user's conversational context. Inbound messages pass a moderation gate that can block a user. |
| 7 | **Static HTML dev page + scripted Go tests** | The browser is the only place the httpOnly session cookie works, so this exercises the real auth path. |
| 8 | **No vector store, no third-party RAG service** | The dominant filter is time, not similarity — see *Knowledge* below. |
| 9 | **No Usenet-derived content** | Unmoderated 2001 Usenet is unreliable and toxic. Every prompt token is authored by the team or drawn from broadcast transcripts and the curated timeline. |

---

## Architecture

New Go package `packages/backend/internal/chat/`, six units:

| Unit | Responsibility | Depends on |
|---|---|---|
| `chat.Registry` | Profile / beacon / phase config loaded from Postgres. Answers "what phase is profile P in at vTime T?" and "which buddies are online at T?" | Postgres (load + NOTIFY reload) |
| `chat.Knowledge` | Three-tier retrieval. `Retrieve(T, channels, query) []Passage`, each passage carrying its tier | Postgres |
| `chat.Composer` | Pure function: (profile, phase, dials, passages, history, clock) → prompt. **No I/O, no network** | none |
| `chat.Generator` | Bounded worker pool. Calls the Anthropic API, applies style post-conditions | Composer, Anthropic API |
| `chat.Guard` | Inbound moderation (allow / block / escalate) and block state | Postgres |
| `chat.Store` | Appends messages to the Directus-owned log tables | Postgres |

`Composer` is pure by design: prompt assembly is the part that will be iterated on most, and purity makes it exhaustively table-testable without a network call.

### Session integration

One new channel constant, `session.ChannelChat = "chat"`, joining the seven at `internal/session/session.go:29`. It follows the existing opt-in `subscribe`/`unsubscribe` pattern.

Two paths reach the generator. **Neither runs inline on the session goroutine.**

```
tick (1 Hz)                          inbound chat_send
    |                                        |
Session: has a subscribed buddy          handler/ws.go parses
crossed its next scheduled beat?         -> Session.ChatSend()
    |                                        |
    +--------------> chat.Guard (local checks first, no network)
                            |
                     enqueue job (non-blocking send, bounded queue)
                            |
                     chat.Generator worker pool   <-- the only blocking I/O
                            |
                     s.send_(chat_message)        <-- rejoins the session
```

The session goroutine only enqueues. Hard rules #1 (never block the Hub) and #2 (`send_` must never block) hold unchanged: a slow Anthropic call cannot stall the Hub, and a full queue drops rather than blocks.

Scheduled beats use a **per-user timer path**, not the shared Redis timeline — live generation means each user's beat carries their own conversational context. `Session` tracks a next-scheduled-beat horizon per subscribed buddy and queries Postgres, closer to how the `usenet` channel works (hard rule #4's documented exception) than to `pager`.

### Latency and degradation

- **Typing indicators are the latency budget, not decoration.** On accepting a job the session immediately sends `chat_typing`; the reply lands 2–8s later. A per-profile `typing_speed` dial sets a floor, so a fast reply is deliberately held back rather than arriving instantly.
- **Queue-full is in-character.** If the worker pool is saturated the buddy sends a canned stall (e.g. `"hang on, phones ringing"`) and the job is dropped. Degradation preserves the illusion instead of breaking it.

### Clock coupling

| Clock event | Chat behavior |
|---|---|
| **Pause** | Scheduled beats stop (free — `RunTimePump` already short-circuits on `s.paused` at `session.go:569`). `Session.ChatSend` **rejects** while paused. A `chat_state` frame tells the UI to disable the input. |
| **Resume** | Beats resume from the current horizon. No backfill of missed beats. |
| **Seek** | Chat state is rebuilt: buddies outside the new vTime's window go offline, and conversation context is re-read from `chat_messages` filtered to `virtual_time <= vTime`. Without this, seeking backward leaves a buddy remembering a conversation that has not happened yet. |
| **Outside the window** | All buddies offline; `chat_send` rejected; `chat_state{enabled:false, reason:"outside_window"}`. |

The server enforces every one of these. The UI disabling its input is good UX; the server refusing is the correctness guarantee.

---

## Data model

Eight Directus collections.

### Configuration

**`chat_profiles`** — `screen_name`, `display_name`, `avatar`, `persona`, `education_level` (select: elementary / middle / high / college / adult), `writing_style` (prose), `style_exemplars` (text — a few sample messages in voice), `location`, `timezone`, `online_from`, `online_until`, `model`, `typing_speed` (chars/sec), `system_prompt_extra`, `active`, `sort`.

**`chat_beacons`** — `key` (`first_impact`, `second_impact`, `pentagon`, `tower2_collapse`, `tower1_collapse`, `ua93`, …), `label`, **`at`**, **`public_at`**, `description`.

`at` is when the event happened; `public_at` is when it became publicly known. The Pentagon was struck at 09:37 but was not on national television for several minutes. **Phases advance on `public_at`** — a buddy's mood cannot change from an event they have not heard about. `at` remains available for the curated tier and for other apps' timelines.

**`chat_phases`** — `profile` (m2o), `from_beacon` (m2o, nullable = start of day), `tone` (prose directive), `sort`, and five dials each 0–100. A phase runs from its beacon's `public_at` until the next phase's beacon.

| Dial | 0 | 100 |
|---|---|---|
| `shock` | Unaffected, normal day | Overwhelmed, barely processing |
| `coherence` | Fragmentary, disjointed, trailing off | Composed, complete thoughts |
| `verbosity` | Single words and fragments | Long multi-sentence messages |
| `typo_rate` | Clean typing | Frequent typos and dropped letters |
| `topic_focus` | Talks only about ordinary life | Talks only about the attacks |

The composer renders dials into prompt language; it does not pass raw numbers to the model.

**`chat_schedules`** — `profile` (m2o), `at_beacon` (m2o) + `offset_seconds` as the **primary** form, `at` (absolute timestamp) as the override, `kind` (static / generated), `text` (for static), `prompt` (for generated), `requires_prior_contact` (bool), `active`.

`requires_prior_contact: true` fires the beat only if the user has already exchanged at least one message with that profile in the current session. It exists so a buddy the user has never spoken to does not open with an intimate reaction to an event, while a buddy mid-conversation can react naturally.

### Knowledge

**`chat_knowledge`** (tier 1, curated) — `public_at`, `until` (nullable: when the item stopped being current or was corrected), `summary` (short, plain), `detail`, **`certainty`** (rumor / reported / confirmed), `topics`, `sensitivity` (normal / handle_with_care / do_not_discuss).

`certainty` exists because early 9/11 reporting was wrong, and that wrongness is the texture of the morning. A buddy saying *"theyre saying it was a small commuter plane"* at 08:52 is more authentic than one saying *"a 767 hit the north tower"*, even though only the second is true.

**`chat_transcript_segments`** (tier 2, broadcast) — `channel` (m2o `tv_channels`, or a slug for radio), `medium` (tv / radio), `start_date`, `end_date`, `text`. Indexed on `start_date`, plus a GIN index on a `tsvector` of `text`.

**`news_items`** (tier 3) — existing collection, used as-is. No schema change.

### Per-user state

**`chat_messages`** — `user` (m2o `directus_users`), `profile` (m2o), `direction` (in / out), `body`, **`virtual_time`**, `created_at`, `kind` (typed / scheduled / generated / static / stall), `moderation` (json), `model`, `tokens_in`, `tokens_out`. Indexed on `(user, profile, virtual_time)`.

Two timestamps because there are genuinely two timelines: where the user was on the 2001 clock, and when they actually typed. Only `virtual_time` can rebuild context after a seek; only `created_at` can support rate limiting and abuse review. Seek and pause break any mapping between them, so neither can be derived from the other.

**`chat_blocks`** — `user` (m2o `directus_users`), `scope` (profile / global), `profile` (nullable), `reason`, `evidence`, `created_at`, `expires` (nullable = permanent).

### Permissions

`chat_messages` and `chat_blocks` are private conversation records. Directus policies **must** scope reads and writes to `$CURRENT_USER`; a misconfiguration leaks one user's conversation to another. This gets an explicit verification step in the implementation plan, not a trusting checkbox.

Configuration and knowledge collections are read-only to the public policy and editable by the admin/teacher policies, matching the existing `tm_bookmarks` pattern.

---

## Authentication

The frontend logs into Directus with `mode: "session"` (`packages/frontend/src/Providers/Auth/authApi.ts:64`), and `rt911-config` sets `SESSION_COOKIE_DOMAIN=".911realtime.org"` with `SameSite=lax`. Every host — `beta`, `api-beta`, `stream-beta` — sits under one registrable domain, so the browser already sends `directus_session_token` on the WebSocket upgrade to `stream-beta` (cross-origin but same-site, which Lax permits).

The streamer therefore:

1. Reads `directus_session_token` from the upgrade request's cookies.
2. Resolves it with `SELECT "user" FROM directus_sessions WHERE token = $1 AND expires > now()` over the existing `pgxpool`.
3. Caches the resulting user UUID on the `Session` for its lifetime.

No frontend change, no new HTTP endpoint, no shared JWT secret, and no dependency on the Directus API (which this repo has a documented history of latency and edge-caching problems with).

**Known coupling:** the streamer reads a Directus-internal table whose schema Directus owns and could change on upgrade. Accepted deliberately. A Directus major-version upgrade must re-verify this query.

An unauthenticated socket may still subscribe to every existing channel; only `chat` requires an identity. Failure to resolve a session yields `chat_state{enabled:false, reason:"not_signed_in"}` and does not affect media streaming.

---

## Knowledge and retrieval

**The dominant filter is time, not similarity.** At virtual time T, what a buddy could know is:

1. The **cumulative tier-1 digest** — every `chat_knowledge` row with `public_at <= T` (and `until` either null or `> T`). Grows monotonically to a few hundred short rows by midnight.
2. The **recent broadcast window** — the last ~15 minutes of `chat_transcript_segments` on the channel(s) the user is watching.
3. **Tier 3** — a `news_items` lookup, used only when tiers 1 and 2 miss.

That is a few thousand tokens and goes directly in the prompt. Passages carry their tier as provenance, so the composer can instruct that tier-1 content may be stated plainly (hedged by `certainty`) while tier-3 content must be paraphrased vaguely.

### Why no vector store

- **The tier-1 digest is append-only.** The digest at 09:15 is a byte-exact prefix of the digest at 09:16 — the clock only moves forward. That is the ideal shape for prefix-match prompt caching. Retrieval would return a different subset each turn and cache nothing.
- **Recall is guaranteed rather than probabilistic.** If a fact is in tier 1 with `public_at <= T`, the model saw it. On this subject a missing or wrong fact is the failure that matters, so determinism beats similarity.
- **Scale does not warrant it.** ~10⁵ transcript cues for the 16-hour window, merged to ~10⁴ segments; 1,082 `news_items` rows on 9/11. Postgres full-text over a corpus already narrowed by `start_date <= T` covers the one case that needs search: a user asking about something specific and older than the recent window.

**Revisit if** the curated tier exceeds ~2,000 rows, or buddies need awareness of the full 9-day corpus rather than the 16-hour window. The first step then is `pgvector` in the existing Postgres — still no new service.

### Data to add, in priority order

1. **SRT → `chat_transcript_segments` ingest.** All 23 `tv_channels` rows already carry a `subtitles` URL to an `.srt` on Wasabi, and `mp3_items` covers radio. This is parsing work, not acquisition, and it is the only source of "what a person could know at T." New pipeline in `packages/tools/video-grabber`.
2. **Curated tier-1 timeline.** ~200–400 authored `chat_knowledge` rows with `certainty` set. Can start at ~40 rows covering the major beats and grow; the fallback chain degrades gracefully when it is thin.
3. **AIM-era language reference + anachronism blocklist.** An authored file of 2001-correct abbreviations (`brb`, `g2g`, `sup`), text emoticons (`:-)`, `:-/`, `<3`), and terms that must never appear (`smh`, `fr`, `ngl`, `bruh`). Enforced mechanically in the post-processor, not only prompted.
4. **Authored per-profile style exemplars.** A few sample messages per profile per phase, stored in `chat_profiles.style_exemplars`.

Explicitly **not** used: `usenet_items`. Unmoderated 2001 Usenet is unreliable and toxic, and `news_items` is a more accurate, professionally curated timeline.

---

## Generation

### Model and parameters

Go SDK `github.com/anthropics/anthropic-sdk-go`. Default `Model: "claude-opus-5"` (plain string — the SDK has no typed constant for it), overridable per profile via `chat_profiles.model`.

- **Thinking stays on at `output_config: {effort: "low"}`.** Do **not** set `thinking: {type: "disabled"}` — on Opus 5 that can leak `<thinking>` tags into the visible response, which in this product means a buddy typing `<thinking>` into an IM window.
- **`max_tokens: 2000`.** Thinking and response text share the cap; a 40-token reply with a tight cap truncates once thinking runs. Brevity is enforced by the prompt and the post-processor, not by the token cap.
- **No `temperature` / `top_p` / `top_k`** — rejected with a 400 on Opus 5. Per-message variety comes from the phase dials and directives, which is the only variance lever available.
- **`stop_reason == "refusal"` is checked before reading `content`.** Opus 5 returns HTTP 200 with empty or partial content on a policy decline.
- **`fallbacks: "default"` with beta header `server-side-fallback-2026-07-01`**, so a false-positive decline is recovered server-side rather than surfacing as a dead buddy. Server-side fallbacks require the beta endpoint, so generation calls go through `client.Beta.Messages.New` with the beta listed in `Betas`, not the plain `client.Messages.New`.
- **Non-streaming.** Replies are short and deliberately delayed behind a typing indicator; streaming adds complexity with no user-visible benefit.

**Cost, at ~8K input tokens (~5.5K cache-read after warmup) and ~350 output per reply:** ≈2.4¢ per reply on Opus 5 ($5/$25 per MTok), so a 30-student class exchanging 40 messages each is ≈$29 per session. Haiku 4.5 ($1/$5) would be ≈0.5¢ and ≈$6. Opus 5 is the default; changing it is a per-profile configuration decision.

### Prompt layout

Render order is `tools` → `system` → `messages`, and caching is a **prefix** match.

| Position | Content | Volatility | `cache_control` |
|---|---|---|---|
| `system` | Persona, education level, writing style, era language rules, output constraints, style exemplars | Stable per profile | **yes** |
| `messages[0]` | Cumulative tier-1 digest, `public_at <= T` | Append-only | **yes** |
| next | Recent broadcast window | Rolls | no |
| next | Conversation history from `chat_messages` | Grows | yes (last turn) |
| last user turn | Phase directive, dials, virtual clock, user's message | Every turn | no |

**The virtual clock must never be interpolated into the system prompt.** It changes every turn and sits at the front of the prefix, so it would invalidate everything downstream — the cache would read zero forever while paying the 1.25× write premium on every request. The clock and the phase directive both belong in the last user turn; putting the phase directive in `system` would mean crossing a beacon invalidates the digest cache.

Opus 5's minimum cacheable prefix is 512 tokens, so even a compact persona block caches. `resp.Usage.CacheReadInputTokens` must be non-zero across turns.

### Output post-processing

A deterministic Go post-processor, not a model call, runs on every generated message: strip markdown, strip non-ASCII and Unicode emoji, strip URLs, collapse whitespace, cap length, and reject anachronistic slang from the blocklist. The requirement is *text and text emoticons only, no special characters, formatting, or colors* — a prompt asks for that; code guarantees it.

---

## Moderation

### Inbound — three outcomes, not two

`Guard.Check` returns `allow`, `block`, or `escalate`.

1. **Local tier, no network:** term list, per-user rate limit, length cap. Zero latency, zero cost, catches the obvious.
2. **Escalation tier:** ambiguous input goes to a cheap classifier call before generation.

The distinction that matters most here is **abuse versus distress**. This is a classroom product about a mass-casualty event. A student writing something raw about the hijackers is processing, not attacking; a student signalling genuine distress needs a response, not a block. `escalate` delivers a gentle in-character deflection, flags the message in `chat_messages.moderation`, and is available for teacher surfacing. Collapsing that case into `block` would be the wrong behavior.

`block` writes a `chat_blocks` row — `scope: "profile"` (that buddy stops responding) or `scope: "global"` (chat disabled), with `expires` for cool-downs or null for permanent — and pushes `chat_state{enabled:false, reason:"blocked"}`.

### Outbound

- Every profile's system prompt carries an in-character refusal for graphic detail, casualty specifics, and any tier-1 row marked `sensitivity: do_not_discuss`.
- The post-processor above is the mechanical backstop.
- Refusals and fallbacks are handled as described under *Generation*.

---

## Wire protocol

Client → server (JSON text, per the existing asymmetry):

| Type | Payload |
|---|---|
| `subscribe` / `unsubscribe` | `{channel: "chat"}` |
| `chat_send` | `{profile, body}` |
| `chat_history` | `{profile, before, limit}` |

Server → client (binary MessagePack):

| Type | Payload |
|---|---|
| `chat_roster` | `{buddies: [{profile, screen_name, display_name, avatar, online}]}` |
| `chat_state` | `{enabled, reason}` — `ok`, `paused`, `outside_window`, `blocked`, `not_signed_in` |
| `chat_presence` | `{profile, online}` |
| `chat_typing` | `{profile}` |
| `chat_message` | `{id, profile, direction, body, virtual_time, kind}` |
| `chat_error` | `{code, message}` |

`chat_state` is pushed on subscribe, pause, resume, seek, block, and window-boundary crossings. It is what the UI binds its input's disabled state to, so "why can't I type" is always answerable rather than inferred.

Documented in `packages/backend/docs/websocket-protocol.md` and shipped alongside the frontend consumer in the same PR — hard rule #8, no version negotiation exists.

---

## Error handling

Chat is a side channel and must never take down media streaming. It is wired into `cmd/server/main.go` as a **non-fatal** block, as the other side channels are.

| Failure | Behavior |
|---|---|
| Anthropic error or timeout | In-character stall message; logged with `slog`; never a raw error to the client |
| Worker queue full | Canned stall, job dropped |
| `stop_reason: "refusal"` (after fallback) | In-character deflect; flagged in `chat_messages.moderation` |
| `chat_messages` write fails | Message still delivers; the logging failure is logged, not fatal |
| `directus_sessions` lookup fails | `chat_state{enabled:false, reason:"not_signed_in"}`; media streaming untouched |
| Anthropic API key absent | The `chat` channel refuses `subscribe`; the streamer boots and serves everything else normally |

---

## Testing

### Interim dev harness

A single self-contained HTML file served by the streamer behind `CHAT_DEV_UI=1`, never enabled in production: buddy list, chat pane, virtual-clock scrubber, and a raw-frame log. The browser is the only place the httpOnly session cookie works, so this exercises the real auth path end to end and is shareable with non-engineers.

### Go tests

Tests live next to the code per the package's existing convention. `Generator` sits behind an interface with a scripted fake — **CI never calls the Anthropic API.**

| Target | Coverage |
|---|---|
| `Composer` | Table-driven over (profile × phase × tier mix); prompt structure, dial rendering, cache-breakpoint placement |
| `Registry` | Beacon → `public_at` → phase resolution, including exact boundaries |
| `Guard` | allow / block / escalate, with distress cases explicit |
| Post-processor | Markdown, Unicode emoji, URLs, and anachronisms all stripped |
| `Session` | Tick enqueues rather than blocks; `chat_state` transitions across pause, resume, seek, and window edges |
| Scenario | Golden transcript walking 08:00 → midnight |

### Explicit verification steps

Two items get their own plan tasks rather than a trusting checkbox:

1. **Directus policies on `chat_messages` and `chat_blocks` actually scope to `$CURRENT_USER`** — verified by attempting a cross-user read with a second account's token.
2. **`resp.Usage.CacheReadInputTokens` is non-zero across consecutive turns** — a zero means a silent cache invalidator crept into the prefix.

---

## Deployment

Standard for this repo: land on `main`, let `.github/workflows/build.yml` build and push the streamer image to GHCR, and let the `Keeping-History/infra` repo's image-tag automation and ArgoCD sync it. Do not `kubectl set image` — `automated.selfHeal: true` reverts imperative edits within seconds.

New configuration the streamer needs:

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Secret in `rt911-secrets`. Absent → chat channel disabled, streamer otherwise normal |
| `CHAT_DEV_UI` | Dev harness gate. Unset in production |
| `CHAT_WORKER_POOL` | Generator concurrency. Default **8** — calls are I/O-bound on the Anthropic API, so this bounds in-flight requests, not CPU |
| `CHAT_QUEUE_SIZE` | Bounded job queue depth. Default **256**, matching the `send` channel buffer convention. Overflow triggers the in-character stall |

Directus schema additions go through `seed.mjs` so fresh installs get them, and are applied to `api-beta` as a schema operation. Per the recorded 2026-07-24 incident, check `pg_stat_activity` for a running `pg_dump` or `COPY` before any Directus schema operation — the daily backup CronJob runs at 09:20 UTC and holds `ACCESS SHARE` on all tables, which will stall a queued `ALTER`.

---

## Follow-up projects

Out of scope here, listed so they are not mistaken for omissions:

1. The Classicy IM application (frontend).
2. Teacher-facing moderation review of `escalate`-flagged messages.
3. Buddy-to-buddy or group conversation.
4. Extending chat beyond the 16-hour window.
