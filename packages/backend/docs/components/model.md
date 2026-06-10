# `internal/model`

The shared data type. One file, one struct. Imported by `db`, `cache`, `handler`, and `session`.

Source: [`internal/model/item.go`](../../internal/model/item.go).

---

## `MediaItem`

```go
type MediaItem struct {
    ID           int        `json:"id"`
    Title        string     `json:"title"`
    FullTitle    string     `json:"full_title"`
    Source       *string    `json:"source,omitempty"`
    StartDate    time.Time  `json:"start_date"`
    EndDate      *time.Time `json:"end_date,omitempty"`
    CalcDuration *int       `json:"calc_duration,omitempty"`
    Timezone     string     `json:"timezone,omitempty"`
    URL          string     `json:"url"`
    Format       string     `json:"format"`
    Approved     int        `json:"approved"`
    Mute         int        `json:"mute"`
    Volume       float64    `json:"volume"`
    Jump         int        `json:"jump"`
    Trim         int        `json:"trim"`
    Image        string     `json:"image,omitempty"`
    ImageCaption string     `json:"image_caption,omitempty"`
    Content      string     `json:"content,omitempty"`
    Sort         *int       `json:"sort,omitempty"`
}
```

This struct serves three jobs at once:

1. **The pgx scan target.** Every column in [`db.selectFrom`](./db.md) lands in one of these fields.
2. **The Redis cache payload.** Each item is `json.Marshal`'d into the `media:items` HASH and unmarshalled back out on lookup.
3. **The wire format.** The JSON tags are the protocol contract between the streamer and the frontend.

Because one struct does all three, the columns, the cache schema, and the wire format must all stay in lockstep. There's no separate "API DTO" — that would mean three places to change every time a field is added.

---

## Field-by-field

### Identity and labels

| Field        | Type     | JSON          | DB column          | Notes                                  |
| ------------ | -------- | ------------- | ------------------ | -------------------------------------- |
| `ID`         | `int`    | `id`          | `media_items.id`   | Stable. Used as Redis HASH key.        |
| `Title`      | `string` | `title`       | `media_items.title`| `NOT NULL`. Required.                  |
| `FullTitle`  | `string` | `full_title`  | `media_items.full_title` | NULL → `""`. No `omitempty`.    |

### Time and duration

| Field          | Type         | JSON               | DB column                  | Notes                                                                 |
| -------------- | ------------ | ------------------ | -------------------------- | --------------------------------------------------------------------- |
| `StartDate`    | `time.Time`  | `start_date`       | `media_items.start_date`   | `NOT NULL`. Drives the cache ZSET score and all overlap queries.       |
| `EndDate`      | `*time.Time` | `end_date,omit…`   | `media_items.end_date`     | NULL allowed; emitted as JSON `null` or absent.                       |
| `CalcDuration` | `*int`       | `calc_duration,…`  | `media_items.calc_duration`| Seconds. `0` = instant; NULL = unknown.                               |
| `Timezone`     | `string`     | `timezone,…`       | `media_items.timezone`     | Informational only. Server never converts.                            |

### Source

| Field    | Type      | JSON          | DB column                   | Notes                                                            |
| -------- | --------- | ------------- | --------------------------- | ---------------------------------------------------------------- |
| `Source` | `*string` | `source,omit…`| `sources.slug` (via JOIN)   | The **slug**, not the FK id. NULL when item has no source row.   |

### Playback

| Field    | Type      | JSON       | DB column               | Notes                                                  |
| -------- | --------- | ---------- | ----------------------- | ------------------------------------------------------ |
| `URL`    | `string`  | `url`      | `media_items.url`       | NULL → `""`.                                           |
| `Format` | `string`  | `format`   | `media_items.format`    | NULL → `""`. Drives the format filter.                 |
| `Mute`   | `int`     | `mute`     | `media_items.mute`      | `0` or `1`. Client interprets.                         |
| `Volume` | `float64` | `volume`   | `media_items.volume`    | `0.0` – `1.0`. Client interprets.                      |
| `Jump`   | `int`     | `jump`     | `media_items.jump`      | Seconds to skip at start of media.                     |
| `Trim`   | `int`     | `trim`     | `media_items.trim`      | Seconds to trim from end of media.                     |

