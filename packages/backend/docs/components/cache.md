# `internal/cache`

Redis-backed hot path for per-second item delivery. Owns the boot-time warm and the `ItemsAt` lookup that the per-session time pumps call once per virtual second.

Source: [`internal/cache/redis.go`](../../internal/cache/redis.go).

---

## Public surface

```go
// Storage
func Connect(url string) *goredis.Client
func WarmCache(ctx context.Context, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) error
func ItemsAt(ctx context.Context, rdb *goredis.Client, t time.Time) ([]model.MediaItem, error)
func Upsert(ctx context.Context, rdb *goredis.Client, it model.MediaItem) error
func Forget(ctx context.Context, rdb *goredis.Client, id int) error

// Sync with Postgres
func InstallTriggers(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger) error
func Listen(ctx context.Context, dsn string, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger)
```

`Connect` / `WarmCache` / `ItemsAt` handle the hot path. `Upsert` / `Forget` are single-row mutations used by the NOTIFY listener. `InstallTriggers` + `Listen` keep the cache in sync with Postgres for the lifetime of the process.

---

## Redis layout

Two keys hold the entire cache:

| Key               | Type   | Contents                                                                              |
| ----------------- | ------ | ------------------------------------------------------------------------------------- |
| `media:items`     | HASH   | `id` (string) → marshalled `model.MediaItem` JSON.                                    |
| `media:by_start`  | ZSET   | `score = start_date.Unix()`, `member = id` (string). One entry per item.              |

Lookups are always a two-step:

1. `ZRANGEBYSCORE media:by_start <lo> <hi>` → list of ids in the time range.
2. `HMGET media:items <id1> <id2> …` → JSON blobs to unmarshal.

The cost is `O(log N + M)` where M is items in the range. For the per-second tick, M is almost always 0 or 1.

```mermaid
flowchart LR
    subgraph Lookup[ItemsAt]
        Z["ZRANGEBYSCORE media:by_start<br/>min=t.Unix() max=t.Unix()"]
        H["HMGET media:items id1 id2 ..."]
        U["json.Unmarshal each value"]
        Z --> H --> U
    end
```

### Why this layout?

- **ZSET keyed by Unix seconds** makes the per-second lookup an exact-match score query. No range arithmetic, no scanning.
- **HASH for the payload** lets us fetch by id with pipelined `HMGET`, and keeps payload updates (`HSET`) cheap. Storing payloads as ZSET members would make every update an O(log N) reshuffle and would prevent direct id lookups.
- **One key per dataset**, not per format or per source. Filtering happens server-side after the cache returns — see `Session.applyFormatFilter` in [`session.md`](./session.md).

---

## `Connect`

```go
func Connect(url string) *goredis.Client
```

Parses a Redis URL via `go-redis`'s `ParseURL`. On parse failure, falls back to `&goredis.Options{Addr: "localhost:6379"}` — this is deliberately permissive so dev environments without a `REDIS_URL` env still come up.

