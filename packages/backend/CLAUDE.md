# CLAUDE.md — packages/backend

Guidance for AI coding assistants working in this Go service. Read [`SPEC.md`](./SPEC.md) for the *what*, this file for the *how* and the *don't*.

---

## What this package is

A WebSocket streamer that drives a **virtual clock** per client and pushes `media_items` whose `start_date` falls in the current virtual second. Postgres (Directus-owned) is the source of truth; Redis is the per-second hot cache; one goroutine per session manages the clock and one shared `Hub` goroutine fans out 1 Hz ticks.

Module: `classicy/streamer` (see [`go.mod`](./go.mod)).
Entrypoint: [`cmd/server/main.go`](./cmd/server/main.go).
All non-entry code lives under [`internal/`](./internal) and is intentionally not importable from outside this module.

---

## Mental model — read before changing anything

```
            ┌─────────────────────────────┐
            │            Hub              │   one goroutine
            │    time.Ticker(1 * Second)  │
            └──────────────┬──────────────┘
                           │ tickCh (non-blocking, cap 1)
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
   ┌─────────┐        ┌─────────┐        ┌─────────┐
   │Session A│        │Session B│        │Session C│   one goroutine each
   │  vTime  │        │  vTime  │        │  vTime  │   (RunTimePump)
   └────┬────┘        └────┬────┘        └────┬────┘
        │ Redis ZRANGEBYSCORE per second       │
        ▼                                       ▼
   ┌──────────────────────────────────────────────┐
   │            Redis (warmed on boot)            │
   │   HASH media:items   ZSET media:by_start     │
   └──────────────────────────────────────────────┘
```

Each `Session` also runs two more goroutines under the WebSocket handler: a `writePump` (drains `send` channel, sends pings) and the implicit `readPump` (the for-loop in `NewWSHandler`). All four goroutines exit when `Session.Close()` runs (`done` channel close + `Hub.Unregister`).

---

## Hard rules

1. **Never block the Hub.** The hub's tick fan-out is non-blocking (`select { case s.tickCh <- struct{}{}: default: }`). If you change `Session.tickCh` to a blocking send or remove the `default`, a slow client takes down every other session. Don't.
2. **`Session.send_` must never block.** It uses the same non-blocking pattern with a `default` that logs and drops. Do not change to a blocking send "for reliability" — the writePump backpressure is what protects us from a slow socket.
3. **Hold `Session.mu` for the shortest possible window.** Take it, mutate, release, *then* call `send_` or do I/O. Look at `Heartbeat` and `RunTimePump` for the pattern.
4. **Postgres for seek/init, Redis for tick.** `CurrentItems` (overlap window) is called only from the handler's `init` and `seek` paths. The 1 Hz tick path uses `cache.ItemsAt` only. Don't mix them.
5. **The Redis cache is kept in sync via Postgres NOTIFY.** `cache.InstallTriggers` installs an `AFTER INSERT/UPDATE/DELETE` trigger on `media_items` that fires `NOTIFY media_items_changed` with an `{op, id}` payload. `cache.Listen` runs in a dedicated goroutine, applies each change incrementally (`Upsert` / `Forget`), and **resyncs the entire cache against Postgres on every (re)connect** so notifications dropped during a disconnect are recovered. Don't add a parallel "rewarm" path — extend the listener instead.
6. **All times are UTC `time.Time`.** Wire format is RFC3339 (or one of the fallbacks in `parseTime`). Never compare formatted strings; always parse first.
7. **Nullable text columns are `*string` at scan time.** Directus emits `NULL` for empty strings; pgx cannot scan `NULL` into a non-pointer string. Use `derefStr` like `queryItems` already does — don't shortcut to `&it.Field` directly.
8. **No backwards-compat shims.** This service has one consumer (the frontend in `packages/frontend/`). If you change the wire protocol, update the frontend in the same commit; do not add `if msg.Version == "v1"` branches.
   - **The wire is split by direction.** Server→client frames are **binary MessagePack** (`websocket.BinaryMessage`); `send_` encodes via `encodeMsg` (msgpack with `SetCustomStructTag("json")`, so the json tags stay the wire field names and `time.Time` rides the timestamp ext). Client→server frames stay **JSON text** (`json.Unmarshal` in `ws.go`). Don't reintroduce text output (`websocket.TextMessage` / `json.Marshal` on the outbound path), and don't flip inbound to binary — the asymmetry is intentional (the win is the 1 Hz item fan-out; control frames are tiny). See [`docs/websocket-protocol.md`](./docs/websocket-protocol.md).

---

## What good changes look like

- **Small, isolated, follow-the-pattern.** New message types go in the `switch msg.Type` block in `handler/ws.go` and call a single method on `Session`. New session methods follow the `mu.Lock → mutate → mu.Unlock → send_` shape.
- **Tests live next to the code** (`session_test.go`, `cache_test.go`, …) per standard Go conventions. Don't introduce a `tests/` directory. `internal/cache/` already uses `miniredis` for Redis-backed unit tests — copy that pattern for new packages.
- **`slog` everywhere.** Loggers are passed in (`logger *slog.Logger`). Don't import `log`. Use structured keys, not formatted strings: `logger.Info("session joined", "id", s.id)` not `logger.Info(fmt.Sprintf(…))`.

