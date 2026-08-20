# Data model

The streamer reads five Directus-managed Postgres tables: `sources`, `media_items`, `pager_items`, `mp3_items`, and `news_items`. It never writes to them. Schema definition lives in [`seed.mjs`](../seed.mjs); this document is the authoritative reference for what the streamer expects to see.

---

## `sources`

```sql
CREATE TABLE sources (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  description text
);
```

Sources are broadcast networks, news outlets, pager providers, or any other origin of a media item. They are joined to `media_items.source` via integer FK.

The streamer's queries return `sources.slug` to the client (not the integer id) because slugs are stable, human-readable, and what the frontend wants to display ("ABC", "CNN", "FDNY-Manhattan", …).

---

## `media_items`

```sql
CREATE TABLE media_items (
  id             serial PRIMARY KEY,
  title          text NOT NULL,
  full_title     text,
  source         integer REFERENCES sources(id),
  start_date     timestamptz NOT NULL,
  end_date       timestamptz,
  calc_duration  integer,                      -- seconds; 0 = instant
  timezone       text,
  url            text,
  format         text,                         -- m3u8 | mp4 | mp3 | html | modal | news | pager | usenet
  approved       integer DEFAULT 1,            -- 1 = approved, 0 = pending
  mute           integer DEFAULT 0,            -- 1 = muted, 0 = audible
  volume         float   DEFAULT 1,            -- 0.0–1.0
  jump           integer DEFAULT 0,            -- start offset in seconds
  trim           integer DEFAULT 0,            -- trim from end in seconds
  image          text,
  image_caption  text,
  content        text,
  sort           integer
);

CREATE INDEX media_items_start_date_idx ON media_items (start_date);
```

(Directus initially creates string columns as `varchar(255)`; `seed.mjs` widens the long ones to `text` via `ALTER TABLE`.)

> **Pager note:** pager traffic used to live here as `format = 'pager'` rows. It now has its own `pager_items` table (see below) and is delivered on the opt-in `pager` subscription channel, not the format filter.

### Column reference

| Column          | Type          | Required | Streamer use                                                              |
| --------------- | ------------- | -------- | ------------------------------------------------------------------------- |
| `id`            | int           | yes      | Stable identity, used as Redis HASH key.                                  |
| `title`         | text          | yes      | Short label shown by the frontend.                                        |
| `full_title`    | text          | no       | Long label; empty string if NULL.                                         |
| `source`        | int           | no       | FK → `sources.id`. Streamer joins and emits the slug.                     |
| `start_date`    | timestamptz   | yes      | Drives both Redis ZSET score and Postgres overlap queries.                |
| `end_date`      | timestamptz   | no       | NULL = open-ended. Used by `CurrentItems` for overlap.                    |
| `calc_duration` | int (sec)     | no       | When 0, the item is treated as "instant" (one-second presence).           |
| `timezone`      | text          | no       | Informational only — server never converts timezones.                     |
| `url`           | text          | no       | Where the client fetches the media.                                       |
| `format`        | text          | no       | The format filter operates on this. See list below.                       |
| `approved`      | int           | yes      | `approved = 1` is the universal `WHERE` clause; 0 hides the row.          |
| `mute`          | int           | yes      | 1 = client should mute audio.                                             |
| `volume`        | float         | yes      | 0.0–1.0 audio level hint.                                                 |
| `jump`          | int (sec)     | yes      | Client-side seek offset into the media.                                   |
| `trim`          | int (sec)     | yes      | Client-side trim from end of media.                                       |
| `image`         | text          | no       | Optional thumbnail / hero URL.                                            |
| `image_caption` | text          | no       | Caption for the image.                                                    |
| `content`       | text          | no       | Body text (used by `news`, `pager`, `usenet`).                            |
| `sort`          | int           | no       | Stable display order tiebreaker.                                          |

### Nullable text columns

All `text` columns marked "no" above are nullable. Directus inserts empty strings as `NULL`, so the streamer must scan into `*string` and dereference via `derefStr`. The Go model uses non-pointer `string` for these and substitutes `""` when NULL — see [`components/db.md`](./components/db.md) for the pattern.

---

## `pager_items`

```sql
CREATE TABLE pager_items (
  id            serial PRIMARY KEY,
  start_date    timestamptz NOT NULL,           -- UTC; pager data is recorded EDT and converted on import
  provider      text,                            -- e.g. Metrocall, Arch, Skytel, Skytael
  recipient_id  text,
  id_type       text,
  channel       text,
  mode          text,                            -- e.g. ALPHA
  message       text,
  approved      integer DEFAULT 1,
  sort          integer
);

CREATE INDEX pager_items_start_date_idx ON pager_items (start_date);
```

