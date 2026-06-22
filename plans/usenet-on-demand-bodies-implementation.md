# On-demand Usenet Message Bodies — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop shipping Usenet article bodies in list frames; fetch a single body on demand when a message window opens, cached for the session.

**Architecture:** Backend adds a `usenet_body` WS request/response pair (no new HTTP endpoint) and drops `body` from the three list queries while `UsenetItemByID` keeps it for the on-demand fetch. Frontend gains a provider-owned body cache (`usenetBodies`/`usenetBodyErrors` + `requestUsenetBody`) and the Newsgroups app fetches a body when its window opens, showing a loading placeholder until it arrives.

**Tech Stack:** Go (gorilla/websocket, pgx, msgpack), React + TypeScript, Vitest. Server→client frames are binary MessagePack; client→server frames are JSON text.

**Spec:** `plans/usenet-on-demand-bodies.md`

## Global Constraints

- Server→client output is binary MessagePack via `Session.send_` / `encodeMsg`; never `websocket.TextMessage` or `json.Marshal` on the outbound path. (backend CLAUDE.md hard-rule #8)
- Client→server input stays JSON text (`json.Unmarshal` in `ws.go`).
- No new HTTP endpoint; body-on-demand is a WS message pair. (backend CLAUDE.md)
- Wire-protocol changes update `packages/backend/docs/websocket-protocol.md` AND the frontend in the same change. (hard-rule #8)
- `slog` only in Go; structured keys, not formatted strings.
- Frontend `tsconfig.json` has `noUnusedLocals`/`noUnusedParameters` — no unused destructures or imports.
- All Go times are UTC `time.Time`; wire is RFC3339.
- Inbound read limit is 4096 bytes (`conn.SetReadLimit(4096)`) — the `usenet_body` request is tiny and stays well under it.

---

### Task 1: Backend — `usenet_body` request/response

**Files:**
- Modify: `packages/backend/internal/session/session.go` (`outMsg` struct ~lines 64–74; add `SendUsenetBody` near `SendUsenet` ~line 280)
- Modify: `packages/backend/internal/handler/ws.go` (add `usenetBodyMsg` struct near the other inbound structs ~lines 46–59; add a `case "usenet_body"` in the `switch msg.Type` block ~after the `usenet_more` case at line 198; add a `sendUsenetBody` helper near `sendUsenetOlder` ~line 335)
- Modify: `packages/backend/docs/websocket-protocol.md` (client→server table ~line 47; server→client table ~line 70; reference section ~line 240)
- Test: `packages/backend/internal/session/session_test.go`

**Interfaces:**
- Produces:
  - `outMsg` gains `ID int \`json:"id,omitempty"\`` and `Body string \`json:"body,omitempty"\``.
  - `func (s *Session) SendUsenetBody(id int, body, errMsg string)` — emits `{type:"usenet_body", id, body}` on success, or `{type:"usenet_body", id, message:errMsg}` when `errMsg != ""` (body left empty). No `mu` lock (touches no shared state, like the other `Send*` helpers).
  - WS request `{type:"usenet_body", id:<int>}` handled by reading the row via existing `db.UsenetItemByID(ctx, pool, id)` and replying via `SendUsenetBody`.
- Consumes: existing `db.UsenetItemByID(ctx, pool, id) (*model.UsenetItem, error)` (returns row regardless of approval, or nil if absent).

- [ ] **Step 1: Write the failing test**

Add to `packages/backend/internal/session/session_test.go`:

```go
// SendUsenetBody emits the single-body frame with id + body, no other payload.
func TestSendUsenetBodyEmitsBodyFrame(t *testing.T) {
	s := newTestSession(t)

	s.SendUsenetBody(7001, "Hello, world.\n", "")

	m := recvType(t, s)
	if m.Type != "usenet_body" {
		t.Fatalf("expected usenet_body frame, got %q", m.Type)
	}
	if m.ID != 7001 || m.Body != "Hello, world.\n" {
		t.Fatalf("unexpected body frame: id=%d body=%q", m.ID, m.Body)
	}
	if m.Msg != "" {
		t.Fatalf("success frame must not carry an error message, got %q", m.Msg)
	}
	if len(m.Usenet) != 0 || len(m.Items) != 0 {
		t.Fatalf("body frame must not carry list payloads, got usenet=%+v items=%+v", m.Usenet, m.Items)
	}
}

// On failure the frame carries the error message and an empty body, so the
// client can distinguish "unavailable" from a genuinely empty body.
func TestSendUsenetBodyEmitsErrorFrame(t *testing.T) {
	s := newTestSession(t)

	s.SendUsenetBody(7002, "", "message unavailable")

	m := recvType(t, s)
	if m.Type != "usenet_body" || m.ID != 7002 {
		t.Fatalf("unexpected frame: %+v", m)
	}
	if m.Body != "" || m.Msg != "message unavailable" {
		t.Fatalf("expected empty body + error message, got body=%q msg=%q", m.Body, m.Msg)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/backend && go test ./internal/session/ -run TestSendUsenetBody -v`
Expected: compile failure — `s.SendUsenetBody undefined` and `m.ID`/`m.Body` undefined fields on `outMsg`.

- [ ] **Step 3: Add the `outMsg` fields**

In `packages/backend/internal/session/session.go`, extend the `outMsg` struct:

```go
// outMsg is the envelope for every server→client message.
type outMsg struct {
	Type    string             `json:"type"`
	Time    string             `json:"time,omitempty"`
	Channel string             `json:"channel,omitempty"`
	Items   []model.MediaItem  `json:"items,omitempty"`
	Pager   []model.PagerItem  `json:"pager,omitempty"`
	Usenet  []model.UsenetItem `json:"usenet,omitempty"`
	Sources *SourceList        `json:"sources,omitempty"`
	Msg     string             `json:"message,omitempty"`
	// ID/Body carry a single on-demand Usenet article body (usenet_body frame).
	ID   int    `json:"id,omitempty"`
	Body string `json:"body,omitempty"`
}
```

- [ ] **Step 4: Add `SendUsenetBody`**

In `packages/backend/internal/session/session.go`, immediately after `SendUsenet`:

```go
// SendUsenetBody delivers a single article body in reply to a usenet_body request.
// On success errMsg is "" and body carries the text; on failure errMsg explains why
// and body is empty, letting the client tell "unavailable" apart from an empty body.
// Touches no shared state, so no lock — same shape as the other Send* helpers.
func (s *Session) SendUsenetBody(id int, body, errMsg string) {
	s.send_(outMsg{Type: "usenet_body", ID: id, Body: body, Msg: errMsg})
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/backend && go test ./internal/session/ -run TestSendUsenetBody -v`
Expected: PASS (both tests).

- [ ] **Step 6: Add the handler request struct, helper, and switch case**

In `packages/backend/internal/handler/ws.go`, add the inbound struct near `usenetMoreMsg`:

```go
// usenetBodyMsg requests the full body of one archived message by id. The body is
// no longer carried in list frames; the client fetches it when a message opens.
type usenetBodyMsg struct {
	Type string `json:"type"`
	ID   int    `json:"id"`
}
```

Add the `sendUsenetBody` helper near `sendUsenetOlder`:

```go
// sendUsenetBody fetches one message's body by id and replies on the usenet_body
// frame. Only approved messages are served; a missing/unapproved id or a query
// error sends an empty body with an explanatory message so the client shows an
// error line rather than hanging on "loading". No-ops if not subscribed to usenet.
func sendUsenetBody(r *http.Request, sess *session.Session, pool *pgxpool.Pool, id int, logger *slog.Logger) {
	if !sess.Subscribed(session.ChannelUsenet) {
		return
	}
	item, err := db.UsenetItemByID(r.Context(), pool, id)
	if err != nil {
		logger.Warn("usenet body query failed", "id", id, "error", err)
		sess.SendUsenetBody(id, "", "message unavailable")
		return
	}
	if item == nil || item.Approved != 1 {
		sess.SendUsenetBody(id, "", "message unavailable")
		return
	}
	sess.SendUsenetBody(id, item.Body, "")
}
```

Add the switch case after the `usenet_more` case:

```go
		case "usenet_body":
			var umsg usenetBodyMsg
			if err := json.Unmarshal(raw, &umsg); err != nil {
				sess.SendError("malformed usenet_body message")
				continue
			}
			sendUsenetBody(r, sess, pool, umsg.ID, logger)
```

- [ ] **Step 7: Update the protocol doc**

In `packages/backend/docs/websocket-protocol.md`:

Client→server table (after the `usenet_more` row, ~line 47):

```
| `usenet_body` | `id`              | Request the full body of one message by id (bodies are no longer in list frames). |
```

Server→client table (after the `usenet_filter_ack` row, ~line 70):

```
| `usenet_body`     | `id`, `body` *or* `id`, `message` | Reply to `usenet_body`: the article body, or an empty body with `message` set when the id is missing/unapproved or the query fails. |
```

In the reference section after the `usenet_more` paragraph (~line 261), add:

```markdown
Message **bodies are not included in `usenet` list frames** (snapshot, window, or
`usenet_more` page) — those carry only headers (subject/author/date/threading).
To read a message, send `usenet_body` with its `id`; the server replies on a
`usenet_body` frame with `{id, body}`, or `{id, message}` (empty body) when the id
is missing/unapproved or the query fails. This keeps list frames small and the
per-tick Postgres window cheap.
```

- [ ] **Step 8: Verify build, vet, and the full session suite**

Run: `cd packages/backend && go build ./... && go vet ./... && go test ./internal/session/ -v`
Expected: build/vet clean; all session tests PASS (existing + the two new ones).

- [ ] **Step 9: Commit**

```bash
git add packages/backend/internal/session/session.go packages/backend/internal/handler/ws.go packages/backend/internal/session/session_test.go packages/backend/docs/websocket-protocol.md
git commit -m "feat(usenet): add usenet_body request/response for on-demand bodies

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Backend — drop `body` from the list queries

**Files:**
- Modify: `packages/backend/internal/db/postgres.go` (`usenetSelectFrom` ~lines 288–293; `CurrentUsenetItems` ~321; `OlderUsenetItems` ~335; `UsenetItemsInRange` ~356; `queryUsenetItems` ~395)

**Interfaces:**
- Consumes: existing `model.UsenetItem`, `derefStr`.
- Produces:
  - `usenetListSelectFrom` — same as `usenetSelectFrom` minus the `ui.body` column.
  - `queryUsenetListItems(ctx, pool, q, args...) ([]model.UsenetItem, error)` — scans every field except `Body` (column count matches `usenetListSelectFrom`); leaves `Body` zero-valued.
  - `CurrentUsenetItems`, `OlderUsenetItems`, `UsenetItemsInRange` now return items with empty `Body`.
  - `UsenetItemByID` unchanged — still uses `usenetSelectFrom` + `queryUsenetItems` and returns the body.

> No db-layer unit test exists in this package (it needs a live Postgres); verification is build + vet + grep, plus the Task 1 session suite still passing. This is consistent with the package's current test surface.

- [ ] **Step 1: Add the body-less select constant**

In `packages/backend/internal/db/postgres.go`, immediately after the existing `usenetSelectFrom` block:

```go
// usenetListSelectFrom mirrors usenetSelectFrom without ui.body: list views
// (snapshot/window/pagination) carry only headers. The body is fetched on demand
// per message via UsenetItemByID — see plans/usenet-on-demand-bodies.md.
const usenetListSelectFrom = `
	SELECT ui.id, ui.start_date, s.slug, ui.subject, ui.author,
	       ui.message_id, ui."references", ui.in_reply_to, ui.thread_id,
	       ui.parent_id, ui.date_source, ui.approved
	FROM usenet_items ui
	LEFT JOIN sources s ON s.id = ui.source`
```

- [ ] **Step 2: Add the body-less scan helper**

In `packages/backend/internal/db/postgres.go`, immediately after `queryUsenetItems`:

```go
// queryUsenetListItems scans header-only Usenet rows (no body column) for the list
// views. It mirrors queryUsenetItems minus the body scan target; Body stays empty.
func queryUsenetListItems(ctx context.Context, pool *pgxpool.Pool, q string, args ...any) ([]model.UsenetItem, error) {
	rows, err := pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	defer rows.Close()

	var out []model.UsenetItem
	for rows.Next() {
		var it model.UsenetItem
		var newsgroup, subject, author, messageID, references, inReplyTo, threadID, parentID, dateSource *string
		if err := rows.Scan(
			&it.ID, &it.StartDate, &newsgroup, &subject, &author,
			&messageID, &references, &inReplyTo, &threadID,
			&parentID, &dateSource, &it.Approved,
		); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		derefStr(&it.Newsgroup, newsgroup)
		derefStr(&it.Subject, subject)
		derefStr(&it.Author, author)
		derefStr(&it.MessageID, messageID)
		derefStr(&it.References, references)
		derefStr(&it.InReplyTo, inReplyTo)
		derefStr(&it.ThreadID, threadID)
		derefStr(&it.ParentID, parentID)
		derefStr(&it.DateSource, dateSource)
		out = append(out, it)
	}
	return out, rows.Err()
}
```

- [ ] **Step 3: Point the three list queries at the body-less path**

In `packages/backend/internal/db/postgres.go`, change `usenetSelectFrom` → `usenetListSelectFrom` and `queryUsenetItems` → `queryUsenetListItems` in exactly these three functions (leave `UsenetItemByID` and `AllUsenetItems` alone):

`CurrentUsenetItems`:

```go
func CurrentUsenetItems(ctx context.Context, pool *pgxpool.Pool, newsgroup string, t time.Time, limit int) ([]model.UsenetItem, error) {
	return queryUsenetListItems(ctx, pool,
		usenetListSelectFrom+`
		 WHERE ui.approved = 1
		   AND s.slug = $1
		   AND ui.start_date <= $2
		 ORDER BY ui.start_date DESC
		 LIMIT $3`, newsgroup, t, limit)
}
```

`OlderUsenetItems`:

```go
func OlderUsenetItems(ctx context.Context, pool *pgxpool.Pool, newsgroup string, before time.Time, limit int) ([]model.UsenetItem, error) {
	return queryUsenetListItems(ctx, pool,
		usenetListSelectFrom+`
		 WHERE ui.approved = 1
		   AND s.slug = $1
		   AND ui.start_date < $2
		 ORDER BY ui.start_date DESC
		 LIMIT $3`, newsgroup, before, limit)
}
```

`UsenetItemsInRange`:

```go
func UsenetItemsInRange(ctx context.Context, pool *pgxpool.Pool, newsgroup string, lo, hi time.Time) ([]model.UsenetItem, error) {
	return queryUsenetListItems(ctx, pool,
		usenetListSelectFrom+`
		 WHERE ui.approved = 1
		   AND s.slug = $1
		   AND ui.start_date >= $2
		   AND ui.start_date < $3
		 ORDER BY ui.start_date
		 LIMIT $4`, newsgroup, lo, hi, usenetWindowLimit)
}
```

- [ ] **Step 4: Verify build, vet, and that list queries no longer select body**

Run:
```bash
cd packages/backend && go build ./... && go vet ./...
grep -n 'usenetListSelectFrom\|queryUsenetListItems' internal/db/postgres.go
```
Expected: build/vet clean. The grep shows `CurrentUsenetItems`, `OlderUsenetItems`, and `UsenetItemsInRange` all using `usenetListSelectFrom`/`queryUsenetListItems`, and `usenetListSelectFrom` has no `ui.body`.

- [ ] **Step 5: Confirm `UsenetItemByID` still returns the body**

Run: `grep -n -A6 'func UsenetItemByID' internal/db/postgres.go`
Expected: still calls `queryUsenetItems` with `usenetSelectFrom` (which includes `ui.body`).

- [ ] **Step 6: Commit**

```bash
git add packages/backend/internal/db/postgres.go
git commit -m "perf(usenet): drop body from list queries (fetched on demand)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Frontend — provider body cache + wire handling

**Files:**
- Create: `packages/frontend/src/Providers/MediaStream/usenetBodyCache.ts`
- Create: `packages/frontend/src/Providers/MediaStream/usenetBodyCache.test.ts`
- Modify: `packages/frontend/src/Providers/MediaStream/MediaStreamContext.ts` (`UsenetItem` interface; `MediaStreamContextValue`; default context object)
- Modify: `packages/frontend/src/Providers/MediaStream/MediaStreamProvider.tsx` (state + ref, `requestUsenetBody`, `usenet_body` frame handler, provider value)

**Interfaces:**
- Produces:
  - `usenetBodyCache.ts`:
    - `interface UsenetBodyState { bodies: Record<number, string>; errors: Record<number, string> }`
    - `const emptyUsenetBodyState: UsenetBodyState`
    - `interface UsenetBodyFrame { id: number; body?: string; message?: string }`
    - `function applyUsenetBodyFrame(state: UsenetBodyState, frame: UsenetBodyFrame): UsenetBodyState` — returns a new state with `body` stored under `frame.id` (when `message` is absent/empty) or `message` stored under `errors[frame.id]` (when present). A success clears any prior error for that id and vice-versa.
  - `MediaStreamContextValue` gains: `usenetBodies: Record<number, string>`, `usenetBodyErrors: Record<number, string>`, `requestUsenetBody: (id: number) => void`.
  - `UsenetItem` loses its `body?: string` field.
- Consumes: backend `usenet_body` frame `{type, id, body?, message?}` (Task 1); existing `decodeWireMessage`, `send`.

- [ ] **Step 1: Write the failing reducer test**

Create `packages/frontend/src/Providers/MediaStream/usenetBodyCache.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyUsenetBodyFrame, emptyUsenetBodyState } from "./usenetBodyCache";

describe("applyUsenetBodyFrame", () => {
	it("stores a body under its id", () => {
		const next = applyUsenetBodyFrame(emptyUsenetBodyState, { id: 7001, body: "Hi.\n" });
		expect(next.bodies[7001]).toBe("Hi.\n");
		expect(next.errors[7001]).toBeUndefined();
	});

	it("stores an empty body (genuinely empty message) without erroring", () => {
		const next = applyUsenetBodyFrame(emptyUsenetBodyState, { id: 7001, body: "" });
		expect(next.bodies[7001]).toBe("");
		expect(next.errors[7001]).toBeUndefined();
	});

	it("stores a failure message as an error", () => {
		const next = applyUsenetBodyFrame(emptyUsenetBodyState, {
			id: 7002,
			message: "message unavailable",
		});
		expect(next.errors[7002]).toBe("message unavailable");
		expect(next.bodies[7002]).toBeUndefined();
	});

	it("does not mutate the input state", () => {
		const start = emptyUsenetBodyState;
		applyUsenetBodyFrame(start, { id: 7001, body: "Hi." });
		expect(start.bodies[7001]).toBeUndefined();
	});

	it("a later success clears a prior error for the same id", () => {
		const errored = applyUsenetBodyFrame(emptyUsenetBodyState, {
			id: 7003,
			message: "message unavailable",
		});
		const fixed = applyUsenetBodyFrame(errored, { id: 7003, body: "recovered" });
		expect(fixed.bodies[7003]).toBe("recovered");
		expect(fixed.errors[7003]).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/frontend && npx vitest run src/Providers/MediaStream/usenetBodyCache.test.ts`
Expected: FAIL — cannot resolve `./usenetBodyCache`.

- [ ] **Step 3: Implement the reducer module**

Create `packages/frontend/src/Providers/MediaStream/usenetBodyCache.ts`:

```ts
/**
 * Session-lifetime cache of on-demand Usenet article bodies. Bodies are immutable
 * historical data, so once fetched they are never invalidated. A frame either
 * carries a body (success) or a message (failure); the two maps are kept mutually
 * exclusive per id so the UI can show body / loading / error unambiguously.
 */
export interface UsenetBodyState {
	bodies: Record<number, string>;
	errors: Record<number, string>;
}

export const emptyUsenetBodyState: UsenetBodyState = { bodies: {}, errors: {} };

/** The server's usenet_body reply: {id, body} on success or {id, message} on failure. */
export interface UsenetBodyFrame {
	id: number;
	body?: string;
	message?: string;
}

/** Fold one usenet_body frame into the cache, returning a new state. */
export function applyUsenetBodyFrame(
	state: UsenetBodyState,
	frame: UsenetBodyFrame,
): UsenetBodyState {
	const bodies = { ...state.bodies };
	const errors = { ...state.errors };
	if (frame.message) {
		errors[frame.id] = frame.message;
		delete bodies[frame.id];
	} else {
		bodies[frame.id] = frame.body ?? "";
		delete errors[frame.id];
	}
	return { bodies, errors };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/frontend && npx vitest run src/Providers/MediaStream/usenetBodyCache.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Update the context types and defaults**

In `packages/frontend/src/Providers/MediaStream/MediaStreamContext.ts`:

Remove the `body` field from `UsenetItem` (delete the `body?: string;` line; keep the rest of the interface).

Add to `MediaStreamContextValue` (after the `usenetItems` field group):

```ts
	/** Fetched Usenet article bodies, keyed by message id (on-demand). */
	usenetBodies: Record<number, string>;
	/** Failure messages for body fetches that could not be served, keyed by id. */
	usenetBodyErrors: Record<number, string>;
	/** Request one message's body by id; no-ops if already fetched or in flight. */
	requestUsenetBody: (id: number) => void;
```

Add to the default context object passed to `createContext`:

```ts
	usenetBodies: {},
	usenetBodyErrors: {},
	requestUsenetBody: () => {},
```

- [ ] **Step 6: Wire the provider state, request, and frame handler**

In `packages/frontend/src/Providers/MediaStream/MediaStreamProvider.tsx`:

Add the import:

```ts
import {
	applyUsenetBodyFrame,
	emptyUsenetBodyState,
	type UsenetBodyFrame,
} from "./usenetBodyCache";
```

Add state + an in-flight ref (near the other usenet state, ~line 111 and ~line 134):

```ts
	const [usenetBodyState, setUsenetBodyState] = useState(emptyUsenetBodyState);
	// Ids with a usenet_body request sent but not yet answered — prevents duplicate
	// fetches when a window re-renders before its body arrives.
	const usenetBodyInflight = useRef(new Set<number>());
```

Add the inbound frame type to the union (`WsIncomingMessage`) and a typed alias near `WsUsenetMessage`:

```ts
interface WsUsenetBodyMessage {
	type: "usenet_body";
	id: number;
	body?: string;
	message?: string;
}
```
(add `| WsUsenetBodyMessage` to the `WsIncomingMessage` union)

Add `requestUsenetBody` (near `requestUsenetOlder`):

```ts
	// Fetch one message body on demand. Skips ids already cached, already errored,
	// or already in flight; bodies are immutable so a cached one is never refetched.
	const requestUsenetBody = useCallback(
		(id: number) => {
			if (
				id in usenetBodyState.bodies ||
				id in usenetBodyState.errors ||
				usenetBodyInflight.current.has(id)
			) {
				return;
			}
			usenetBodyInflight.current.add(id);
			send({ type: "usenet_body", id });
		},
		[send, usenetBodyState],
	);
```

Add the frame handler in `ws.onmessage`, alongside the other `if (msg.type === ...)` blocks (after the `usenet` block, ~line 466):

```ts
				if (msg.type === "usenet_body") {
					const frame = msg as WsUsenetBodyMessage;
					usenetBodyInflight.current.delete(frame.id);
					setUsenetBodyState((prev) =>
						applyUsenetBodyFrame(prev, frame as UsenetBodyFrame),
					);
					return;
				}
```

On reconnect, drop unresolved in-flight markers so open windows can re-request. In the `ws.onopen` handler, after the usenet resubscribe block (~line 386), add:

```ts
				// Body requests do not survive a reconnect; clear in-flight markers so
				// any open message window re-requests on its next render.
				usenetBodyInflight.current.clear();
```

Expose the new values in the provider `value={{ ... }}`:

```ts
				usenetBodies: usenetBodyState.bodies,
				usenetBodyErrors: usenetBodyState.errors,
				requestUsenetBody,
```

- [ ] **Step 7: Typecheck and run the provider/codec test suite**

Run: `cd packages/frontend && npx tsc -b && npx vitest run src/Providers/MediaStream/`
Expected: tsc exit 0 (no unused-locals errors); all MediaStream tests PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/frontend/src/Providers/MediaStream/
git commit -m "feat(usenet): provider body cache + usenet_body frame handling

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Frontend — Newsgroups app fetches body on window open

**Files:**
- Modify: `packages/frontend/src/Applications/Newsgroups/useNewsgroups.ts` (`NewsgroupsState` interface; context destructure; return object)
- Modify: `packages/frontend/src/Applications/Newsgroups/Newsgroups.tsx` (consume new hook fields; effect to request bodies for open windows; body area render)

**Interfaces:**
- Consumes: `usenetBodies`, `usenetBodyErrors`, `requestUsenetBody` from `MediaStreamContext` (Task 3).
- Produces: `NewsgroupsState` gains `bodies: Record<number, string>`, `bodyErrors: Record<number, string>`, `requestBody: (id: number) => void`.

- [ ] **Step 1: Thread the new fields through the hook**

In `packages/frontend/src/Applications/Newsgroups/useNewsgroups.ts`:

Add to the `NewsgroupsState` interface (after `loadOlder`):

```ts
	/** Fetched message bodies by id (on-demand; empty until a window opens). */
	bodies: Record<number, string>;
	/** Failure messages for bodies that could not be fetched, by id. */
	bodyErrors: Record<number, string>;
	/** Request one message's body by id; no-ops if cached or in flight. */
	requestBody: (id: number) => void;
```

Add to the `useContext(MediaStreamContext)` destructure:

```ts
		usenetBodies,
		usenetBodyErrors,
		requestUsenetBody,
```

Add to the returned object (after `loadOlder`):

```ts
		bodies: usenetBodies,
		bodyErrors: usenetBodyErrors,
		requestBody: requestUsenetBody,
```

- [ ] **Step 2: Consume the fields and request bodies on open**

In `packages/frontend/src/Applications/Newsgroups/Newsgroups.tsx`:

Add `useEffect` to the React import:

```ts
import { useEffect, useState } from "react";
```

Add `bodies`, `bodyErrors`, `requestBody` to the `useNewsgroups(appId)` destructure (alongside `loadOlder`, `connected`).

After the `openMessages` state and its helpers, add an effect that fetches a body whenever a window is open for it:

```ts
	// Each open message window needs its body fetched on demand (bodies no longer
	// ride the list frames). requestBody de-dupes, so re-running on any change is safe.
	useEffect(() => {
		for (const m of openMessages) requestBody(m.id);
	}, [openMessages, requestBody]);
```

- [ ] **Step 3: Render body / loading / error in the message window**

In `packages/frontend/src/Applications/Newsgroups/Newsgroups.tsx`, replace the body `ClassicyControlGroup` block (currently `prefillValue={m.body ?? ""}`) so it draws from the cache:

```tsx
						<div className={styles.detailBody}>
							<ClassicyControlGroup label="Body">
								<ClassicyTextEditor
									id={`${m.id}-body`}
									border
									prefillValue={
										m.id in bodies
											? bodies[m.id]
											: bodyErrors[m.id] ?? "Loading message…"
									}
									autoHeight
									disabled
								/>
							</ClassicyControlGroup>
						</div>
```

- [ ] **Step 4: Typecheck the frontend**

Run: `cd packages/frontend && npx tsc -b`
Expected: exit 0 — no unused locals (the old `m.body` reference is gone; `UsenetItem` no longer has `body`).

- [ ] **Step 5: Run the full frontend test + build**

Run: `cd packages/frontend && npx vitest run && npm run build`
Expected: all tests PASS; `tsc -b && vite build` completes with no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/Applications/Newsgroups/
git commit -m "feat(newsgroups): fetch message body on window open

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- "List queries drop the body" → Task 2 (all three queries + `UsenetItemByID` kept). ✓
- "New `usenet_body` request/response" → Task 1 (struct, handler case, `SendUsenetBody`, `outMsg` fields, approval guard). ✓
- "Provider owns a body cache" → Task 3 (`usenetBodies`/`usenetBodyErrors`/`requestUsenetBody`, dedupe ref, reconnect clear). ✓
- "Newsgroups app fetches on open" → Task 4 (effect + loading/error render, hook threading). ✓
- "Remove `body` from `UsenetItem`" → Task 3 Step 5. ✓
- "Protocol doc + frontend updated with the wire change" → Task 1 Step 7 (doc); Tasks 3–4 (frontend). ✓
- "Loading placeholder / error line" → Task 4 Step 3. ✓
- Testing (backend body frame; frontend reducer) → Task 1 Steps 1–5, Task 3 Steps 1–4. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to" — every code step shows full code. ✓

**Type consistency:**
- `SendUsenetBody(id int, body, errMsg string)` — defined Task 1 Step 4, used Task 1 Step 6. ✓
- `outMsg.ID`/`outMsg.Body` — added Task 1 Step 3, asserted Task 1 Step 1 (`m.ID`/`m.Body`), error via `m.Msg`. ✓
- `applyUsenetBodyFrame` / `emptyUsenetBodyState` / `UsenetBodyState` / `UsenetBodyFrame` — defined Task 3 Step 3, used Tasks 3 (provider) & tests. ✓
- Context fields `usenetBodies`/`usenetBodyErrors`/`requestUsenetBody` — defined Task 3 Step 5, consumed Task 4 Step 1. ✓
- Hook fields `bodies`/`bodyErrors`/`requestBody` — defined Task 4 Step 1, used Task 4 Steps 2–3. ✓
- `queryUsenetListItems`/`usenetListSelectFrom` — defined Task 2 Steps 1–2, used Task 2 Step 3. ✓
