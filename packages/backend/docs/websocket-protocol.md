# WebSocket protocol

Wire-level reference for `/stream`. The protocol is **split by direction**:

- **Server → client** frames are **binary MessagePack** (`websocket.BinaryMessage`). `time.Time`
  fields are encoded with the msgpack timestamp extension; everything else uses the existing `json:`
  struct tags as field names (via `Encoder.SetCustomStructTag("json")`), so the wire keys are
  identical to the previous JSON encoding. There is no version handshake — the single consumer
  (`packages/frontend/`) decodes binary unconditionally (CLAUDE.md hard rule #8).
- **Client → server** frames stay **JSON-encoded text frames** — they are tiny and infrequent, so
  binary buys nothing. The read loop ignores frame type and unmarshals JSON.

The JSON shapes shown below describe the **logical** payload of each frame. Server→client examples
are the decoded form; on the wire they are MessagePack, with timestamps as the binary ext rather
than RFC3339 strings (the client's extension codec decodes them back to ISO strings).

---

## Connection

Endpoint: `ws://host:8080/stream` (plain WS) or `wss://…` behind TLS termination.

A browser client must set `ws.binaryType = "arraybuffer"` synchronously at construction so inbound
binary frames arrive as `ArrayBuffer` (not `Blob`) before the first frame can be delivered.

The handshake currently accepts every origin (`CheckOrigin: func(r) bool { return true }` in `internal/handler/ws.go`). Lock this down at the reverse proxy in production — there is no per-connection auth.

Once the upgrade succeeds, the server creates a `Session` and registers it with the `Hub`. The session has no virtual time until you `init`. Ticks before `init` are no-ops, so you have unbounded time to send the first message.

---

## Envelopes

### Client → server

Every client message is a JSON object with at least a `type` field. Additional fields depend on the type.

| Type          | Additional fields | Purpose                                       |
| ------------- | ----------------- | --------------------------------------------- |
| `init`        | `time`            | Set the virtual clock and request a snapshot. |
| `seek`        | `time`            | Move the virtual clock to a new instant.      |
| `heartbeat`   | `time`            | Report client's current virtual time.         |
| `filter`      | `formats[]`       | Whitelist media formats.                      |
| `subscribe`   | `channel`         | Opt into a side channel (`pager`/`mp3`/`news`/`usenet`/`flights`/`weather`). |
| `unsubscribe` | `channel`         | Leave a side channel.                         |
| `usenet_filter` | `newsgroups[]`  | Set the newsgroup(s) the client is viewing; the `usenet` channel delivers only these. |
| `usenet_more` | `newsgroups[]`, `before` | Request the page of messages older than `before` for the viewed group(s) (backlog pagination). |
| `usenet_body` | `id`              | Request the full body of one message by id (bodies are no longer in list frames). |
| `flights_history` | `minutes`, `id` | Request the trailing `minutes` (1-90; loop mode uses 30/90, the heading seed ~3) of flight positions. Requires an active `flights` subscription. `id` is echoed on every reply chunk. |
| `weather_forecast` | `zone`, `id` | Request the forecast product covering NWS UGC `zone` (e.g. `"NYZ076"`) at the client's virtual time. Requires an active `weather` subscription. `id` is echoed on the reply. |
| `pause`       | —                 | Stop advancing virtual time.                  |
| `resume`      | —                 | Resume advancing virtual time.                |

All unknown `type` values produce an `error` reply but do not terminate the session.

### Server → client

| Type              | Fields                        | When sent                                              |
| ----------------- | ----------------------------- | ------------------------------------------------------ |
| `init_ack`        | `time`, `items[]`             | Reply to `init`.                                       |
| `seek_ack`        | `time`, `items[]`             | Reply to `seek`.                                       |
| `heartbeat_ack`   | `time`, `master_time`         | Reply to `heartbeat`. `time` is server's vTime; `master_time` is present only while forced clock mode is active (see "Forced clock mode" below). |
| `clock`           | `active`, `time`              | Forced-clock state push: on connect and on every activate/jump/release (see "Forced clock mode" below). |
| `filter_ack`      | —                             | Reply to `filter`.                                     |
| `subscribe_ack`   | `channel`                     | Reply to `subscribe`.                                  |
| `unsubscribe_ack` | `channel`                     | Reply to `unsubscribe`.                                |
| `pause_ack`       | —                             | Reply to `pause`.                                      |
| `resume_ack`      | —                             | Reply to `resume`.                                     |
| `items`           | `time`, `items[]`             | A forward **window** of media items (default 300 s) sent when the session refills; client buffers and reveals each at its `start_date`. |
| `pager`           | `time`, `pager[]`             | Pager snapshot (on subscribe/init/seek) + a forward **window** (default 600 s) per refill while subscribed. Client reveal-gate preserves forward-only pacing. |
| `mp3`             | `time`, `items[]`             | mp3/Radio snapshot (items active at `t`) + a forward **window** (default 300 s) per refill while subscribed. Reuses the `items` field. |
| `mp3_history`     | `time`, `items[]`             | The **complete** mp3 back-catalogue up to `t` (every approved item with `start_date ≤ t`), sent with each mp3 snapshot (subscribe/init/seek). Backs the Radio app's "Previous" list. Replace client state wholesale — the frame is sent even when empty so a backward seek clears it. Not reveal-gated or retention-pruned. |
| `news`            | `time`, `items[]`             | News snapshot (active at `t` + 5-min instant lookback) + a forward **window** (default 600 s) per refill while subscribed. Reuses the `items` field. |
| `usenet`          | `time`, `usenet[]`            | Usenet messages for the viewed newsgroup(s): backlog snapshot (most recent ≤500 up to `t`) on subscribe/`usenet_filter`/init/seek, plus a forward **window** (default 600 s) per refill. Delivered **only** for the groups set via `usenet_filter`. |
| `flights`         | `time`, `flights[]`           | Flights snapshot (airborne picture covering `[t−90s, t]`) on subscribe/init/seek, plus a forward **window** (default 300 s) per refill while subscribed. |
| `flights_history` | `id`, `time`, `flights[]`, `done` | Chunked reply to a `flights_history` request (~10 minute-buckets per frame). The final frame carries `done: true` (and may be empty). `id` echoes the request. |
| `weather`         | `time`, `weather[]`, `weather_forecasts[]` | Weather snapshot (latest observation per station ≤ `t`, no age limit) on subscribe/init/seek, plus a forward **window** (default 600 s) per refill while subscribed — windowed observations plus any forecast products newly issued in the window. One frame carries both lists; suppressed when both are empty. |
| `weather_forecast` | `id`, `time`, `weather_forecasts[]` | Reply to `weather_forecast`: the forecast product covering the requested zone at the clock, or an explicit empty `weather_forecasts` when none exists. `id` echoes the request. |
| `usenet_filter_ack` | —                           | Reply to `usenet_filter`.                              |
| `usenet_body`     | `id`, `body` *or* `id`, `message` | Reply to `usenet_body`: the article body, or an empty body with `message` set when the id is missing/unapproved or the query fails. |
| `sources`         | `sources`                     | Sent once after `init_ack`: the time-independent set of selectable sources per filter (`sources.video`, `sources.pager`, `sources.usenet`). Not resent on `seek`. |
| `error`           | `message`                     | Reply to a malformed or unrecognised request.          |

The frame-level `time` field is a string (RFC3339 UTC, e.g. `"2001-09-11T08:46:00Z"`) in both the
logical and wire forms. The `time.Time` date fields **inside** `items[]`/`pager[]` (`start_date`,
`end_date`) ride the binary msgpack timestamp ext on the wire and decode to ISO strings on the
client. `items[]` and `pager[]` are documented in [`data-model.md`](./data-model.md).

---

## Look-ahead windowing (server pacing + client reveal gate)

The server does **not** send one frame per virtual second. Each channel sends a **forward window**
of upcoming items in a single frame, then stays silent until the window needs refilling. This cuts
each session's Redis lookups from 1/second to ~1/window and de-syncs the per-tick burst — the
scaling lever for thousands of concurrent sessions, each at its own (unpinned) virtual time.

- **Window sizes are per-channel** (server constants, not negotiated): media/mp3 = **300 s**,
  pager/news = **600 s**. A channel refills once the virtual clock comes within a **30 s lead** of
  the last window's upper edge, so the client's buffer never drains. Windows are half-open
  `[lo, hi)` and contiguous — no gaps, no cross-window duplicates.
- **A frame's `items[]`/`pager[]` therefore contains future-dated items**, not just items active
  at `time`. The client **must buffer** them keyed by `id` and surface each only when its virtual
  clock reaches the item's `start_date`. This client reveal-gate is what preserves the deliberately
  **forward-only** pager/news pacing — windowing moves *where* pacing happens (now client-side), it
  does not remove it. Do not hand windowed items to consumer apps until due.
- **`init_ack`/`seek_ack` snapshots are unchanged** — they carry the active-now overlap set (incl.
  the 5-min instant lookback) from Postgres so the client has immediate playable state. The first
  tick after init/seek then refills the forward window; a few boundary items may arrive twice
  (snapshot + first window), so the client **dedups by `id`**.
- **`seek`** (large jump) and **`filter`** change reset the relevant horizon server-side and the
  client clears the corresponding buffer, so stale-timeline / stale-filter future items never
  surface. **`pause`** freezes refills (the buffer stays valid); **`resume`** continues.
- **Window size is bounded only by client buffer memory, not freshness** — the dataset is purely
  historical and immutable, so there is no edit-staleness within a window. There is intentionally
  **no push-invalidation** of an in-flight window.

---

## Timestamp formats

The server parses incoming `time` strings with this fallback list (in order):

1. `time.RFC3339` — `2006-01-02T15:04:05Z07:00`
2. `2006-01-02T15:04:05` — naive ISO-8601, treated as UTC
3. `2006-01-02 15:04:05` — space-separated
4. `2006-01-02 15:04:05.000000` — microsecond precision

Out responses are always RFC3339. Prefer to send and parse RFC3339 — the fallbacks exist for compatibility with the seed scripts and Directus' historical exports.

---

## Messages — full reference

### `init`

Request:

```json
{ "type": "init", "time": "2001-09-11T08:46:00Z" }
```

Response:

```json
{
  "type": "init_ack",
  "time": "2001-09-11T08:46:00Z",
  "items": [ /* MediaItem[] currently active */ ]
}
```

Side effects:
- `Session.virtualTime` set to the provided instant.
- `Session.paused` set to `false`.
- Any previously-set format filter is preserved.

The `items` payload contains every approved row whose `[start_date, end_date]` interval contains `t`, **plus** every "instant" row (`start_date = end_date` or `calc_duration = 0`) whose `start_date` falls within `[t - 5m, t]`. See [`components/db.md`](./components/db.md) for the SQL.

### `seek`

Request:

```json
{ "type": "seek", "time": "2001-09-11T09:03:00Z" }
```

Response:

```json
{ "type": "seek_ack", "time": "2001-09-11T09:03:00Z", "items": [...] }
```

Behaves like `init` except it does not reset the pause state. Useful for jumping forward or backward without losing the user's pause.

### `heartbeat`

Request:

```json
{ "type": "heartbeat", "time": "2001-09-11T08:46:42Z" }
```

Response:

```json
{ "type": "heartbeat_ack", "time": "2001-09-11T08:46:42Z" }
```

If `|client_time - server_vTime| > 3 s`, the server adopts `client_time` as the new `virtualTime`. The reply's `time` always reflects the **server's** virtual time after the (possibly applied) correction — so the client can trust it as the authoritative value.

Send a heartbeat every 5–15 seconds from the client. Less frequent and drift becomes user-visible; more frequent is wasted bandwidth.

### Forced clock mode (server → client `clock`, `heartbeat_ack.master_time`)

An operator can force every client onto one master clock via the streamer's
key-guarded REST API (`POST /clock` — see SPEC.md). While active:

- On connect, and on every activate/jump/release, the server pushes:

```json
{ "type": "clock", "active": true, "time": "2001-09-11T13:03:00Z" }
```

  On release the frame is `{ "type": "clock", "active": false }` and clients
  keep ticking from wherever the master left them.

- Every `heartbeat_ack` carries the authoritative time while active:

```json
{ "type": "heartbeat_ack", "time": "2001-09-11T13:03:00Z", "master_time": "2001-09-11T13:03:00Z" }
```

  Clients treat `master_time` presence as the forced-mode signal and correct
  their clock when drift exceeds 2 s (a missed `clock` frame self-heals within
  one heartbeat interval).

- Client-supplied times on `init` and `seek` are clamped to the master time
  (the ack echoes the clamped time); `heartbeat` pins the session clock to
  master; `pause` is acked but not applied. Timezone display is client-local
  and unaffected.

### `filter`

Request:

```json
{ "type": "filter", "formats": ["mp4", "news"] }
```

Response:

```json
{ "type": "filter_ack" }
```

After this acks, every `init_ack`, `seek_ack`, and `items` frame contains only items whose `format` is in the whitelist. To clear the filter, send `formats: []` or `formats: null`.

The filter does not affect items already delivered — it's a forward-looking switch. If you want to refresh the visible set after changing the filter, issue a `seek` to the current virtual time.

The `filter` whitelist only ever applies to `items` (media) frames. Pager delivery is governed by `subscribe`/`unsubscribe`, not the format filter.

### `subscribe`

Request:

```json
{ "type": "subscribe", "channel": "pager" }
```

Response:

```json
{ "type": "subscribe_ack", "channel": "pager" }
```

Pager items live in their own table and are **not** delivered by default. After subscribing, the
server delivers them on the `pager` channel: an immediate boundary snapshot of the requested second
`[t, t+1s)` (if the session has been `init`ed), followed by **forward windows** (see
[Look-ahead windowing](#look-ahead-windowing-server-pacing--client-reveal-gate)) refilled as the
clock advances. Delivery is **forward-only** — no backward lookback. Although a window is sent ahead
in bulk on the wire, the **client reveal-gate** holds each page until its `start_date`, so pages
still render paced by the virtual clock rather than all at once. This pacing invariant is enforced
client-side; consumer apps never receive a not-yet-due page.

Valid channels are `"pager"`, `"mp3"`, `"news"`, `"usenet"`, `"flights"` and `"weather"`; any other
value yields `{"type":"error","message":"unknown channel \"…\""}`. (HTML is planned.)
Subscriptions are not remembered across reconnects — re-`subscribe` after reconnecting.

The `mp3` channel (Radio app) behaves the same but carries `MediaItem`s on `mp3`-typed frames
(reusing the `items` field), and — because mp3 is durational audio — its snapshot returns the
items **active at** `t` (`start_date ≤ t ≤ end_date`), not a single second, so the client can
resume the recording mid-file via the `jump` offset. Each mp3 snapshot is followed by an
`mp3_history` frame carrying **every** approved mp3 item with `start_date ≤ t` — the full past
schedule backing the Radio app's "Previous" list, which the live stream (active-only snapshots,
forward-only windows) never covers. The client replaces its history state wholesale per frame
(sent even when empty), and it is exempt from the reveal gate and retention pruning: history is
by definition already in the past.

The `news` channel (News app) likewise carries `MediaItem`s on `news`-typed frames. Most news is
instant, so its snapshot uses the media overlap-plus-5-minute-instant-lookback window — a seek to
`t` shows headlines from the preceding minutes.

The `flights` channel carries `FlightPosition`s on `flights`-typed frames (its own field, not a
reuse of `items`). Flight positions are per-minute aircraft samples, so — unlike pager's
single-second snapshot — the subscribe/init/seek snapshot covers the half-open window
`[t−90s, t+1s)`: any flight airborne at `t` has a sample within the preceding 90 seconds (positions
are recorded once a minute), so this window reconstructs the current airborne picture. The client
reveals it immediately since every row's `start_date ≤ t`. Forward refills use a 300 s window, same
as media. See [`flights` field reference](#server-initiated--snapshot-flights) below for the shape
of `FlightPosition`, and [`flight_tracks` is not streamed](#flight_tracks-is-not-on-the-wire) for how
per-flight route geometry is fetched instead.

The `weather` channel carries `WeatherObservation`s and `WeatherForecast`s on `weather`-typed frames
(its own `weather`/`weather_forecasts` fields, not a reuse of `items`). Observations are sparse —
one per station per hour, versus a media item every few seconds — so unlike pager/flights the
subscribe/init/seek **snapshot has no age limit**: it is the single most recent observation at or
before `t` for **every** station (a point-in-time `DISTINCT ON`), so a station that has been silent
for hours still shows its last reading, timestamped with its own `start_date` rather than `t`.
Forecast products are **not** part of the snapshot — they're delivered on demand only, via
`weather_forecast` below. Forward refills use a 600 s window (usenet/news scale, reflecting how
sparse the data is) and carry both the observations newly in-window and any forecast products newly
*issued* in that window, in a single frame; the frame is suppressed when both lists are empty. Like
`usenet`, the `weather` channel reads Postgres directly on the tick rather than Redis — observations
and forecasts are sparse enough that a Redis cache isn't worth building, so `Session` uses its
`*pgxpool.Pool` the same way (`packages/backend/CLAUDE.md` hard rule #4's usenet exception; weather
is a second exception under it). See [`weather` field reference](#server-initiated--snapshot-weather)
below for the frame shape, and [radar and almanac are not on the wire](#radar-and-almanac-are-not-on-the-wire)
for how the rest of the Weather app's data (map imagery, per-station normals) is fetched instead.

### `usenet_filter` and the `usenet` channel

The `usenet` channel (Newsgroups app) is unique in that it is **filtered server-side by newsgroup**.
A single newsgroup can hold millions of messages, so the channel delivers nothing until the client
declares which group(s) it is viewing:

```json
{ "type": "usenet_filter", "newsgroups": ["ntl.support.modems"] }
```

The server acks with `{"type":"usenet_filter_ack"}`, then (if subscribed) sends a **backlog snapshot**
— the most recent ≤500 messages in those group(s) with `start_date ≤ t` — so opening a group
immediately shows its history up to the virtual clock. As the clock advances, new messages arrive via
forward **windows** queried from that group's own time index. Selecting a different group resends the
backlog for the new group and restarts windowing; an empty `newsgroups` set delivers nothing. Each
message carries its `newsgroup`, `subject`, `author`, `references`/`in_reply_to`, and (once threaded)
`thread_id`/`parent_id` on `usenet`-typed frames in the `usenet` field.

To read **further back** than the initial ≤500, send `usenet_more` with the oldest `start_date` the
client holds as `before`; the server replies with the next ≤500 older messages on a normal `usenet`
frame (all are ≤ the clock, so the client merges them straight in). Unlike the other channels, the
usenet channel reads Postgres directly — bodies are too large to cache in Redis, and (per the next
paragraph) are not sent in list frames at all but fetched on demand via `usenet_body`.

Message **bodies are not included in `usenet` list frames** (snapshot, window, or
`usenet_more` page) — those carry only headers (subject/author/date/threading).
To read a message, send `usenet_body` with its `id`; the server replies on a
`usenet_body` frame with `{id, body}`, or `{id, message}` (empty body) when the id
is missing/unapproved or the query fails. This keeps list frames small and the
per-tick Postgres window cheap.

### `sources`

Sent once, unprompted, right after `init_ack` (and again after any reconnect's
`init_ack`). Carries the **time-independent** set of selectable sources for each
client-side filter, so a filter UI can list every option up front instead of only
those that have scrolled past in the current virtual-time window.

```json
{
  "type": "sources",
  "sources": {
    "video": ["BBC", "CNN", "MSNBC", "WETA"],
    "audio": ["ATC", "Rutgers"],
    "pager": ["Arch", "Skytel"],
    "usenet": [{"name": "ntl.support.modems", "count": 1234}, {"name": "ntl.talk", "count": 56}]
  }
}
```

- `video` — source slugs with at least one approved `m3u8` media item (the TV app's channel filter).
- `audio` — source slugs with at least one approved mp3 item (the RadioScanner app's station strip).
- `pager` — providers across all approved pager items (the Pager app's provider filter).
- `usenet` — newsgroups (sources of type `usenet`) with a precomputed `count`, for the Newsgroups app's browse list.

Each list is derived from **actual usage** in its table: the `sources` table does not record which
media type a source belongs to, so membership is inferred from the rows that reference it. The lists
do not depend on the virtual clock, so `seek` does not resend them.

### `unsubscribe`

Request:

```json
{ "type": "unsubscribe", "channel": "pager" }
```

Response:

```json
{ "type": "unsubscribe_ack", "channel": "pager" }
```

Pager frames stop after the ack.

### Server-initiated / snapshot `pager`

```json
{
  "type": "pager",
  "time": "2001-09-11T12:46:01Z",
  "pager": [
    {
      "id": 99821,
      "start_date": "2001-09-11T12:46:01Z",
      "provider": "Metrocall",
      "recipient_id": "1060278",
      "id_type": "",
      "channel": "B",
      "mode": "ALPHA",
      "message": "Service is not responding. Stopped.",
      "approved": 1
    }
  ]
}
```

Like `items`, `pager` frames are sent once per **window refill** (not per second) and only when the
window contains at least one pager item — empty windows produce no frame. The `pager[]` payload is a
forward window the client reveal-gates by `start_date`, and mirrors `internal/model/pager.go`.

### Server-initiated / snapshot `flights`

```json
{
  "type": "flights",
  "time": "2001-09-11T08:46:01Z",
  "flights": [
    {
      "id": 44219,
      "flight": "AA11",
      "carrier": "AA",
      "start_date": "2001-09-11T08:46:00Z",
      "lat": 40.7128,
      "lon": -73.9931,
      "alt_ft": 30575,
      "phase": "enroute",
      "diverted": false
    }
  ]
}
```

`FlightPosition` fields (mirrors `internal/model/flight.go`):

| Field        | Type      | Notes                                                        |
| ------------ | --------- | ------------------------------------------------------------- |
| `id`         | int       | Row id (`flight_positions.id`).                                |
| `flight`     | string    | Flight number, e.g. `"AA11"`.                                  |
| `carrier`    | string?   | Omitted when empty.                                            |
| `start_date` | timestamp | The sample's UTC instant (`flight_positions.utc`); instant, no `end_date` — like pager. |
| `lat`        | float     | Degrees.                                                       |
| `lon`        | float     | Degrees.                                                       |
| `alt_ft`     | int       | Altitude in feet.                                              |
| `phase`      | string?   | `taxi` / `climb` / `enroute` / `descent` / … Omitted when empty. |
| `diverted`   | bool?     | Omitted when `false`.                                          |

Like `pager`/`mp3`/`news`, `flights` frames are sent once per **window refill** and only when the
window (or snapshot) contains at least one position — empty batches produce no frame. Because the
snapshot window `[t−90s, t+1s)` and the first forward window can both contain a flight's most
recent sample, the client must **dedup by `id`** in
addition to the reveal-gate it already applies to pager/media items.

`run_id`, `et_seconds`, `clock_seconds`, and `flight_date` (pipeline provenance from
`packages/tools/flight-recon`) are deliberately not on the wire — the client never needs them.

### `flights_history` (loop-mode history / heading seed)

Request:

```json
{ "type": "flights_history", "minutes": 30, "id": 4 }
```

`minutes` must be between 1 and 90 inclusive (anything else yields an `error` frame).
The Flight Tracker's loop mode requests 30 or 90; its heading seed — issued
automatically on subscribe/seek/reconnect so single-sample flights get a previous
minute-bucket to derive a heading from, instead of rendering due north for their
first minute — requests a few minutes (currently 3). The two request kinds share
this message type and are told apart client-side purely by the echoed `id`. The
request is silently ignored without an active `flights` subscription or before the
virtual clock is initialised. The server reads the minute buckets covering `[clock − minutes, clock]`
from the flight cache and streams them as `flights_history` frames of ~10 buckets each —
one 90-minute window is ~150k positions, far too large for a single frame. Every frame
echoes the request `id`; a client that issues a new request (window change, seek,
reconnect) bumps its `id` and discards stale chunks. The final frame carries
`done: true` and no positions:

```json
{ "type": "flights_history", "id": 4, "time": "2001-09-11T13:00:00Z", "done": true }
```

Elements of `flights[]` are the same `FlightPosition` shape as `flights` frames
(see the field table above).

#### `flight_tracks` is not on the wire

Per-flight route geometry (`flight_tracks.geometry`, a GeoJSON LineString) is **not** part of the
`flights` channel. It's static per-flight metadata, not a time-windowed stream, so apps that need a
flight's full track (e.g. drawing a route on a map) fetch it on demand from Directus REST —
`GET /items/flight_tracks?filter[flight][_eq]=AA11` — rather than having the streamer replay it.

### Server-initiated / snapshot `weather`

```json
{
  "type": "weather",
  "time": "2001-09-11T08:51:00Z",
  "weather": [
    {
      "id": 88213,
      "station_id": "KLGA",
      "start_date": "2001-09-11T08:51:00Z",
      "temp_c": 22.8,
      "dewpoint_c": 15.6,
      "wind_dir_deg": 250,
      "wind_speed_kt": 8,
      "pressure_hpa": 1015.2,
      "sky_condition": "CLR",
      "visibility_km": 16.1,
      "raw_metar": "KLGA 110851Z 25008KT 10SM CLR 23/16 A2998"
    }
  ],
  "weather_forecasts": [
    {
      "id": 512,
      "wfo": "OKX",
      "zone": "NYZ072,NYZ073,NYZ076",
      "product_type": "ZFP",
      "start_date": "2001-09-11T08:35:00Z",
      "raw_text": "NEW YORK CITY ZONE FORECAST PRODUCT..."
    }
  ]
}
```

`WeatherObservation` fields (mirrors `internal/model/weather.go`; field names are its `json` tags):

| Field           | Type      | Notes                                                                 |
| --------------- | --------- | ---------------------------------------------------------------------- |
| `id`            | int       | Row id (`weather_observations.id`).                                    |
| `station_id`    | string    | Station identifier (`weather_stations.station_id`), e.g. `"KLGA"`.     |
| `start_date`    | timestamp | `observed_at`, UTC.                                                    |
| `temp_c`        | float?    | **Absent when the station didn't report it** — not COALESCEd to 0.     |
| `dewpoint_c`    | float?    | Absent when not reported.                                              |
| `wind_dir_deg`  | int?      | Absent when not reported.                                              |
| `wind_speed_kt` | float?    | Absent when not reported. A real `0` kt is sent as `0`, distinguishable from absence. |
| `gust_kt`       | float?    | Absent when not reported.                                              |
| `pressure_hpa`  | float?    | Absent when not reported.                                              |
| `sky_condition` | string?   | Absent when empty.                                                     |
| `present_weather` | string? | Absent when empty.                                                     |
| `visibility_km` | float?    | Absent when not reported.                                              |
| `raw_metar`     | string?   | Absent when empty; the raw encoded METAR/SPECI line.                   |

`WeatherObservation`'s nullable numeric fields scan as Go pointers (`*float64`/`*int`) rather than
being COALESCEd to `0` in SQL, and the wire encoding (msgpack `omitempty` via the `json` struct tag)
drops the field entirely when the pointer is `nil` — so "not reported" and "reported as zero" stay
distinguishable on the wire, not just in Postgres.

`WeatherForecast` fields (mirrors `internal/model/weather.go`):

| Field          | Type      | Notes                                                              |
| -------------- | --------- | -------------------------------------------------------------------- |
| `id`           | int       | Row id (`weather_forecasts.id`).                                     |
| `wfo`          | string    | Issuing NWS Weather Forecast Office, e.g. `"OKX"`.                    |
| `zone`         | string    | Comma-joined 6-char UGC zone ids the product covers, e.g. `"NYZ072,NYZ073,NYZ076"`. |
| `product_type` | string    | e.g. `"ZFP"`, `"AFD"`.                                                |
| `start_date`   | timestamp | `issued_at`, UTC.                                                    |
| `raw_text`     | string    | The full archived forecast text.                                     |

Like `pager`/`flights`, `weather` frames are sent once per **window refill** (or snapshot) and only
when at least one of `weather[]`/`weather_forecasts[]` is non-empty — an empty batch on both produces
no frame. Because the subscribe/init/seek snapshot and the first forward window can both cover a
station's most recent observation, the client should **dedup by `id`**, same as `flights`.

### `weather_forecast`

Request:

```json
{ "type": "weather_forecast", "zone": "NYZ076", "id": 7 }
```

`zone` must match `^[A-Z]{2}Z\d{3}$` (an NWS UGC zone code, validated server-side before it ever
reaches a SQL `LIKE` clause). If the zone fails that pattern, **or** the session has no active
`weather` subscription, the request is **silently dropped** — no reply, no `error` frame — mirroring
`flights_history`'s silent-drop gating for an unsubscribed request; neither condition is something
the user needs surfaced as an error.

A valid, subscribed request always gets a reply on `weather_forecast`, echoing `id`:

```json
{
  "type": "weather_forecast",
  "id": 7,
  "time": "2001-09-11T08:51:00Z",
  "weather_forecasts": [ { "id": 512, "wfo": "OKX", "zone": "NYZ072,NYZ073,NYZ076", "product_type": "ZFP", "start_date": "2001-09-11T08:35:00Z", "raw_text": "..." } ]
}
```

When no forecast product covers the zone at or before the client's virtual time, the reply is still
sent, with `weather_forecasts` empty/omitted:

```json
{ "type": "weather_forecast", "id": 7, "time": "2001-09-11T08:51:00Z" }
```

This is an **explicit** "no forecast for this zone yet" answer, not silence — unlike the
unsubscribed/invalid-zone case above, a request that clears both gates always resolves the client's
`id`, so "no product" and "still waiting" are never ambiguous.

The zone lookup is a **containment** match, not an exact-string match: a forecast product's `zone`
column holds a comma-joined list of every UGC zone it covers (e.g. `"NYZ072,NYZ073,NYZ076"`), and the
server matches the requested zone as a substring of that list (`zone LIKE '%'||$1||'%'`), picking the
most recently issued match at or before the clock. Each UGC zone id is a fixed 6 characters, so a
prefix/suffix collision across adjacent zone ids in the joined list is not possible. The Weather app
determines *which* zone to request by reading its selected station's `nws_zone` column from the
`weather_stations` Directus collection — that mapping is static reference data, not part of this
wire protocol.

#### Radar and almanac are not on the wire

NEXRAD radar composite imagery and per-station almanac (normals/records) are **not** part of the
`weather` channel, or any WebSocket frame — like `flight_tracks`, they're static per-instant or
per-station assets, not a time-windowed stream of database rows. `packages/tools/weather-recon`
mirrors radar composites into Wasabi under `weather/radar/`, alongside an `index.json` manifest
(mosaic bounds, the frame list, and any gaps) that the client uses to compute the frame URL for a
given virtual-clock 5-minute bucket, served through `files.911realtime.org/weather/...` — the same
static-asset path every other media type in this repo uses (see the top-level CLAUDE.md's "Media
assets live outside this repo"). Almanac data follows the same pattern (one static JSON per station).
See `plans/weather-app-design.md` for the full pipeline/frontend design and
`packages/tools/weather-recon/README.md` for the shipped/pending pipeline phases.

### `pause`

Request:

```json
{ "type": "pause" }
```

Response:

```json
{ "type": "pause_ack" }
```

Side effect: `Session.paused = true`. Ticks are still received by the session goroutine but `RunTimePump` skips advancing virtual time and skips item lookup. The server stops sending `items` frames.

### `resume`

Request:

```json
{ "type": "resume" }
```

Response:

```json
{ "type": "resume_ack" }
```

Side effect: `Session.paused = false`. Virtual time resumes advancing on the next tick.

### Server-initiated `items`

Sent by the server, not in response to any client message:

```json
{
  "type": "items",
  "time": "2001-09-11T08:46:01Z",
  "items": [
    {
      "id": 12345,
      "title": "ABC News special report",
      "start_date": "2001-09-11T08:46:01Z",
      "end_date": null,
      "format": "pager",
      "url": "...",
      "...": "..."
    }
  ]
}
```

`items` frames are sent once per **window refill** (roughly every `windowSeconds − lead`, ~270 s by
default), carrying the forward window of media items that survive the format filter. An empty window
produces no frame. The client buffers the window and reveals each item at its `start_date`.

### `error`

Sent in reply to any client message that:

- Was not valid JSON (`"malformed message"`).
- Had an unparseable `time` (`"invalid time: ..."`).
- Had an unknown `type` (`unknown message type "foo"`).
- Could not be processed internally (`"internal error"`).

Example:

```json
{ "type": "error", "message": "invalid time: cannot parse \"yesterday\" as a timestamp" }
```

Errors are advisory — the session continues. Clients should surface them to logs (and possibly to the user) but should not reconnect on every error.

---

## Keep-alive

The server pings clients every 30 seconds (`websocket.PingMessage`). Browsers reply with pong automatically. The read deadline is **120 seconds** — if no pong (or any other inbound message) arrives in that window, the read pump exits and the session ends.

Write deadlines on every send are 10 seconds. Slow writes terminate the session.

If you build a non-browser client, install a pong handler that resets the read deadline. The reference client (`packages/frontend/`) lets the browser handle this transparently.

---

## End-to-end example

```text
client> {"type":"filter","formats":["pager"]}
server> {"type":"filter_ack"}

client> {"type":"init","time":"2001-09-11T08:46:00Z"}
server> {"type":"init_ack","time":"2001-09-11T08:46:00Z","items":[<active-now snapshot>]}

  ... first tick refills the forward window in ONE frame ...
server> {"type":"items","time":"2001-09-11T08:46:01Z","items":[<every media item in [08:46:00, 08:51:01)>]}

  ... the client buffers that window and reveals each item at its start_date ...
  ... no further frames until the clock nears the window's edge (~270 s later) ...

client> {"type":"heartbeat","time":"2001-09-11T08:46:06Z"}
server> {"type":"heartbeat_ack","time":"2001-09-11T08:46:06Z"}

client> {"type":"pause"}
server> {"type":"pause_ack"}

  ... wall time continues; virtual time frozen; no items frames ...

client> {"type":"resume"}
server> {"type":"resume_ack"}
```

---

## Error scenarios — what the client should do

| Server says                                                | Likely cause                                    | Recommended client action          |
| ---------------------------------------------------------- | ----------------------------------------------- | ---------------------------------- |
| `{"type":"error","message":"malformed message"}`           | Bad JSON encoding on your side                  | Log + fix the offending sender     |
| `{"type":"error","message":"invalid time: ..."}`           | Timestamp couldn't be parsed                    | Reformat as RFC3339 and retry      |
| `{"type":"error","message":"unknown message type \"x\""}`  | Typo or unsupported feature                     | Log + fall back if optional        |
| `{"type":"error","message":"internal error"}`              | Postgres query failed during init/seek          | Retry once after a backoff         |
| WebSocket closes unexpectedly                              | Network, server restart, or slow-client timeout | Reconnect with exponential backoff |
