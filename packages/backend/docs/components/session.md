# `internal/session`

The state machine that drives per-client behaviour, plus the hub that fans the global 1 Hz tick to every connected client. This is the package where most of the "interesting" logic lives.

Sources:
- [`internal/session/hub.go`](../../internal/session/hub.go)
- [`internal/session/session.go`](../../internal/session/session.go)

---

## Two types

```go
type Hub struct { /* unexported */ }
type Session struct { /* unexported */ }
```

`Hub` is a singleton (one per process). `Session` is per-WebSocket-connection. The hub holds a map of sessions and routes ticks to them.

---

## `Hub` — global tick fan-out

### Construction and lifecycle

```go
func NewHub(logger *slog.Logger) *Hub
func (h *Hub) Run()
func (h *Hub) Register(s *Session)
func (h *Hub) Unregister(s *Session)
```

`NewHub` allocates internal state. `Run` is the blocking main loop — call it once in a dedicated goroutine from `main`. `Register` and `Unregister` are non-blocking channel sends to the loop.

```mermaid
flowchart TB
    Ticker[time.Ticker(1s)]
    Loop[Hub.Run<br/>select]
    Tick[fan-out to every session]
    Reg[register: sessions[id] = s]
    Unreg[unregister: delete sessions[id]]

    Ticker --> Loop
    Loop --> Tick
    Loop --> Reg
    Loop --> Unreg
```

### Fields

```go
type Hub struct {
    mu       sync.RWMutex
    sessions map[string]*Session
    reg      chan *Session     // buffered 64
    unreg    chan *Session     // buffered 64
    logger   *slog.Logger
}
```

- `mu` is `RWMutex` because the tick fan-out is read-mostly. Reads (every second) take the read lock; mutations (joins/leaves) take the write lock.
- `reg` and `unreg` are buffered to 64 to handle bursts (e.g. a process restart that drops all clients at once and they all reconnect).

### The tick fan-out — the key correctness detail

```go
case <-ticker.C:
    h.mu.RLock()
    for _, s := range h.sessions {
        select {
        case s.tickCh <- struct{}{}:
        default:
        }
    }
    h.mu.RUnlock()
```

The `default` branch on the inner `select` is load-bearing. Without it, a session whose `RunTimePump` is slow (Redis hiccup, GC pause, anything) blocks the hub, the hub misses its next tick, and every session falls behind by a second.

With the `default` branch, a busy session simply doesn't get this tick. Its virtual time falls behind by one second. The next time it's free, it picks up the next tick. Drift accumulates only if Redis is slow continuously, and heartbeats correct that.

The `tickCh` has capacity `1`. A pending tick still sitting in the channel acts as a "tick is due" flag. Two ticks within a session's RunTimePump cycle collapse into one — no work is lost; the session just sees fewer ticks than the hub sent.

### Register / unregister flow

```go
case s := <-h.reg:
    h.mu.Lock()
    h.sessions[s.id] = s
    total := len(h.sessions)
    h.mu.Unlock()
    h.logger.Info("session joined", "id", s.id, "total", total)
```

Logged on the way in and out so operators can grep for session lifetimes. Total count is a free observability signal.

---

## `Session` — per-client state machine

### Fields

```go
type Session struct {
    id     string         // random 64-bit hex
    hub    *Hub
    rdb    *goredis.Client
    logger *slog.Logger

    mu           sync.Mutex
    virtualTime  time.Time            // protected by mu
    paused       bool                 // protected by mu
    formatFilter map[string]struct{}  // protected by mu; nil = no filter

    send      chan []byte             // buffered 256
    tickCh    chan struct{}           // buffered 1 (hub fan-out flag)
    done      chan struct{}           // closed on Close
    closeOnce sync.Once
}
```

### The mutex discipline

`mu` protects exactly three fields: `virtualTime`, `paused`, `formatFilter`. The protocol for every session method that touches them:

1. Take the lock.
2. Mutate the fields.
3. Take a copy of any value you'll need outside the lock.
4. Release the lock.
5. *Then* call `send_(...)` or any other method that could itself touch the lock.

Look at `Heartbeat` for the canonical example:

