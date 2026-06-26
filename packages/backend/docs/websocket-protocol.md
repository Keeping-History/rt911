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
| `subscribe`   | `channel`         | Opt into a side channel (`pager`/`mp3`/`news`/`usenet`). |
| `unsubscribe` | `channel`         | Leave a side channel.                         |
| `usenet_filter` | `newsgroups[]`  | Set the newsgroup(s) the client is viewing; the `usenet` channel delivers only these. |
| `usenet_more` | `newsgroups[]`, `before` | Request the page of messages older than `before` for the viewed group(s) (backlog pagination). |
| `usenet_body` | `id`              | Request the full body of one message by id (bodies are no longer in list frames). |
| `pause`       | —                 | Stop advancing virtual time.                  |
| `resume`      | —                 | Resume advancing virtual time.                |

All unknown `type` values produce an `error` reply but do not terminate the session.

### Server → client

| Type              | Fields                        | When sent                                              |
| ----------------- | ----------------------------- | ------------------------------------------------------ |
| `init_ack`        | `time`, `items[]`             | Reply to `init`.                                       |
| `seek_ack`        | `time`, `items[]`             | Reply to `seek`.                                       |
| `heartbeat_ack`   | `time`                        | Reply to `heartbeat`. `time` is server's vTime.        |
| `filter_ack`      | —                             | Reply to `filter`.                                     |
| `subscribe_ack`   | `channel`                     | Reply to `subscribe`.                                  |
| `unsubscribe_ack` | `channel`                     | Reply to `unsubscribe`.                                |
| `pause_ack`       | —                             | Reply to `pause`.                                      |
| `resume_ack`      | —                             | Reply to `resume`.                                     |
| `items`           | `time`, `items[]`             | A forward **window** of media items (default 300 s) sent when the session refills; client buffers and reveals each at its `start_date`. |
| `pager`           | `time`, `pager[]`             | Pager snapshot (on subscribe/init/seek) + a forward **window** (default 600 s) per refill while subscribed. Client reveal-gate preserves forward-only pacing. |
| `mp3`             | `time`, `items[]`             | mp3/Radio snapshot (items active at `t`) + a forward **window** (default 300 s) per refill while subscribed. Reuses the `items` field. |
| `news`            | `time`, `items[]`             | News snapshot (active at `t` + 5-min instant lookback) + a forward **window** (default 600 s) per refill while subscribed. Reuses the `items` field. |
| `usenet`          | `time`, `usenet[]`            | Usenet messages for the viewed newsgroup(s): backlog snapshot (most recent ≤500 up to `t`) on subscribe/`usenet_filter`/init/seek, plus a forward **window** (default 600 s) per refill. Delivered **only** for the groups set via `usenet_filter`. |
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

Valid channels are `"pager"`, `"mp3"`, `"news"` and `"usenet"`; any other value yields
`{"type":"error","message":"unknown channel \"…\""}`. (HTML is planned.)
Subscriptions are not remembered across reconnects — re-`subscribe` after reconnecting.

The `mp3` channel (Radio app) behaves the same but carries `MediaItem`s on `mp3`-typed frames
(reusing the `items` field), and — because mp3 is durational audio — its snapshot returns the
items **active at** `t` (`start_date ≤ t ≤ end_date`), not a single second, so the client can
resume the recording mid-file via the `jump` offset.

The `news` channel (News app) likewise carries `MediaItem`s on `news`-typed frames. Most news is
instant, so its snapshot uses the media overlap-plus-5-minute-instant-lookback window — a seek to
`t` shows headlines from the preceding minutes.

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