It does **not** ping. The first real operation (`WarmCache`'s `ZCard` call) is what verifies the connection.

URL forms supported:

- `redis://[user[:password]]@host:port[/db]`
- `rediss://…` for TLS
- Sentinel and cluster URLs are accepted by `go-redis`'s URL extensions; verify any sentinel/cluster deployment end-to-end before adopting it

---

## `WarmCache`

```go
func WarmCache(ctx context.Context, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) error
```

Boot-time invariant: after this returns successfully, every approved `media_items` row is in Redis.

Behavior:

1. `ZCARD media:by_start`. If `> 0`, the cache is considered warm and the function returns immediately. This is what makes streamer restarts cheap — only the first boot pays the warm cost.
2. Otherwise, call `db.AllItems(ctx, pool)` to load every approved row.
3. Build a pipeline of `HSET media:items id JSON` and `ZADD media:by_start <unix_score> id` for each item.
4. Execute the pipeline. Log `"redis cache warm" items=N`.

### Caveats and surprises

- **Marshal failures are swallowed.** If `json.Marshal(it)` returns an error (it shouldn't, given the struct), that item is silently dropped. This is acceptable for our use case but is the kind of thing to fix if we ever add fields that could fail marshalling (e.g. `chan` types — please don't).
- **Single pipeline.** All items go in one `pipe.Exec`. For our dataset size (tens of thousands typical, low millions for usenet) this works; if you ever push to 50M items, batch this.
- **The skip check is `ZCARD > 0`.** A partially-warmed cache (e.g. interrupted previous run) will look warm; the NOTIFY listener's resync-on-attach corrects it within seconds, but if you want to force a clean rebuild use `DEL media:by_start media:items` and restart. See [`operations.md`](../operations.md).
- **Incremental sync after boot.** Rows added, updated, or deleted in Postgres after boot are reflected in the cache by `Listen`, not `WarmCache`. See "NOTIFY-driven sync" below.

---

## NOTIFY-driven sync

The cache stays in sync with Postgres for the life of the process. Two pieces:

### Trigger installation (`InstallTriggers`)

Called once from `main` at boot. Installs a Postgres function and `AFTER INSERT OR UPDATE OR DELETE` trigger on `media_items`:

```sql
CREATE OR REPLACE FUNCTION rt911_notify_media_items_change()
RETURNS trigger AS $$
DECLARE payload json;
BEGIN
    IF TG_OP = 'DELETE' THEN
        payload = json_build_object('op', 'delete', 'id', OLD.id);
    ELSE
        payload = json_build_object('op', lower(TG_OP), 'id', NEW.id);
    END IF;
    PERFORM pg_notify('media_items_changed', payload::text);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER rt911_media_items_changed
AFTER INSERT OR UPDATE OR DELETE ON media_items
FOR EACH ROW EXECUTE FUNCTION rt911_notify_media_items_change();
```

Both objects are `rt911_`-prefixed so they cannot collide with anything Directus might install. The function and trigger are idempotent — `CREATE OR REPLACE FUNCTION` plus `DROP TRIGGER IF EXISTS` before recreate.

### The listener (`Listen`)

Runs in a dedicated goroutine for the lifetime of the process. It does **not** use the pgx pool — `LISTEN` requires a long-lived dedicated connection, so the listener calls `pgx.Connect` to open one of its own.

```mermaid
flowchart TB
    Start[Listen goroutine starts]
    Connect[pgx.Connect to DSN]
    Listen[LISTEN media_items_changed]
    Resync[resync: load all approved rows<br/>+ diff against ZSET<br/>+ apply HSET/ZADD/HDEL/ZREM]
    Wait[WaitForNotification]
    Decode[unmarshal payload]
    Apply[applyChange: Upsert or Forget]
    Backoff[sleep with exp. backoff<br/>1s → 30s cap]

    Start --> Connect
    Connect -->|err| Backoff
    Connect -->|ok| Listen
    Listen --> Resync
    Resync --> Wait
    Wait -->|notification| Decode
    Decode --> Apply
    Apply --> Wait
    Wait -->|conn err| Backoff
    Backoff --> Connect
```

Each notification carries `{"op": "insert|update|delete", "id": 12345}`. `applyChange` dispatches:

- **`delete`** → `Forget(id)` — `HDEL` + `ZREM` in one pipeline.
- **`insert` / `update`** → `db.ItemByID(id)`. If the row was deleted between the NOTIFY and the SELECT, or if its `approved` flag flipped to 0, `Forget` it; otherwise `Upsert` it (`HSET` + `ZADD`).

### Resync on (re)connect

Every successful `pgx.Connect` is followed by a full resync before entering the `WaitForNotification` loop:

1. Load every approved row from Postgres via `db.AllItems`.
2. `ZRANGE media:by_start 0 -1` to list every id currently in cache.
3. For ids in cache but not Postgres: `HDEL` + `ZREM` (one pipeline).
4. For all live rows: `HSET` + `ZADD` (same pipeline).

This is the mechanism that guarantees no notification is permanently lost. Postgres NOTIFY does not buffer — if the listener is disconnected when a NOTIFY fires, that notification is gone. The resync-on-reconnect makes that loss recoverable: when the listener comes back, the next thing it does is reconcile the entire cache with the database.

The cost is one `SELECT * FROM media_items WHERE approved = 1` plus one Redis pipeline per reconnect. With our dataset that's well under a second.

### Edge cases handled

- **`approved` flips 1 → 0.** Trigger fires UPDATE. `ItemByID` returns the row with `approved = 0`. `applyChange` calls `Forget`. The row disappears from the cache.
- **`approved` flips 0 → 1.** Trigger fires UPDATE. `ItemByID` returns `approved = 1`. `applyChange` calls `Upsert`. The row appears in the cache.
- **`start_date` changes.** UPDATE fires. `Upsert` calls `ZADD` with the same member, which updates the score in place. No stale entry is left behind.
- **Concurrent updates.** Postgres serialises trigger fires per-row. Two UPDATEs land in order; the second `Upsert` overwrites the first.
- **Row inserted then immediately deleted.** Two NOTIFYs fire in order: `insert` → `delete`. Final state: `Forget`. Cache is correct.
- **Streamer restarts during heavy writes.** Listener disconnects; trigger keeps firing into the void. On restart, the resync sweep brings the cache to current state.

## `ItemsAt`

```go
func ItemsAt(ctx context.Context, rdb *goredis.Client, t time.Time) ([]model.MediaItem, error)
```

Returns items whose `start_date` Unix-second exactly equals `t.Unix()`. The implementation uses `lo == hi` in the `ZRANGEBYSCORE` call.

Every row's `start_date` truncates to whole seconds in Postgres, so the exact-match semantics align with the data.

### Why exact-match instead of range?

The tick path runs `ItemsAt` exactly once per virtual second. The session knows it has already received items for previous seconds — there's no reason to fetch them again. Range queries would mean either delivering duplicates or tracking the last-seen high watermark per session. Exact-match is simpler and matches the data model perfectly.

### What about long-running items?

A one-hour broadcast (`start_date = T`, `end_date = T + 1h`) appears in `ItemsAt(T)` and only `ItemsAt(T)`. The streamer fires the item at its start; the client renders it until end. That's how the protocol works — `items` frames are events ("this item started"), not status ("this item is active right now"). For "currently active" semantics (init/seek), the streamer uses `db.CurrentItems` instead.

### `fetchByIDs` (unexported)

```go
func fetchByIDs(ctx context.Context, rdb *goredis.Client, ids []string) ([]model.MediaItem, error)
```

Helper that fans an id list through `HMGET` and unmarshals. Nil entries (the item disappeared from the hash between `ZRANGE` and `HMGET`) are skipped. Unmarshal failures are swallowed silently.

Used only by `ItemsAt`. If we ever add `ItemsByIDs` or similar, this is the shared helper.

---

## Failure modes

| Failure                               | Caller sees             | What happens to the stream            |
| ------------------------------------- | ----------------------- | ------------------------------------- |
| `Connect` parse fails                 | nil error, fallback URL | Probably broken; next call errors     |
| `WarmCache` `ZCard` errors            | wrapped error           | `main` logs and exits 1               |
| `WarmCache` `Pipeline.Exec` errors    | wrapped error           | `main` logs and exits 1               |
| `ItemsAt` `ZRANGEBYSCORE` errors      | error                   | Session logs warn and skips the tick  |
| `ItemsAt` `HMGET` errors              | error                   | Same — session continues              |
| Unmarshal of cache payload fails      | item silently dropped   | Client misses the item this second    |

---

## Testing

Tests live in [`redis_test.go`](../../internal/cache/redis_test.go) and [`listen_test.go`](../../internal/cache/listen_test.go). They use `github.com/alicebob/miniredis/v2` to back `*goredis.Client` so tests are hermetic and don't need a Redis container.

Coverage:

- `Upsert` + `ItemsAt` round-trip at a specific second.
- `Forget` removes both HASH and ZSET entries.
- A second `Upsert` on the same id with a different `start_date` evicts the old score (no orphan).
- `ItemsAt` returns empty on an unpopulated second.
- `changeNotification` JSON parsing for all three op values.
- The trigger SQL constant references the right channel name and covers INSERT/UPDATE/DELETE.

The NOTIFY round-trip and `WarmCache` against a populated DB are exercised end-to-end via `docker compose up` against the seeded fixtures in [`packages/backend/`](../../). Add Go integration tests behind a `// +build integration` tag if you need them in CI — keep them out of the default `go test ./...` run so the unit suite stays hermetic.

---

## When to change this

- **Adding a new lookup access pattern** (e.g. "all items in this hour"). Add a new function alongside `ItemsAt`; don't generalise `ItemsAt` to take a range. The exact-match semantics are load-bearing for the tick path.
- **Adding new sync semantics** (e.g. notify on `sources` changes too). Extend `InstallTriggers` with a second trigger and add a channel in `Listen`. Don't add another listener goroutine — multiplex on a single LISTEN connection if you need multiple channels.
- **Changing the key layout**. Don't. The Postgres queries don't care, but every consumer of this cache assumes the two-key shape. If you must, version the keys (`media:items:v2`) and migrate explicitly.
