# `internal/db`

The Postgres adapter. Owns the connection pool and every `SELECT` the streamer runs against `media_items`. There are no writes — Postgres is owned by Directus.

Source: [`internal/db/postgres.go`](../../internal/db/postgres.go).

---

## Public surface

```go
func Connect(dsn string) (*pgxpool.Pool, error)
func AllItems(ctx context.Context, pool *pgxpool.Pool) ([]model.MediaItem, error)
func CurrentItems(ctx context.Context, pool *pgxpool.Pool, t time.Time) ([]model.MediaItem, error)
```

Three functions, one driver. `pgx/v5` via `pgxpool`.

---

## `Connect`

```go
func Connect(dsn string) (*pgxpool.Pool, error)
```

Creates a `pgxpool.Pool` and pings it to verify connectivity. The ping uses a 15-second timeout — long enough that a slow-warming dev Postgres is forgiving, short enough that a misconfigured `DATABASE_URL` fails fast.

On success the pool is ready to use. The caller (`main`) holds the pool for the process lifetime and passes a `*pgxpool.Pool` into the request handler.

Connection-pool tuning happens via DSN parameters — `pool_max_conns`, `pool_min_conns`, `pool_max_conn_lifetime`, etc. See pgx docs. We default to whatever pgx picks because the streamer's Postgres usage is modest (init/seek only).

---

## `selectFrom`

```go
const selectFrom = `
    SELECT mi.id, mi.title, mi.full_title, s.slug,
           mi.start_date, mi.end_date, mi.calc_duration, mi.timezone,
           mi.url, mi.format, mi.approved, mi.mute,
           mi.volume, mi.jump, mi.trim, mi.image, mi.image_caption,
           mi.content, mi.sort
    FROM media_items mi
    LEFT JOIN sources s ON s.id = mi.source`
```

Every query the streamer runs uses this prefix. The join resolves `media_items.source` (integer FK) into `sources.slug` (human-readable string), which is what gets emitted on the wire. The frontend never sees the FK integer.

If you add a column to `media_items`:

1. Append it to the column list (preserve order).
2. Add a scan target to `queryItems` in the same position.
3. Update [`internal/model/item.go`](../../internal/model/item.go).

The column order in `SELECT` must match the `rows.Scan` argument order exactly. Misalignment will type-mismatch at runtime if you're lucky, or silently corrupt fields if you're not.

---

## `AllItems`

```go
func AllItems(ctx context.Context, pool *pgxpool.Pool) ([]model.MediaItem, error)
```

Loads every approved row, sorted by `start_date`. Used exactly once: at boot, by `cache.WarmCache`. The streamer's hot path never calls this.

Why no pagination? Memory footprint vs. operational simplicity. With our largest realistic dataset (usenet ≈ 6M rows), this query produces ~1 GB of JSON pre-marshalling, which is fine for a one-shot warm. If we ever push past 50M rows, batch it.

---

## `CurrentItems`

```go
func CurrentItems(ctx context.Context, pool *pgxpool.Pool, t time.Time) ([]model.MediaItem, error)
```

The "everything overlapping `t`" query. Used by the handler for `init` and `seek`.

### The SQL

```sql
SELECT ...
FROM media_items mi
LEFT JOIN sources s ON s.id = mi.source
WHERE mi.approved = 1
  AND (
    (mi.start_date <= $1 AND (mi.end_date IS NULL OR mi.end_date >= $1))
    OR (
      (mi.start_date = mi.end_date OR (mi.calc_duration IS NOT NULL AND mi.calc_duration = 0))
      AND mi.start_date <= $1
      AND mi.start_date >= $1 - INTERVAL '5 minutes'
    )
  )
ORDER BY mi.start_date
```

Two `WHERE` branches OR'd together:

**Branch A — overlap.** Items whose `[start_date, end_date]` interval contains `t`. Open-ended items (`end_date IS NULL`) are included if `start_date ≤ t`.

**Branch B — instant lookback.** Items where `start_date = end_date` or `calc_duration = 0` (zero-duration "instant" items) AND `start_date ∈ [t - 5m, t]`.

The lookback exists so a client initialising at virtual time `T` still sees pager messages and news entries that fired in the last five virtual minutes. Without it, the user would see a blank stream until the next live message and would think the streamer was broken. Five minutes is a deliberate compromise between "enough context to know what's going on" and "not a wall of stale text."