Every pager item is **instant** — a `start_date` with no `end_date`/`calc_duration`. Unlike the
old design, pager metadata is stored as first-class columns (no `content` JSON), and `provider`
is plain text rather than a `sources` FK. The streamer keeps `pager_items` in a separate Redis
keyspace (`pager:items` / `pager:by_start`) so the ~447k-row pager set never burdens the 1 Hz
media tick path, and delivers it only to sessions that `subscribe` to the `pager` channel.

| Column         | Type        | Required | Streamer use                                                       |
| -------------- | ----------- | -------- | ------------------------------------------------------------------ |
| `id`           | int         | yes      | Stable identity, Redis HASH key in `pager:items`.                  |
| `start_date`   | timestamptz | yes      | Redis ZSET score; forward-only delivery (snapshot is the requested second only). |
| `provider`     | text        | no       | Pager network name.                                                |
| `recipient_id` | text        | no       | Destination capcode/ID.                                            |
| `id_type`      | text        | no       | Recipient ID classification.                                       |
| `channel`      | text        | no       | Pager channel.                                                     |
| `mode`         | text        | no       | Encoding mode (e.g. `ALPHA`).                                       |
| `message`      | text        | no       | The page body.                                                     |
| `approved`     | int         | yes      | `approved = 1` is the universal `WHERE` clause; 0 hides the row.   |
| `sort`         | int         | no       | Stable display order tiebreaker.                                   |

Pager `approved` flips behave exactly like `media_items`: the `pager_items_changed` NOTIFY
trigger re-fetches and `UpsertPager`/`ForgetPager`s the row in the pager cache.

---

## `mp3_items`

Same columns as `media_items` (mp3 reuses the MediaItem shape) but in its own table, delivered on
the opt-in `mp3` channel for the Radio Traffic app:

```sql
CREATE TABLE mp3_items (LIKE media_items INCLUDING ALL);  -- same shape; format is always 'mp3'
CREATE INDEX mp3_items_start_date_idx ON mp3_items (start_date);
```

mp3 items are **durational** audio (a `start_date`/`end_date` interval, often hours long, with a
`jump` offset into the file). Unlike pager, the streamer keeps them in their own Redis keyspace
(`mp3:items` / `mp3:by_start`) and the subscribe/init/seek snapshot uses the **overlap** window
(`start_date ≤ t ≤ end_date`) so the Radio Traffic app gets the recording playing at `t` and resumes
it mid-file. The tick path then delivers items starting at each forward second.

### Radio Traffic metadata columns

`mp3_items` carries a second group of columns beyond the `media_items` shape above: who a
recording's traffic is between, what it's about, and how far to trust that. They're populated by
video-grabber's `identify-parties` pipeline (see
[`../../tools/video-grabber/docs/party-identification.md`](../../tools/video-grabber/docs/party-identification.md))
and served to the frontend as the one-shot `mp3_meta` WebSocket frame and the `/mp3/*` HTTP routes
(see [`websocket-protocol.md`](./websocket-protocol.md) and [`http-api.md`](./http-api.md)) — never
as extra fields on the streamed `MediaItem`, and never queried by the streamer's tick path.

| Column | Type | Public? | Notes |
|---|---|---|---|
| `parties` | jsonb | **no** | The private, model-produced source of everything below. Carries `gate_reasons` and `model` — internal QA signals about the pipeline's own confidence, not facts about the recording — which must never reach an anonymous reader. |
| `tags_curated` | jsonb | no | Hand-added tags a curator entered directly; read by the derivation, never written by it. |
| `derived_at` | text | no | Stamp recording which `rederive-mp3-metadata` run last wrote the row. An internal marker with no reader. |
| `subject` | text | yes | One line, in the source's own words. |
| `link` | text | yes | Call type: `air-ground`, `landline`, `internal`, `conference`, `unknown`. |
| `tier` | text | yes | `primary` \| `clip` \| … — how central this recording is to the event. |
| `confidence` | text | yes | Overall confidence, capped at `medium` if the containment gate rejected anything. |
| `evidence` | text | yes | Verbatim transcript quote backing `subject`. |
| `participants` | jsonb | yes | Array of `{person, facility, position, role, confidence}` — one entry per party to the call. |
| `mentions` | jsonb | yes | `{facilities[], aircraft[], people[]}` — entities named but not on the call. |
| `provenance` | jsonb | yes | `{generated_at, sources, commission}` — where the published values came from, path by path. |
| `peaks` | jsonb | yes | 480 `[min, max]` amplitude-envelope buckets scaled to -128..127, computed by video-grabber's peaks pipeline. |
| `tags` | list-m2m | yes | **Alias**, not a column — see below. |

