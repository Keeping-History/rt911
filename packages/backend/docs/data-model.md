# Data model

The streamer reads three Directus-managed Postgres tables: `sources`, `media_items`, and `pager_items`. It never writes to them. Schema definition lives in [`seed.mjs`](../seed.mjs); this document is the authoritative reference for what the streamer expects to see.

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
| `start_date`   | timestamptz | yes      | Redis ZSET score; 5-minute lookback window on subscribe/init/seek. |
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

## Format vocabulary

`media_items.format` is a free-text column. The Directus admin UI presents these choices (from `seed.mjs`):

| Format  | Used for                                                                  |
| ------- | ------------------------------------------------------------------------- |
| `m3u8`  | HLS live-stream playlists (e.g. archived TV broadcasts).                  |
| `mp4`   | On-demand video files.                                                    |
| `mp3`   | On-demand audio files.                                                    |
| `html`  | Inline HTML to render.                                                    |
| `modal` | Modal/overlay events — fire on `start_date` and show until dismissed.     |
| `news`  | News article entries from `entries_news.json`.                            |
| `usenet`| Usenet posts imported via `import-usenet.mjs`.                            |

Pager is no longer a `media_items.format` — it lives in `pager_items` and rides the `pager`
subscription channel (see [`websocket-protocol.md`](./websocket-protocol.md)).

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