## What bad changes look like

- Adding a third storage backend "in case Redis fails." There is no failure mode here that a cache failure rescues you from — both stores must be up. Document that, don't paper over it.
- Pulling business logic into `cmd/server/main.go`. The entrypoint wires dependencies and starts the server; that's it.
- Putting protocol parsing inside `Session`. Sessions know about virtual time and items; they don't know about JSON envelopes or WebSocket frames. Parsing lives in `handler/`.
- Adding context-aware methods to `Session` "for cancellation." `Session.done` is already the cancellation signal; piping a `context.Context` through every method adds noise without adding capability.

---

## Common tasks

### Add a new client → server message type

1. Add a new case to the `switch msg.Type` block in [`internal/handler/ws.go`](./internal/handler/ws.go).
2. Define an unmarshaling struct if the payload needs more fields than `inMsg` carries (see `filterMsg` for the pattern).
3. Implement a single method on `Session` that takes parsed arguments (not raw bytes).
4. Document the new message in [`docs/websocket-protocol.md`](./docs/websocket-protocol.md) and update the frontend (`packages/frontend/`) in the same PR.

### Add a new server → client message type

1. Build the outbound payload with the existing `outMsg` struct, or extend it.
2. Send via `Session.send_(...)` — never write to `s.send` directly.
3. Document and update the frontend.

### Add a new media format

Formats are just strings (`m3u8`, `mp4`, `html`, `modal`, `news`, `usenet`). Adding a new one requires no backend change unless filtering or schema validation depends on the list — currently neither does. Update the seed script's `select-dropdown` choices in `seed.mjs` if you want it editable in Directus.

> `pager` and `mp3` are **not** formats — each lives in its own table (`pager_items` / `mp3_items`) and is delivered on an opt-in subscription channel (`subscribe`/`unsubscribe`), with parallel `db`/`cache` code (`*ItemsAt`, distinct `pager:*` / `mp3:*` Redis keys, `ListenPager` / `ListenMp3`) and a dedicated server→client frame. pager has its own `PagerItem` model (instant, forward-only single-second snapshot); mp3 **reuses `MediaItem`** (durational, overlap snapshot) and rides `mp3`-typed frames reusing the `items` field. News and HTML are slated to follow the same extract-into-channel pattern — generalise the `Session.subscriptions` set, don't special-case each one.

### Add a new subscription channel (pager-style)

Pager is the reference implementation of an opt-in side channel that lives in its own table. To add another (e.g. `news`, `mp3`, `html`):

1. New table + Directus collection in `seed.mjs`; new `internal/model` struct (or reuse `MediaItem` if the shape matches).
2. Mirror the pager `db` queries (`All*`, `*ByID`, `Current*`) and `cache` files (`*.go` with distinct Redis keys + `*_listen.go` with a distinct NOTIFY channel).
3. Wire warm/trigger/listen into `cmd/server/main.go` as a **non-fatal** block (a side channel must never take down media streaming).
4. Add the channel name as a `session.Channel*` const; the `subscribe`/`unsubscribe` handler cases and `Session.subscriptions` set already generalise — just extend the valid-channel check and the tick/snapshot delivery.
5. Update the frontend `MediaStreamProvider` (ref-counted subscription + frame handling) and the consuming app, in the same PR (hard rule #8).

### Add a new column to `media_items`

1. Add the field to [`internal/model/item.go`](./internal/model/item.go) with a `json:` tag.
2. Add it to the `selectFrom` constant in [`internal/db/postgres.go`](./internal/db/postgres.go) **and** the `rows.Scan(...)` call in `queryItems`. Order matters — keep them aligned.
3. If nullable, scan into a `*string` / `*int` local and `derefStr` it.
4. Update the field list in `seed.mjs` so fresh Directus installs get it.

---

## Project conventions

- **No comments that restate the code.** Comments here explain *why* (e.g. "Numeric fields added individually — bulk endpoint creates strings" in seed.mjs). Don't add `// loops over items` style noise.
- **Import groups.** Stdlib, then this module (`classicy/streamer/...`), then third-party. Existing files follow this — keep it.
- **Error wrapping.** `fmt.Errorf("context: %w", err)`. The top-level handler/main logs and decides whether to continue or exit; intermediate code wraps and returns.
- **Channel buffer sizes are deliberate.** `send` is 256 (handles burst at seek time), `tickCh` is 1 (drop-on-busy), `reg`/`unreg` are 64. Don't increase these without measuring.

---

## When you're not sure

1. Read [`docs/architecture.md`](./docs/architecture.md) — it explains the *why* behind the goroutine layout.
2. Read [`SPEC.md`](./SPEC.md) — it lists the invariants the service must preserve.
3. Ask Boss before:
   - Changing the wire protocol
   - Adding a third storage backend or message broker
   - Introducing a new top-level package alongside `internal/`
   - Renaming exported types
   - Adding any HTTP endpoint beyond `/stream` and `/health`

For everything smaller — a new field, a new message, a new session method — follow the patterns above and ship it.
