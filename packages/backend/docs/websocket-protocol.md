# WebSocket protocol

Wire-level reference for `/stream`. All frames are JSON-encoded text frames. Binary frames are not used.

---

## Connection

Endpoint: `ws://host:8080/stream` (plain WS) or `wss://…` behind TLS termination.

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
| `subscribe`   | `channel`         | Opt into an opt-in side channel (`pager`).    |
| `unsubscribe` | `channel`         | Leave a side channel.                         |
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
| `items`           | `time`, `items[]`             | Each tick that produces ≥ 1 media item after filtering.|
| `pager`           | `time`, `pager[]`             | Pager snapshot (on subscribe/init/seek) and each tick that produces ≥ 1 pager item while subscribed. |
| `error`           | `message`                     | Reply to a malformed or unrecognised request.          |

All `time` values are RFC3339 UTC (e.g. `"2001-09-11T08:46:00Z"`). `items[]` and `pager[]` are documented in [`data-model.md`](./data-model.md).

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
server delivers them on the `pager` channel: an immediate snapshot (the 5-minute lookback window
at the current virtual time, if the session has been `init`ed) followed by one `pager` frame per
virtual second that produces pager traffic.

`"pager"` is currently the only valid channel; any other value yields
`{"type":"error","message":"unknown channel \"…\""}`. (News, MP3, and HTML channels are planned.)
Subscriptions are not remembered across reconnects — re-`subscribe` after reconnecting.

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

Like `items`, `pager` frames are sent at most once per virtual second and only when at least one
pager item is present — empty seconds produce no frame. The `pager[]` payload mirrors
`internal/model/pager.go`.

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

`items` frames are sent at most once per virtual second, and only when at least one item survives the format filter. Empty seconds produce no frame.

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
server> {"type":"init_ack","time":"2001-09-11T08:46:00Z","items":[<2 instant pager items from lookback>]}

  ... 1 second wall time passes ...
server> {"type":"items","time":"2001-09-11T08:46:01Z","items":[<pager msg fired this second>]}

  ... 5 seconds pass with no pager traffic ...
  (no frames sent — silence is meaningful)

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