`subject`/`link`/`tier`/`confidence`/`evidence`/`participants`/`mentions`/`provenance` are a
**redacted projection** of `parties`, materialised by video-grabber's `public_meta.build_public_meta`
— the single place that redaction happens. `gate_reasons` and `model` are absent from the
projection by construction, so nothing downstream (this table's public columns, the Go types, the
TypeScript types) has anywhere to put them even if a caller tried. `mp3_items.parties` itself keeps
returning `403` to anonymous Directus readers; only the projected columns are public-read.

### `mp3_tags` / `mp3_items_tags`

The tag vocabulary and its junction — the namespaced index (`facility:zbw`, `aircraft:aal11`,
`topic:loss-of-contact`, …) the Radio Traffic sidebar filters by, and what `GET /mp3/tags` serves:

```sql
CREATE TABLE mp3_tags (
  id         serial PRIMARY KEY,
  tag        text NOT NULL UNIQUE,   -- "facility:zbw" — namespace:value, or a bare curated tag
  namespace  text,                    -- NULL for an un-namespaced curated tag
  value      text,
  color      text,
  sort       integer
);

CREATE TABLE mp3_items_tags (
  mp3_items_id integer REFERENCES mp3_items(id),
  mp3_tags_id  integer REFERENCES mp3_tags(id)
);
```

`mp3_items.tags` is a Directus **`list-m2m` alias** over `mp3_items_tags`, not a real column —
it cannot be set by `PATCH /items/mp3_items/{id} {"tags": [...]}`; the pipeline writes it through
`tag_store.py` instead. Both tables are rebuilt wholesale by video-grabber's `rederive-mp3-metadata`
flow (see `party-identification.md`) — `mp3_tags` rows are created but never deleted (a retracted
tag loses its junction rows and vanishes from search, but the row itself is cheap and may be
referenced again), while `mp3_items_tags` is rebuilt per item on every derivation pass so a tag the
current derivation no longer produces loses its rows rather than lingering.

The streamer's `mp3MetaSelectFrom` query (`internal/db/postgres.go`) reads the junction directly via
a `LATERAL json_agg`, not through the Directus alias — one row per item, tags pre-aggregated as
JSON, `COALESCE`d to `[]` for an item with none.

---

## `news_items`

Same columns as `media_items` (news reuses the MediaItem shape) but in its own table, delivered on
the opt-in `news` channel for the News app:

```sql
CREATE TABLE news_items (LIKE media_items INCLUDING ALL);  -- same shape; format is always 'news'
CREATE INDEX news_items_start_date_idx ON news_items (start_date);
```

News is mostly **instant** (`start_date = end_date` — a headline at a moment), with a few
durational entries. Timestamps are **UTC**: clock times parsed from titles are Eastern (EDT for
the 9/11-era data) and converted to UTC on import (`transformNewsEntry` → `etToUtc`), matching
every other stream; date-only historical entries stay at naive midnight. Kept in its own Redis keyspace (`news:items` / `news:by_start`); the
subscribe/init/seek snapshot uses the same **overlap + 5-minute instant lookback** window as
`CurrentItems`, so a seek to `t` shows stories from the preceding minutes. The tick path then
delivers news starting at each forward second.

---

## Format vocabulary

`media_items.format` is a free-text column. The Directus admin UI presents these choices (from `seed.mjs`):

| Format  | Used for                                                                  |
| ------- | ------------------------------------------------------------------------- |
| `m3u8`  | HLS live-stream playlists (e.g. archived TV broadcasts).                  |
| `mp4`   | On-demand video files.                                                    |
| `modal` | Modal/overlay events — fire on `start_date` and show until dismissed.     |
| `usenet`| Usenet posts imported via `import-usenet.mjs`.                            |

Pager, mp3 and news are no longer `media_items.format`s — they live in `pager_items` /
`mp3_items` / `news_items` and ride the `pager` / `mp3` / `news` subscription channels (see
[`websocket-protocol.md`](./websocket-protocol.md)). The former `html` format was dropped: those
529 rows were duplicate History Commons articles already present in `news_items` (matched by
`url`), so the seed no longer imports them.

