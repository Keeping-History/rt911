# Architecture

How the rt911 streamer is built, why it's built that way, and the lifecycle of a single client session from connect to close.

---

## 1. Process model

The streamer is a single Go binary. On startup it:

1. Opens a `pgxpool.Pool` to Postgres and verifies connectivity with `Ping` (15 s timeout).
2. Opens a `*redis.Client` to Redis and runs `cache.WarmCache`. If the Redis `ZSET` already has members, the warm is skipped. Otherwise every approved row in `media_items` is loaded and pipelined into Redis.
3. Constructs a `session.Hub` and starts its `Run` loop in a goroutine.
4. Registers `/stream` (WebSocket) and `/health` (HTTP 200) on a `http.ServeMux` and calls `http.ListenAndServe`.

There is no graceful shutdown hook. Sending `SIGINT` / `SIGTERM` exits the process; in-flight WebSocket connections drop. This is intentional — the service is idempotent on restart and clients reconnect.

---

## 2. Goroutines

```mermaid
flowchart TB
    M[main goroutine<br/>http.ListenAndServe]
    H[Hub.Run<br/>1 Hz time.Ticker<br/>fan-out via tickCh]
    M --> H
    M -->|per connection| RP[readPump<br/>handler/ws.go for-loop]
    M -->|per connection| WP[writePump<br/>handler/ws.go goroutine]
    M -->|per connection| TP[RunTimePump<br/>session/session.go goroutine]
    H -.tick.-> TP
    TP -.send_.-> WP
    RP -.session methods.-> TP
```

At steady state with `N` connected clients there are `1 + 3*N + 1` goroutines — one main, one Hub, three per session, and Go's runtime housekeeping. The Hub's tick fan-out is non-blocking, so a stuck session cannot prevent ticks from reaching its siblings.

### Goroutine inventory

| Goroutine        | Lives in                       | Started by                              | Stopped by                                  |
| ---------------- | ------------------------------ | --------------------------------------- | ------------------------------------------- |
| `main`           | `cmd/server/main.go`           | The process                             | `os.Exit` or `http.ListenAndServe` return    |
| `Hub.Run`        | `internal/session/hub.go`      | `main` after wiring                     | Never — runs until process exit              |
| `readPump`       | `internal/handler/ws.go`       | `NewWSHandler` per connection           | WebSocket read error / read deadline         |
| `writePump`      | `internal/handler/ws.go`       | `NewWSHandler` per connection           | `Session.Done()` close or write error        |
| `RunTimePump`    | `internal/session/session.go`  | `NewWSHandler` per connection           | `Session.Done()` close                       |

When any of the three per-session goroutines decides the session is over, it calls `Session.Close()`. That call is idempotent (`sync.Once`) and:

1. Closes `Session.done`, which all three goroutines select on.
2. Sends the session to `Hub.unreg`, which removes it from `Hub.sessions`.

---

## 3. Data flow — three paths

The streamer serves three different read paths against different stores.

```mermaid
flowchart LR
    subgraph CLIENT[Client]
        WS[WebSocket]
    end
    subgraph SVC[streamer]
        H[handler]
        S[Session]
        TP[RunTimePump]
    end
    subgraph PG[PostgreSQL]
        MI[(media_items)]
    end
    subgraph RD[Redis]
        Z[ZSET media:by_start]
        HM[HASH media:items]
    end

    WS -- init / seek --> H
    H -- CurrentItems --> MI
    MI -- rows --> H
    H -- "items[]" --> S
    S -- "ack" --> WS

    TP -- ItemsAt --> Z
    Z -- ids --> TP
    TP -- HMGET --> HM
    HM -- items --> TP
    TP -- "items frame" --> WS
```

**Path A — `init` and `seek` (slow, accurate, overlap-aware).** Hits Postgres because the result set is "everything active right now," which requires range arithmetic the cache cannot do efficiently. Includes a 5-minute lookback for instant items so freshly-fired pager messages still appear when you tune in.

**Path B — per-second tick (fast, exact-match).** Hits Redis because we want exactly the items whose `start_date` falls in this one second. The `ZRANGEBYSCORE` is `O(log N + M)` where M is items in that second (usually zero or one).

**Path C — cache warm (boot-time only).** Pulls everything from Postgres and pipelines it into Redis. Returns immediately if the cache is already populated.

These paths are intentionally separate. Don't try to make the tick path go through Postgres "for consistency" — that ruins the latency budget. Don't try to make `seek` go through Redis — Redis doesn't have efficient range overlap queries.

---

## 4. Lifecycle of a session

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant H as handler.NewWSHandler
    participant S as Session
    participant Hub as Hub
    participant PG as Postgres
    participant R as Redis

    C->>H: GET /stream (Upgrade)
    H->>S: session.NewSession(...)
    H->>Hub: Register(s)
    Hub-->>Hub: sessions[id] = s
    H->>S: start writePump (go)
    H->>S: start RunTimePump (go)
    H->>H: enter readPump for-loop

    C->>H: {"type":"init","time":"2001-09-11T08:46:00Z"}
    H->>PG: db.CurrentItems(t)
    PG-->>H: items[]
    H->>S: s.Init(t, items)
    S->>S: virtualTime = t; paused = false
    S->>C: {"type":"init_ack","items":[...]}

    loop every wall-clock second
        Hub->>S: tickCh <- struct{}{}
        S->>S: virtualTime += 1s
        S->>R: cache.ItemsAt(virtualTime)
        R-->>S: items[]
        alt items present and pass filter
            S->>C: {"type":"items","time":"...","items":[...]}
        end
    end

    C->>H: close / read error
    H->>S: s.Close()
    S->>Hub: Unregister(s)
    Hub-->>Hub: delete(sessions, id)
