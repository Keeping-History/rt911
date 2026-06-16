# SPEC — rt911 streamer

Functional specification. This document describes **what** the streamer does and **why**; implementation details live in the per-component docs under [`docs/`](./docs).

---

## 1. Purpose

Replay historical media-on-a-schedule (TV broadcasts, news entries, pager traffic, usenet posts, modals) to web clients **as if it were happening live** at a virtual point in time chosen by each client.

The frontend at [911realtime.org](https://911realtime.org) lets users pick any moment — `2001-09-11T08:46:00Z` is the canonical example — and watch the day unfold in real time. The streamer is the service that delivers items at the right virtual second.

---

## 2. Vocabulary

| Term            | Meaning                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| Virtual time    | A `time.Time` chosen by the client; the streamer ticks it at 1 Hz.      |
| Wall time       | The actual current moment. Equals 1 tick per second of virtual time.    |
| Media item      | A row in `media_items`. Has a `start_date`, `end_date`, `format`, `url`. |
| Pager item      | A row in `pager_items`. An instant pager message; its own table/cache.  |
| Source          | A row in `sources` (TV network, news outlet, …).                        |
| Format          | One of `m3u8`, `mp4`, `mp3`, `html`, `modal`, `news`, `usenet`.          |
| Channel         | An opt-in delivery stream a session subscribes to. Currently `pager`.   |
| Session         | One WebSocket connection. Holds the virtual clock, a format filter, and channel subscriptions. |
| Tick            | A 1 Hz signal that advances virtual time by exactly one second.        |

---

## 3. Functional requirements

### 3.1 Connection lifecycle

- Clients connect to `ws://host/stream`.
- A connection is upgraded to a WebSocket and a new `Session` is created and registered with the `Hub`.
- The session has no virtual time until the client sends an `init` message — ticks before `init` are a no-op.
- The session ends when the WebSocket closes (read error, write error, or read deadline expiry).

### 3.2 Initialisation

- On receipt of `{"type":"init", "time":"<RFC3339>"}`, the streamer:
  1. Parses the timestamp (RFC3339 plus three permissive fallbacks).
  2. Queries Postgres for **all items overlapping that instant** using `db.CurrentItems`. This includes "instant" items (where `start_date = end_date` or `calc_duration = 0`) within a 5-minute lookback, so a pager message sent 30 seconds before the chosen start time still appears.
  3. Sets the session's virtual time to the parsed value, clears pause state.
  4. Sends `{"type":"init_ack", "time":"…", "items":[…]}`.

- If the timestamp is malformed, the streamer sends `{"type":"error","message":"invalid time: …"}` and leaves session state untouched.

### 3.3 Per-second delivery

- Every wall-clock second, the `Hub` ticks every registered session.
- For each session, the `RunTimePump`:
  1. Skips if paused or if virtual time is zero (the session has received no `init`).
  2. Advances virtual time by 1 second.
  3. Looks up items whose `start_date` falls in exactly that second via `cache.ItemsAt` (Redis `ZRANGEBYSCORE`).
  4. Applies the session's format filter.
  5. If any items survive the filter, sends `{"type":"items", "time":"…", "items":[…]}`.

- Seconds with zero items produce no frame. Clients infer time progression from their own clock or from heartbeat acks; the streamer does not send empty frames.

### 3.4 Seeking

- On `{"type":"seek","time":"<RFC3339>"}` the streamer behaves like `init` except:
  - It does not reset the pause state.
  - It emits `{"type":"seek_ack", "time":"…", "items":[…]}` instead of `init_ack`.

### 3.5 Pausing / resuming

- `{"type":"pause"}` freezes the virtual clock. Ticks are still received but `RunTimePump` skips them. Replies `{"type":"pause_ack"}`.
- `{"type":"resume"}` unfreezes. Replies `{"type":"resume_ack"}`.

### 3.6 Heartbeats and drift correction

- Clients periodically send `{"type":"heartbeat","time":"<their virtual now>"}`.
- If the absolute difference between client virtual time and server virtual time exceeds **3 seconds**, the server adopts the client's value (client wins).
- Replies `{"type":"heartbeat_ack","time":"<server's vTime>"}` so the client knows the authoritative value.

### 3.7 Format filtering

- `{"type":"filter","formats":["mp4","news"]}` whitelists exactly those formats for that session.
- Subsequent `init_ack`, `seek_ack`, and `items` payloads contain only items whose `format` field is in the whitelist.
- `formats: []` or `formats: null` removes the filter (all formats delivered).
- Replies `{"type":"filter_ack"}`.

### 3.8 Pager channel (subscribe / unsubscribe)

- Pager messages live in their own `pager_items` table with a dedicated Redis cache
  (`pager:items` / `pager:by_start`) and NOTIFY pipeline (`pager_items_changed`). They are
  **opt-in**: a session receives no pager items until it subscribes.
- `{"type":"subscribe","channel":"pager"}` opts the session in and replies
  `{"type":"subscribe_ack","channel":"pager"}`. If the session already has a virtual time, the
  server immediately delivers a snapshot — the 5-minute pager lookback at the current virtual
  time — as a `pager` frame.
- While subscribed, each tick that produces ≥ 1 pager item (via `cache.PagerItemsAt`, Redis-only
  on the tick path) sends `{"type":"pager","time":"…","pager":[…]}`. Empty seconds send nothing.
- `init` and `seek` additionally deliver a pager snapshot when the session is subscribed.
- `{"type":"unsubscribe","channel":"pager"}` stops delivery and replies
  `{"type":"unsubscribe_ack","channel":"pager"}`.
- `"pager"` is currently the only valid channel; any other value yields an `error`. Subscriptions
  are per-connection and not remembered across reconnects. (News, MP3, and HTML are planned to
  follow the same extract-into-channel pattern.)
- Pager init is **best-effort**: if `pager_items` is missing or the pager cache cannot be warmed
  at boot, the streamer logs a warning, disables the pager channel, and continues serving media.

### 3.9 Errors

- Malformed JSON, unknown message types, and unparseable timestamps are reported as `{"type":"error","message":"…"}`. They never terminate the session — the client may correct course and try again.

### 3.10 Cache sync with Postgres

- At boot, the streamer installs a Postgres trigger on `media_items` that fires `NOTIFY media_items_changed` with `{op, id}` for every INSERT, UPDATE, and DELETE.
- A dedicated listener goroutine (`cache.Listen`) consumes notifications and applies the change to Redis: INSERT/UPDATE re-fetches the row and `HSET`/`ZADD`s it; DELETE (and approval-revoked UPDATE) `HDEL`/`ZREM`s it.
- The listener reconnects with exponential backoff (1s → 30s cap). Every successful (re)connect runs a full resync — load all approved rows from Postgres, prune cache entries that no longer exist, upsert the rest. This guarantees notifications dropped during a disconnect are recovered.
- Propagation latency from a Postgres commit to a cached value is bounded by NOTIFY delivery + one round-trip pgx + one Redis pipeline — typically under 50 ms.
- `pager_items` has an identical, independent pipeline: `cache.InstallPagerTriggers` /
  `cache.ListenPager` keep `pager:items` / `pager:by_start` in sync via the `pager_items_changed`
  channel. The two listeners run as separate goroutines and never touch each other's keyspace.

### 3.11 Health

- `GET /health` returns `200 OK` unconditionally as long as the HTTP server is running. Used by Docker and Kubernetes liveness probes. It does **not** check Redis or Postgres reachability — those are checked once at boot and then assumed; if a downstream goes away, the streamer logs and continues serving until it cannot.

---

## 4. Non-functional requirements

### 4.1 Latency budget

- The 1 Hz tick must reach every session within < 100 ms wall time after the second boundary. The non-blocking fan-out in `Hub.Run` exists to enforce this — slow sessions are skipped, not waited for.
- A `Session.send` channel is buffered to 256 messages so a normal burst at seek time does not stall the producer. Beyond 256 backlogged messages, sends are dropped with a warning log.

### 4.2 Concurrency safety

- The `Hub.sessions` map is protected by `sync.RWMutex`. Reads (tick fan-out) take the read lock; mutations (register/unregister) take the write lock.
- `Session` state (`virtualTime`, `paused`, `formatFilter`) is protected by `sync.Mutex`. The lock is held only during read-modify-write windows — never across I/O.
- `Session.Close` is idempotent (`sync.Once`).

### 4.3 Memory

- The Redis warm caches every approved `media_item` in memory. With ~6M usenet posts the working set is significant — the streamer is designed to share a single Redis with anything else that needs the same data, not to be the sole owner. Tune `maxmemory-policy` upstream if you cap Redis.

### 4.4 Backpressure

- Slow client → `send` channel fills → message drop with `"send buffer full, dropping message"` log.
- Slow client → write deadline exceeded → `writePump` calls `Session.Close()` → all four goroutines exit.
- Slow client → pong missing → read deadline exceeded → `readPump` exits → `Session.Close()`.

The session ends in all three cases; the streamer does not attempt to reconnect or buffer for later.

---

## 5. Invariants

These hold at all times. Any change that violates one of these needs explicit discussion before it ships.

1. **One goroutine per concern.** Hub (1), per-session writePump (1), per-session timePump (1), per-session readPump (1, the for-loop in the handler). No goroutine pools, no work queues.
2. **Postgres is authoritative.** Redis can be flushed and rewarmed from Postgres at boot. Postgres is never written to by this service.
3. **The Redis cache is keyed by `start_date` Unix seconds.** This is the contract that makes `cache.ItemsAt` an O(log N) operation. Don't add a second key scheme.
4. **Virtual time only moves forward via ticks.** Seek and init replace it wholesale; heartbeat may rewind it if the client drifts. Nothing else mutates `Session.virtualTime`.
5. **Filtering is server-side.** Clients never receive items they have excluded. The whole point of the filter is to keep mobile clients from paying for bytes they will discard.

---

## 6. Out of scope

These are explicit non-goals. Don't add them without revisiting the spec.

- **User accounts / authentication.** The service is read-only and trusts every connection. Auth, if needed, lives at the edge (an ingress, a CDN).
- **Multi-region replication.** One streamer per region; no shared state between them. Sessions are not portable.
- **Persistence of session state.** A reconnecting client must `init` again. We do not remember pauses, filters, or virtual times across disconnects.
- **Real (non-historical) live streams.** The streamer replays a finite archive. It is not a transport for ongoing broadcasts.
