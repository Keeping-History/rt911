# On-demand Usenet message bodies

**Date:** 2026-06-22
**Status:** Approved

## Problem

Every Usenet list frame ships full article bodies. The list views —
`CurrentUsenetItems` (backlog snapshot, up to 500 messages), `UsenetItemsInRange`
(per-tick forward window), and `OlderUsenetItems` (pagination) — all
`SELECT ui.body`, and the model serializes it as `body,omitempty`. The Newsgroups
app only shows subject/author/date in the list; the body is read only after a row
is double-clicked into a message window.

Bodies are also the documented reason the usenet channel bypasses Redis
(`packages/backend/CLAUDE.md` hard-rule #4: bodies are "far too large to warm into
the cache"). So they bloat both the wire (hundreds of bodies per frame) and the
per-tick Postgres query that serves the windowed delivery.

## Goal

Stop sending bodies in the list frames. Fetch a single message body on demand,
when the user opens its window. Cache fetched bodies for the session.

## Non-goals

- No new HTTP endpoint. The service is WS-only by rule
  (`CLAUDE.md`: no endpoints beyond `/stream` and `/health` without sign-off), so
  body-on-demand is a WS request/response pair, mirroring `usenet_more`.
- No change to threading, pagination, windowing, or the virtual-clock paths.
- No Redis caching of bodies — the whole point is to keep them off the hot path.

## Backend (`packages/backend`)

### 1. List queries drop the body

In `internal/db/postgres.go`:

- Add `usenetListSelectFrom` — identical to `usenetSelectFrom` but **without**
  `ui.body`.
- Add `queryUsenetListItems` — a scan helper that scans every field **except**
  body (the column count must match the select).
- `CurrentUsenetItems`, `OlderUsenetItems`, and `UsenetItemsInRange` switch to
  `usenetListSelectFrom` + `queryUsenetListItems`.
- `UsenetItemByID` keeps the full `usenetSelectFrom` + `queryUsenetItems` — it is
  the on-demand body path and must return the body.

The `Body` field stays on `model.UsenetItem`; with `json:"body,omitempty"` it
simply drops out of list frames once it is no longer populated.

> The small duplication between `queryUsenetItems` and `queryUsenetListItems` is
> deliberate and explicit — it matches the codebase's preference for clear,
> follow-the-pattern scan helpers over a column-count-conditional branch.

### 2. New `usenet_body` request/response

**Inbound (JSON text, `internal/handler/ws.go`):**

```json
{ "type": "usenet_body", "id": 12345 }
```

- New case in the `switch msg.Type` block; unmarshal into a
  `usenetBodyMsg { Type string; ID int }` struct (the `inMsg` envelope lacks `id`).
- Look up the row via `db.UsenetItemByID`.
- The inbound read limit (`conn.SetReadLimit(4096)`) is unaffected — the request
  is tiny.

**Outbound (binary MessagePack):**

Extend `outMsg` with two fields:

```go
ID   int    `json:"id,omitempty"`
Body string `json:"body,omitempty"`
```

- Success: `{ "type": "usenet_body", "id": 12345, "body": "..." }`.
- Not found / unapproved / query error: reply with empty body and the **existing**
  `message` field set, e.g.
  `{ "type": "usenet_body", "id": 12345, "message": "message unavailable" }`.
  This lets the client distinguish a failure (show an error line) from a genuinely
  empty body (show "(no body)").

Add `Session.SendUsenetBody(id int, body, errMsg string)` that builds the `outMsg`
and calls `send_`. It touches no shared session state, so it needs no `mu` lock
(consistent with the other `Send*` helpers' shape).

`UsenetItemByID` returns a row regardless of approval; the handler only serves
bodies for `Approved == 1`, otherwise sends the unavailable reply. In practice ids
always come from an already-approved list row, so this is a guard, not a hot path.

### Wire contract

| Direction | Frame |
|---|---|
| client → server | `{type:"usenet_body", id}` |
| server → client (ok) | `{type:"usenet_body", id, body}` |
| server → client (fail) | `{type:"usenet_body", id, message}` |

Document the new message in `packages/backend/docs/websocket-protocol.md` in the
same change (hard-rule #8: wire changes update protocol docs + frontend together).

## Frontend (`packages/frontend`)

### 3. Provider owns a body cache

In `Providers/MediaStream/MediaStreamContext.ts`:

- Remove `body` from the `UsenetItem` interface (list items no longer carry it).
- Add to the context value:
  - `usenetBodies: Record<number, string>` — fetched bodies by id.
  - `usenetBodyErrors: Record<number, string>` — failure messages by id.
  - `requestUsenetBody: (id: number) => void`.

In `Providers/MediaStream/MediaStreamProvider.tsx`:

- `requestUsenetBody(id)` no-ops if the id is already in `usenetBodies`,
  `usenetBodyErrors`, or an in-flight ref set; otherwise records it in-flight and
  sends `{type:"usenet_body", id}`.
- Handle the inbound `usenet_body` frame: clear the in-flight marker, then store
  `body` in `usenetBodies` (success) or `message` in `usenetBodyErrors` (failure).
- Bodies are immutable historical data; the cache is never invalidated for the
  session. On reconnect, in-flight requests that never resolved are dropped so the
  window can re-request lazily.

### 4. Newsgroups app fetches on open

In `Applications/Newsgroups/useNewsgroups.ts` — thread `usenetBodies`,
`usenetBodyErrors`, and `requestUsenetBody` through from context so the component
keeps its single hook entry point.

In `Applications/Newsgroups/Newsgroups.tsx`:

- When a message window opens (`openMessage`, or an effect keyed on
  `openMessages`), call `requestUsenetBody(m.id)`.
- The body area renders:
  - cached body present → the text;
  - error present → an error line (e.g. "Message unavailable.");
  - otherwise → "Loading message…".

## Testing

- **Backend:** unit-test that list queries no longer return body and that the
  `usenet_body` handler returns the body for an approved id and the unavailable
  reply for a missing/unapproved id (extend `session_test.go` patterns;
  `internal/db` tests as they exist for usenet queries).
- **Frontend:** `requestUsenetBody` dedupe (no duplicate sends for the same id);
  frame handling populates `usenetBodies` / `usenetBodyErrors`; the message window
  shows loading → body / error transitions.

## Risks

- An open window whose body request is lost (e.g. socket dropped mid-flight) stays
  on "Loading…". Mitigation: dropping in-flight markers on reconnect lets a
  re-render re-request; acceptable for an immutable historical archive.
- Removing `body` from the `UsenetItem` type is a breaking field change — but the
  frontend is the sole consumer and is updated in the same change (hard-rule #8).