### Why is the lookback hardcoded?

It's a UX decision. Five minutes is right for pager traffic (most messages aren't relevant 5 minutes later) and roughly right for news (skimming the last few headlines). To use a different value, change the constant in the SQL or parameterise it on the call signature.

### Index expectations

The query benefits from an index on `(approved, start_date)`. Directus creates a basic index on `start_date` via the column definition; the streamer assumes Postgres picks the right plan. If `EXPLAIN ANALYZE` shows a sequential scan on a large table, add the composite index manually.

---

## `queryItems` (unexported)

```go
func queryItems(ctx context.Context, pool *pgxpool.Pool, q string, args ...any) ([]model.MediaItem, error)
```

The shared scan loop. Both `AllItems` and `CurrentItems` go through this.

### The NULL string problem

Directus stores empty strings as `NULL`, and pgx cannot scan `NULL` into a non-pointer `string`. The model exposes `string` everywhere (not `*string`) because the wire format wants empty strings, not `null`.

The compromise: scan into local `*string` pointers and dereference via `derefStr`.

```go
var fullTitle, timezone, url, format, image, imageCaption, content *string
if err := rows.Scan(
    &it.ID, &it.Title, &fullTitle, &it.Source,
    &it.StartDate, &it.EndDate, &it.CalcDuration, &timezone,
    &url, &format, &it.Approved, &it.Mute,
    &it.Volume, &it.Jump, &it.Trim, &image, &imageCaption,
    &content, &it.Sort,
); err != nil { ... }
derefStr(&it.FullTitle, fullTitle)
derefStr(&it.Timezone, timezone)
// ... etc
```

`it.Source` is itself `*string`, so it's scanned directly. `it.EndDate` is `*time.Time`. `it.CalcDuration` and `it.Sort` are `*int`. These three nullable types are honored as-is and emitted with `omitempty` on the JSON side.

When adding a new nullable text column:

1. Add `var newCol *string` to the local pointer block.
2. Add `&newCol` to the `Scan(...)` arg list at the matching position.
3. Add `derefStr(&it.NewCol, newCol)` after the `if err := …` check.

If the column is `NOT NULL` (e.g. `title`, `start_date`), scan directly into `it.Field` — no pointer dance needed.

### `derefStr`

```go
func derefStr(dst *string, src *string) {
    if src != nil {
        *dst = *src
    }
}
```

Three lines. Could be inlined. Lives as a helper because there are seven nullable text columns and DRY is cheap when the helper is this small.

---

## Failure modes

| Failure                                  | Caller sees                 | What happens                                  |
| ---------------------------------------- | --------------------------- | --------------------------------------------- |
| `Connect` `pgxpool.New` fails            | wrapped error               | `main` logs and exits 1                       |
| `Connect` `Ping` fails (15 s timeout)    | wrapped error, pool closed  | `main` logs and exits 1                       |
| `AllItems` query error                   | wrapped error               | `cache.WarmCache` propagates; `main` exits 1  |
| `CurrentItems` query error               | error                       | Handler sends `error` to client, continues    |
| `Scan` error                             | wrapped error               | Same as above                                 |
| Row iteration error (`rows.Err()`)       | error                       | Same as above                                 |

The streamer does **not** attempt to reconnect Postgres manually. `pgxpool` handles connection failures internally on the next query.

---

## Testing

The pure-SQL behavior of this package (overlap arithmetic, instant-row lookback, NULL → empty-string handling) is exercised via the docker-compose stack and the seeded fixtures in [`packages/backend/`](../../). To add hermetic Go tests:

- Use `github.com/pashagolub/pgxmock/v3` to mock the `*pgxpool.Pool` and assert on `rows.Scan` paths — especially the NULL-string columns, which silently break if `derefStr` is bypassed.
- Use `testcontainers-go` for integration coverage of `CurrentItems` overlap and the 5-minute lookback. Gate it behind a `// +build integration` tag.

---

## When to change this

- **A new query**. Add it as a new exported function calling `queryItems(…)`. Don't generalise `CurrentItems` to take options — readability trumps reuse for two callers.
- **A different overlap policy**. Edit the SQL in `CurrentItems` with a comment explaining why. Five-minute lookback was deliberate; new policies need to be too.
- **Writes**. Don't add them. Directus owns the schema and write path. If the streamer ever needs to record session state, do it in a separate package (`internal/state` or similar) so the boundary stays clean.