```

---

## 5. Component boundaries

```mermaid
flowchart TB
    main[cmd/server/main.go<br/>process entrypoint]
    handler[internal/handler<br/>WS upgrade + dispatch]
    session[internal/session<br/>Hub + Session]
    cache[internal/cache<br/>Redis warm + lookup]
    db[internal/db<br/>pgx queries]
    model[internal/model<br/>MediaItem]

    main --> handler
    main --> session
    main --> cache
    main --> db

    handler --> session
    handler --> db
    handler --> model

    session --> cache
    session --> model

    cache --> db
    cache --> model

    db --> model
```

**Allowed import direction.** `model` imports nothing internal; everything else may import `model`. `db` and `cache` may not depend on `session` or `handler`. `handler` depends on `session`, `db`, `cache`, and `model` because it wires them together per connection.

If a new dependency arrow would point upward in this diagram (e.g. `cache` importing `session`), redesign. It usually means the responsibility belongs in `handler` or `main`.

---

## 6. Concurrency choices, justified

### Why a hub at all?

We could let each session run its own `time.Ticker`. We don't, because:

1. With N sessions you'd have N tickers and N wakeups per second. The hub model has exactly one wakeup per second regardless of N.
2. Sessions stay coupled in *phase* — they all advance virtual time on the same wall-clock boundary, so an observer comparing two browser tabs sees them in sync.
3. The fan-out cost is negligible compared to the cost of a `time.Ticker` per goroutine.

### Why non-blocking fan-out?

If `tickCh` were a blocking send, the hub would stall on the slowest session. Every other client would also be late. The `select { case s.tickCh <- struct{}{}: default: }` pattern means a session that hasn't consumed its previous tick simply doesn't get this one — it'll catch up on the next.

This *can* cause a slow session to fall behind in virtual time. That's acceptable: heartbeat-driven drift correction (Section 3.6 in `SPEC.md`) snaps it back when the client notices.

### Why is `Session.send` channel-based instead of a slice + mutex?

Channels give us:
- `select` interaction with `done` (the cancellation signal),
- buffered backpressure for free,
- a clean handoff between the producer (any session method) and the consumer (writePump), with no shared mutable state.

The cost is a hard upper bound on queued messages (256) and a non-blocking drop policy when the bound is reached. That trade-off is the right one for a realtime stream — old messages are useless if delivered late.

### Why is `Hub.sessions` a map instead of a slice?

Tick fan-out is read-mostly, so the cost is range-iteration regardless. The map shape makes register/unregister O(1) and gives session-ID lookups for free.

---

## 7. Configuration surface

Three environment variables, all with sensible defaults:

| Variable       | Default                                                       | Used by          |
| -------------- | ------------------------------------------------------------- | ---------------- |
| `DATABASE_URL` | `postgres://directus:directus@localhost:5432/directus`        | `db.Connect`     |
| `REDIS_URL`    | `redis://localhost:6379`                                      | `cache.Connect`  |
| `LISTEN_ADDR`  | `:8080`                                                       | `http.ListenAndServe` |

See [`configuration.md`](./configuration.md) for the full envelope, including Docker / compose interplay.

---

## 8. Failure modes

### Postgres unreachable at boot

`db.Connect` returns an error. `main` logs `"database connection failed"` and exits with status 1. The container restarts on next supervisor cycle.

### Redis unreachable at boot

`cache.Connect` falls back to `&goredis.Options{Addr: "localhost:6379"}` if the URL fails to parse. It does **not** ping. The first `WarmCache` call will fail when `ZCARD` errors, and `main` exits 1.

### Postgres dies after boot

`db.CurrentItems` fails inside the handler. The session receives `{"type":"error","message":"internal error"}` and continues. Subsequent ticks continue to attempt Redis lookups (which still work because the cache is in memory at Redis side). `pgxpool` reconnects internally on the next query.

The NOTIFY listener's dedicated pgx connection also drops. The listener retries with exponential backoff (1s → 30s) and, on every successful reconnect, performs a full cache resync against Postgres — so any changes that occurred while disconnected are recovered.

### Redis dies after boot

The per-second tick path logs `"cache lookup failed"` and skips delivery for that second. New sessions can still `init` and `seek` because those hit Postgres directly.

### Slow client

`send` channel fills past 256, drops messages with a warning. If the write deadline (10 s) is exceeded, `writePump` closes the connection. If the read deadline (120 s) is exceeded, `readPump` exits.

### Crashing session

Go panics are not caught. A panic in any goroutine takes down the whole process. We deliberately do not add `recover()` — surfacing crashes loudly is more valuable than soldiering on with corrupted state.

---

## 9. Boot order

```mermaid
sequenceDiagram
    participant M as main
    participant PG as Postgres
    participant R as Redis
    participant L as cache.Listen (goroutine)
    participant H as Hub.Run (goroutine)
    participant S as HTTP server

    M->>PG: db.Connect (pgxpool + Ping, 15s timeout)
    M->>R: cache.Connect (URL parse, no ping)
    M->>PG: cache.InstallTriggers (CREATE FN + TRIGGER)
    M->>PG: cache.WarmCache (skip if ZCARD>0 else load)
    M->>L: go cache.Listen(ctx, dsn, ...)
    L->>PG: pgx.Connect (dedicated, for LISTEN)
    L->>PG: LISTEN media_items_changed
    L->>PG: resync (load+diff+upsert)
    M->>H: go hub.Run
    M->>S: http.ListenAndServe :8080
```

The listener resyncs on attach even on the first run. This is redundant with `WarmCache` at boot — both pull the same rows — but the cost is one extra `SELECT`+pipeline at startup and the simplification (no first-run special case) is worth it.