The streamer does **not** enforce this vocabulary — it passes whatever `format` it reads straight to the client. The frontend chooses how to render unknown formats. The format filter (Section 3.7 of `SPEC.md`) matches exact strings.

---

## Categorising items by duration

Items fall into three duration classes; each interacts differently with the streamer.

### "Long" items — finite, non-zero duration

`start_date < end_date` and `calc_duration > 0`. Example: a one-hour TV broadcast.

- Returned by `CurrentItems` when `start_date ≤ t ≤ end_date`.
- Returned by `cache.ItemsAt(t)` **only at the second equal to `start_date`** — the cache fires the item once, not continuously.

### "Open-ended" items — no end_date

`end_date IS NULL`. Treated by `CurrentItems` as overlapping if `start_date ≤ t`.

These are unusual in practice — almost everything has an end — but the query handles them safely.

### "Instant" items — zero duration

`start_date = end_date` OR `calc_duration = 0`. Example: a single pager message or news entry.

- Returned by `cache.ItemsAt(t)` only at the second equal to `start_date`.
- Returned by `CurrentItems` for any `t` in `[start_date, start_date + 5 minutes]` — the 5-minute lookback ensures an init at virtual `T` shows pager messages fired at `T - 3 minutes`. Without lookback, the client would see nothing until the next live message.

The lookback is a UX decision encoded in SQL. See the `OR` clause in `db.CurrentItems`.

---

## Ordering

`AllItems` (cache warm) and `CurrentItems` (init/seek) both `ORDER BY start_date`. The cache itself is a `ZSET` keyed by `start_date` Unix-seconds, so subsequent lookups naturally return items in time order. The client can rely on this ordering inside any one `init_ack` / `seek_ack` / `items` payload.

The `sort` column is a tiebreaker for items with identical `start_date` — useful for, e.g., two news entries published at the same minute. Whether the streamer respects it depends on the query; currently `CurrentItems` does not add `, sort` to its `ORDER BY`. If you need stable ordering of co-temporal items, add it.

---

## Approved vs unapproved

`approved = 0` is moderation queue. The streamer never returns unapproved rows. There is no admin mode to bypass this; if you need to preview unapproved items, do it directly in Directus.

The cache warm filter is `WHERE mi.approved = 1`, so unapproved items aren't in Redis either. Flipping `approved` (in either direction) on a hot row fires the `media_items_changed` NOTIFY trigger; the listener in `cache.Listen` immediately re-fetches the row and either `Upsert`s it (1) or `Forget`s it (0). No restart needed.

---

## How the data gets here

Three import paths populate `media_items`:

1. **`seed.mjs`** — bootstraps Directus collections, then imports `entries_media.json` (TV / m3u8 broadcast records) and `entries_news.json` (news entries with title-parsed dates) into `media_items`, and `pager_entries.json` (pager traffic, EDT→UTC converted) into `pager_items`.
2. **`import-usenet.mjs`** — streams `out.NNN.json` NDJSON files and inserts them with `format = "usenet"`. The newsgroup name becomes the source slug.
3. **Directus admin UI** — manual edits and additions. The streamer picks these up automatically via the `media_items_changed` NOTIFY trigger installed by `cache.InstallTriggers` at boot; see [`components/cache.md`](./components/cache.md).

`upload-seed-data.sh` is a thin wrapper that pushes the local seed JSON files to a GCS bucket so the team shares one canonical dataset.

---

## What the streamer emits

The wire format mirrors `internal/model/item.go` exactly:

```json
{
  "id": 12345,
  "title": "Aaron Brown — special report",
  "full_title": "ABC News Special Report with Aaron Brown",
  "source": "abc",
  "start_date": "2001-09-11T13:46:00Z",
  "end_date": "2001-09-11T14:46:00Z",
  "calc_duration": 3600,
  "timezone": "America/New_York",
  "url": "https://.../abc.m3u8",
  "format": "m3u8",
  "approved": 1,
  "mute": 0,
  "volume": 1,
  "jump": 0,
  "trim": 0,
  "image": "",
  "image_caption": "",
  "content": "",
  "sort": null
}
```

Notes:
- `source` is the joined `sources.slug`, not the integer FK.
- Nullable `*string` columns appear as empty strings when NULL, **not** as JSON `null`. This is because the Go model uses bare `string` types and `derefStr` writes `""` when the source pointer is nil.
- `end_date` and `calc_duration` use `omitempty` and may be absent when NULL.
- `sort` is `*int` with `omitempty` — absent when NULL, otherwise an integer.