```go
func (s *Session) Heartbeat(clientTime time.Time) {
    s.mu.Lock()
    if drift := abs(clientTime.Sub(s.virtualTime)); drift > driftThresh {
        s.virtualTime = clientTime
    }
    t := s.virtualTime    // snapshot to use outside lock
    s.mu.Unlock()

    s.send_(outMsg{Type: "heartbeat_ack", Time: t.Format(time.RFC3339)})
}
```

`send_` does not take `s.mu`, but it does take the channel send path which could in principle block; never hold a mutex across a potentially-blocking call.

### The channels

- **`send`** — outbound message queue, drained by `writePump`. Buffered 256. Producer is `send_`; consumer is the handler's `writePump` goroutine. Drop-on-full policy.
- **`tickCh`** — incoming tick signal, sent by the hub. Buffered 1. Consumer is `RunTimePump`. Drop-on-full policy at the hub end.
- **`done`** — cancellation signal. Closed exactly once by `Close()`. Selected on by `writePump`, `RunTimePump`, and `send_`.

### `Done` and `Close`

```go
func (s *Session) Done() <-chan struct{} { return s.done }

func (s *Session) Close() {
    s.closeOnce.Do(func() {
        close(s.done)
        s.hub.Unregister(s)
    })
}
```

`Done()` is the cancellation primitive. `Close()` is idempotent. Multiple goroutines can call `Close()` (and they do — `writePump` does it on write error, `readPump` does it as a `defer`, `RunTimePump` doesn't itself but observes `done`); the first wins and the rest are no-ops.

Closing `done` triggers `writePump` and `RunTimePump` to return from their selects. Unregistering from the hub removes the session from the tick fan-out — any in-flight tick the hub already sent before unregister will sit in `tickCh` until the pump returns, but that's harmless (and unreachable since the pump observes `done` first).

### Methods

```go
func (s *Session) Init(t time.Time, items []model.MediaItem)
func (s *Session) Seek(t time.Time, items []model.MediaItem)
func (s *Session) Pause()
func (s *Session) Resume()
func (s *Session) Heartbeat(clientTime time.Time)
func (s *Session) SetFormatFilter(formats []string)
func (s *Session) SendError(msg string)
func (s *Session) RunTimePump()
```

Each method follows the lock-mutate-snapshot-unlock-send pattern. None of them do I/O (except `RunTimePump`, which is its own goroutine).

#### `Init`

Sets `virtualTime = t`, clears `paused`, sends `init_ack` with the filtered items. The items are computed by the handler from `db.CurrentItems` and passed in — the session never queries Postgres directly.

#### `Seek`

Like `Init` except it does not reset `paused`. The user might be paused for a reason and we shouldn't change that under their feet.

#### `Pause` / `Resume`

Single-field mutations. Each sends a corresponding `_ack`.

#### `Heartbeat`

Drift correction. If `|clientTime - virtualTime| > driftThresh` (3 s), the session adopts the client's value. This is a deliberate "client wins on disagreement" policy — the client is the source of truth for *the user's perception of time*, and snapping virtual time to match prevents UI jumps.

The reply's `time` is always the server's virtualTime *after* the (possibly applied) correction. So the client can synchronise to it on every heartbeat regardless of whether a snap happened.

#### `SetFormatFilter`

Builds a `map[string]struct{}` from the incoming slice (so subsequent `applyFormatFilter` lookups are O(1)). `nil` or empty slice clears the filter.

```go
func (s *Session) applyFormatFilter(items []model.MediaItem) []model.MediaItem {
    s.mu.Lock()
    ff := s.formatFilter
    s.mu.Unlock()

    if ff == nil { return items }
    out := make([]model.MediaItem, 0, len(items))
    for _, it := range items {
        if _, ok := ff[it.Format]; ok {
            out = append(out, it)
        }
    }
    return out
}
```

Note the snapshot pattern: read the map pointer under the lock, then iterate outside. We take the map by reference, but the map is replaced wholesale by `SetFormatFilter` (it allocates a new map), so concurrent reads see a stable old map even after a filter change.

#### `RunTimePump`

The session's owning goroutine for the virtual clock.

```go
for {
    select {
    case <-s.done:
        return
    case <-s.tickCh:
        s.mu.Lock()
        if s.paused || s.virtualTime.IsZero() {
            s.mu.Unlock()
            continue
        }
        s.virtualTime = s.virtualTime.Add(time.Second)
        t := s.virtualTime
        s.mu.Unlock()

        items, err := cache.ItemsAt(ctx, s.rdb, t)
        if err != nil {
            s.logger.Warn("cache lookup failed", "error", err)
            continue
        }
        filtered := s.applyFormatFilter(items)
        if len(filtered) > 0 {
            s.send_(outMsg{Type: "items", Time: t.Format(time.RFC3339), Items: filtered})
        }
    }
}
```

Three things to notice:

1. **`virtualTime.IsZero()` check.** Before `init`, virtual time is the zero value; ticks during this period are no-ops. This is the mechanism that lets a client take its time on the initial handshake.
2. **Lock window is tiny.** Lock → check → advance → snapshot → unlock. Redis call happens outside the lock.
3. **Empty seconds produce no frame.** `len(filtered) == 0` → no `items` message. Silence is meaningful in the protocol.

#### `send_`

The single send path. Triple-gated:

```go
func (s *Session) send_(m outMsg) {
    // (1) Is the session closed?
    select {
    case <-s.done:
        return
    default:
    }

    data, err := json.Marshal(m)
    if err != nil {
        return
    }

    // (2) Try to send; (3) handle close races and full buffers.
    select {
    case s.send <- data:
    case <-s.done:
    default:
        s.logger.Warn("send buffer full, dropping message", "type", m.Type)
    }
}
```

Three select cases on the outbound send:

- `s.send <- data` — happy path.
- `<-s.done` — session closed between the marshal and the send; drop the message silently.
- `default` — buffer full; drop with a warning log.

The drop policy is what makes the streamer resilient to slow clients. The alternative — block on send — would propagate the slow client's backpressure all the way to the hub and would take down every session. Don't change this.

---

## Session IDs

```go
func newID() string {
    b := make([]byte, 8)
    rand.Read(b)
    return hex.EncodeToString(b)
}
```

16-char hex string from 8 random bytes. Used as the map key in `Hub.sessions` and as a `slog` attribute on every per-session log line. No security significance — these aren't auth tokens.

---

## Failure modes

| Failure                              | Outcome                                                        |
| ------------------------------------ | -------------------------------------------------------------- |
| Redis errors in `RunTimePump`        | Log warn, skip this tick. Next tick tries again.               |
| Send buffer full                     | Drop the message, log warn. Session continues.                 |
| `Close` called from multiple paths   | First wins. `closeOnce` makes subsequent calls no-ops.         |
| Hub unregister channel saturated     | Backpressure on `Hub.Unregister`; eventually clears.           |
| Tick channel non-empty when paused   | Ticks accumulate at most 1 deep (`tickCh` capacity); ignored.  |
| Heartbeat snaps backward in time     | Allowed. The client wins. The next tick advances from there.   |

---

## What this package does **not** do

- **Talk to Postgres.** Init/seek queries happen in the handler; the session takes the resulting `[]MediaItem` slice as a parameter. This keeps the session pure and testable.
- **Parse JSON.** The handler does that. Session methods take typed Go values.
- **Manage WebSockets.** The session is unaware of the transport; it produces `[]byte` messages and consumes typed method calls.

These separations are deliberate. Don't let session reach across them.

---

## Testing

Sessions are the most testable component because they have no transport I/O — message production goes through `send_` into a channel and the writePump is owned by the handler.

To add hermetic tests:

- Construct a `Hub` directly with `NewHub(slog.New(...))`. Run `Hub.Run` in a goroutine if you need ticks; otherwise drive `tickCh` manually for deterministic timing.
- `*goredis.Client` is a concrete type — back it with `github.com/alicebob/miniredis/v2` (already used in [`internal/cache/`](../../internal/cache/redis_test.go)).
- Drift correction in `Heartbeat` is pure given a starting `virtualTime` and a `clientTime`; assert on the snapshot returned in the outbound `heartbeat_ack`.

---

## When to change this

- **Add a new session method** — follow the lock pattern. Mutate under `mu`, snapshot, unlock, send.
- **Change `driftThresh` or `sendBuf`** — fine, but explain the new value in a comment.
- **Add a new field to `Session`** — decide if it needs `mu` protection. Anything mutated after `NewSession` returns probably does.
- **Add a per-session goroutine** — think hard. Three is the current count and each has a clear responsibility. Adding a fourth needs justification.