### Display

| Field          | Type     | JSON                  | DB column                     | Notes                  |
| -------------- | -------- | --------------------- | ----------------------------- | ---------------------- |
| `Image`        | `string` | `image,omit…`         | `media_items.image`           | URL. NULL → `""`.      |
| `ImageCaption` | `string` | `image_caption,omit…` | `media_items.image_caption`   | NULL → `""`.           |
| `Content`      | `string` | `content,omit…`       | `media_items.content`         | Body text. NULL → `""`.|

### Lifecycle and ordering

| Field      | Type    | JSON          | DB column               | Notes                                                                |
| ---------- | ------- | ------------- | ----------------------- | -------------------------------------------------------------------- |
| `Approved` | `int`   | `approved`    | `media_items.approved`  | `1` = approved (streamer-visible), `0` = hidden.                     |
| `Sort`     | `*int`  | `sort,omit…`  | `media_items.sort`      | Stable tiebreaker. Currently not used in queries' `ORDER BY`.        |

---

## Nullable types — the inconsistency

Some nullable text columns are `string` in Go (NULL → empty string), others are `*string` (NULL → JSON `null` or absent). Why?

- **`string`-typed columns** (e.g. `URL`, `Format`, `Image`) — empty string is meaningful absence. The frontend treats `image: ""` the same as no image.
- **`*string`-typed columns** (`Source`) — distinction matters. A NULL source is "unknown origin," visually different from "an explicit empty-slug source."
- **`*int` / `*time.Time`** — the type system has no zero-vs-null distinction for these primitives, so we use pointers.

This is intentional, not an oversight. If you add a new column, decide which category it belongs to and follow the existing pattern.

---

## What this struct does **not** contain

- **A constructor.** No `NewMediaItem(...)`. The struct is populated by `pgx.Scan` or `json.Unmarshal`. No business logic lives here.
- **Validation methods.** No `IsActiveAt(t time.Time)` or similar. Overlap logic lives in SQL (`CurrentItems`); per-second matching lives in Redis. Putting it on the struct would scatter the truth.
- **Computed fields.** No `Duration() time.Duration` method. If you need duration, compute it at the call site — most callers already have `EndDate.Sub(StartDate)` in context.
- **A `proto` or schema definition.** The struct *is* the schema. The JSON tags are the wire format.

If you find yourself wanting to add a method here, ask whether it belongs in `db`, `cache`, or `session` instead. Model stays passive.

---

## Versioning the wire format

There is no version field. The streamer has one consumer (the frontend in `packages/frontend/`), and they ship together. If you change a field name or remove one, update the frontend in the same commit. There is no policy for backwards-compatible changes — we do not pretend to support old clients.

When the consumer count grows past one, revisit. Until then, the simplicity is worth it.

---

## Adding a field

Six places to touch. Miss one and the field will silently fail to round-trip.

1. **`internal/model/item.go`** — add the field with appropriate type and JSON tag.
2. **`internal/db/postgres.go` `selectFrom`** — append the column name to the `SELECT` list.
3. **`internal/db/postgres.go` `queryItems` `rows.Scan`** — add the scan target in the matching position. Use a `*string` local + `derefStr` if nullable text.
4. **`seed.mjs`** — add the field to the Directus `fields[]` definition so fresh installs get it.
5. **The Postgres database** — `ALTER TABLE media_items ADD COLUMN …` if you're not reseeding.
6. **The frontend type** — update wherever `packages/frontend/` defines the corresponding TS interface.

Cached rows pick up the new field as soon as they're touched in Postgres (the NOTIFY trigger re-`Upsert`s them). To refresh untouched rows immediately, restart the streamer — the listener's resync-on-attach rewrites every cached row from the database.

---

## When to change this

- **Add a column** — follow the six-step recipe above.
- **Rename a field** — coordinate with the frontend, ship together.
- **Change a type** (e.g. `int` → `*int`) — likely indicates a bug; existing rows may have implicit zeros that mean "unset." Migrate the data carefully.
- **Split into multiple types** — only worth it when the model is so big the all-in-one struct becomes confusing. We're far from that threshold.
