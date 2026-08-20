# Chat Pause Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Forward the virtual clock's paused state to the streamer so IM Buddies refuses sends while the clock is stopped.

**Architecture:** The server already implements pause end-to-end (route, `Session.Pause()`, availability gate, `chat_state` push) and the frontend already renders the resulting `"paused"` reason. The only missing piece is the client sending `{"type":"pause"}` / `{"type":"resume"}`. Both go in `MediaStreamProvider` — the single component permitted to talk to the streamer. Design: [`plans/2026-07-28-chat-pause-gate-design.md`](2026-07-28-chat-pause-gate-design.md).

**Tech Stack:** React 19 + TypeScript + Vite, Vitest + @testing-library/react, `classicy` (virtual clock), MessagePack over WebSocket (server→client) / JSON text (client→server).

## Global Constraints

- **Apps never open a second WebSocket or talk to the streamer directly.** Everything goes through `MediaStreamProvider` / `MediaStreamContext`. This change adds no new socket and no new call site.
- **Never add `paused` to the socket effect's dependency array.** That effect is marked *"Intentionally runs once on mount"*; adding `paused` would tear down and rebuild the WebSocket on every pause and resume. Read it through a ref, as the file already does for `setDateTimeRef` and `isItemAvailableRef`.
- **No UI changes.** `composeGate.ts` and `BuddyListWindow.tsx` already render the `"paused"` reason; they must not be touched.
- **Wire format is JSON text client→server.** Frames are exactly `{"type":"pause"}` and `{"type":"resume"}` with no payload — see `packages/backend/docs/websocket-protocol.md` §`pause`.
- **`classicy` is pinned to `"latest"` and auto-bumped by `.husky/pre-commit`.** Never hand-edit its version.
- Frontend uses **tabs for indentation** and double quotes.

## Prerequisite

This worktree has no `node_modules`:

```bash
cd /home/robbiebyrd/rt911/.claude/worktrees/chat-pause-gate
pnpm install
```

## File Structure

| File | Responsibility |
|---|---|
| `packages/frontend/src/Providers/MediaStream/MediaStreamProvider.tsx` *(modify)* | Read `paused` from the clock hook; send the frame on transition; assert it on connection open |
| `packages/frontend/src/Providers/MediaStream/MediaStreamProvider.pause.test.tsx` *(create)* | All four behaviours, with its own `FakeWebSocket` + `classicy` mock |

The test file is new rather than an addition to `MediaStreamProvider.clock.test.tsx`, matching the provider's existing topic-split convention (`.clock.`, `.chat.`, `.news.`, `.weather.`, `.flights.`), each of which carries its own mock harness.

---

### Task 1: Send pause/resume on transition

**Files:**
- Modify: `packages/frontend/src/Providers/MediaStream/MediaStreamProvider.tsx:262` (destructure), plus a new effect after it
- Test: `packages/frontend/src/Providers/MediaStream/MediaStreamProvider.pause.test.tsx` *(create)*

**Interfaces:**
- Consumes: `useClassicyDateTime({ tick: true })` from `classicy`, which returns `{ localDate, dateTime, tzOffset, setDateTime, paused, pause, resume }`. Only `paused` is newly used.
- Produces: two refs used by Task 2 — `pausedRef: React.RefObject<boolean>` (live mirror of `paused`) and `pauseSentRef: React.RefObject<boolean | null>` (what the server was last told; `null` = nothing sent yet on this connection).

- [ ] **Step 1: Write the failing test**

Create `packages/frontend/src/Providers/MediaStream/MediaStreamProvider.pause.test.tsx`. The `classicy` mock here differs from the other provider test files in one way: `useClassicyDateTime` also returns `paused`, read from a mutable module-level `mockPaused` the tests flip between renders.

```tsx
import { act, cleanup, render } from "@testing-library/react";
import { useContext } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaStreamContext, type MediaStreamContextValue } from "./MediaStreamContext";
import { MediaStreamProvider } from "./MediaStreamProvider";

const NOW_ISO = "2001-09-11T13:00:00.000Z";
// One stable Date instance — a fresh `new Date(...)` per render infinite-loops
// the tick effect (see MediaStreamProvider.flights.test.tsx).
const FIXED_LOCAL_DATE = new Date(NOW_ISO);
// Flipped by tests, then re-rendered so the mocked hook reports the new value.
let mockPaused = false;
const setDateTimeMock = vi.hoisted(() => vi.fn());
const dispatchMock = vi.hoisted(() => vi.fn());

vi.mock("classicy", () => ({
	// Unlike the other provider test mocks, this one returns `paused` — the
	// whole point of the file.
	useClassicyDateTime: () => ({
		localDate: FIXED_LOCAL_DATE,
		dateTime: NOW_ISO,
		tzOffset: 0,
		setDateTime: setDateTimeMock,
		paused: mockPaused,
	}),
	useAppManager: (selector: (s: unknown) => unknown) =>
		selector({
			System: {
				Manager: {
					DateAndTime: { dateTimeLocked: false },
					Applications: { apps: {} },
				},
			},
		}),
	useAppManagerDispatch: () => dispatchMock,
	ClassicyIcons: { applications: {} },
}));

class FakeWebSocket {
	static OPEN = 1;
	static CONNECTING = 0;
	static instances: FakeWebSocket[] = [];
	readyState = FakeWebSocket.OPEN;
	binaryType = "";
	sent: string[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	url: string;
	constructor(url: string) {
		this.url = url;
		FakeWebSocket.instances.push(this);
	}
	send(data: string) {
		this.sent.push(data);
	}
	close() {}
}

function ContextCapture({
	captured,
}: {
	captured: { current: MediaStreamContextValue | null };
}) {
	const ctx = useContext(MediaStreamContext);
	captured.current = ctx;
	return null;
}

let captured: { current: MediaStreamContextValue | null };

function renderProvider() {
	captured = { current: null };
	const tree = (
		<MediaStreamProvider>
			<ContextCapture captured={captured} />
		</MediaStreamProvider>
	);
	const result = render(tree);
	// Re-rendering the same tree is how a test makes the provider observe a new
	// mockPaused — the mocked hook is a plain function, so it reports the
	// current value on the next render.
	return { ...result, again: () => result.rerender(tree) };
}

/** Frames sent since the marker, so `init` and subscriptions don't pollute assertions. */
const sentSince = (ws: FakeWebSocket, from: number) => ws.sent.slice(from);

beforeEach(() => {
	FakeWebSocket.instances = [];
	mockPaused = false;
	setDateTimeMock.mockClear();
	dispatchMock.mockClear();
	vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("MediaStreamProvider pause/resume frames", () => {
	it("sends pause when the clock is paused", () => {
		const { again } = renderProvider();
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());
		const mark = ws.sent.length;

		mockPaused = true;
		act(() => { again(); });

		expect(sentSince(ws, mark)).toContain(JSON.stringify({ type: "pause" }));
	});

	it("sends resume when the clock restarts", () => {
		const { again } = renderProvider();
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());

		mockPaused = true;
		act(() => { again(); });
		const mark = ws.sent.length;

		mockPaused = false;
		act(() => { again(); });

		expect(sentSince(ws, mark)).toContain(JSON.stringify({ type: "resume" }));
	});

	it("sends nothing when paused has not changed", () => {
		const { again } = renderProvider();
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());

		mockPaused = true;
		act(() => { again(); });
		const mark = ws.sent.length;

		// Same value, two more renders.
		act(() => { again(); });
		act(() => { again(); });

		expect(sentSince(ws, mark)).toEqual([]);
	});

	it("does not announce the default unpaused state on mount", () => {
		// A `resume` for a session that was never paused is meaningless traffic.
		renderProvider();
		const ws = FakeWebSocket.instances[0];
		act(() => ws.onopen?.());

		expect(ws.sent).not.toContain(JSON.stringify({ type: "resume" }));
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Providers/MediaStream/MediaStreamProvider.pause.test.tsx`

Expected: the first three tests FAIL (no pause/resume frame is ever sent). The fourth ("does not announce the default unpaused state") passes vacuously today — that is fine and expected; it is a guard against the implementation over-sending, not a driver of it.

- [ ] **Step 3: Destructure `paused`**

In `MediaStreamProvider.tsx`, line 262:

```tsx
const { localDate, dateTime, tzOffset, setDateTime } = useClassicyDateTime({ tick: true });
```

becomes:

```tsx
const { localDate, dateTime, tzOffset, setDateTime, paused } = useClassicyDateTime({ tick: true });
```

- [ ] **Step 4: Add the refs and the transition effect**

Insert immediately after the existing `setDateTimeRef` effect (which ends around line 269), keeping the file's ref-mirror idiom together:

```tsx
	// Live mirror of the clock's paused state for the WebSocket effect's onopen,
	// which must assert pause on a connection opened while already paused.
	// Reading `paused` there directly would go stale, and adding it to that
	// effect's dependency array would tear down and rebuild the socket on every
	// pause — a reconnect storm from a button press.
	const pausedRef = useRef(paused);
	pausedRef.current = paused;

	// What the server was last told on THIS connection. null means nothing has
	// been sent yet, which is also the correct state for a fresh socket: `init`
	// resets Session.paused to false, so onopen re-establishes the truth.
	const pauseSentRef = useRef<boolean | null>(null);

	// Forward pause/resume to the streamer. Without this the server never learns
	// the clock stopped: Session.paused stays false, chat.Available never returns
	// "paused", and the IM Buddies composer stays open against a frozen clock.
	useEffect(() => {
		const ws = wsRef.current;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		if (pauseSentRef.current === paused) return;
		// Say nothing about the default unpaused state: a `resume` for a session
		// that was never paused is meaningless traffic. onopen owns the initial
		// assertion.
		if (pauseSentRef.current === null && !paused) {
			pauseSentRef.current = false;
			return;
		}
		ws.send(JSON.stringify({ type: paused ? "pause" : "resume" }));
		pauseSentRef.current = paused;
	}, [paused]);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Providers/MediaStream/MediaStreamProvider.pause.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 6: Confirm no other provider test regressed**

The provider is shared by six other test files; adding a destructured field and an effect must not disturb them.

Run: `pnpm --filter @rt911/frontend exec vitest run src/Providers/MediaStream/`
Expected: PASS, all files.

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/src/Providers/MediaStream/MediaStreamProvider.tsx \
        packages/frontend/src/Providers/MediaStream/MediaStreamProvider.pause.test.tsx
git commit -m "fix(chat): tell the streamer when the virtual clock pauses

Time Machine's Pause button only stopped Classicy's local clock, so
Session.paused was false for every session that ever ran and the IM Buddies
composer stayed open against a frozen clock. The server side already existed
end to end; the client simply never sent the frame."
```

---

### Task 2: Assert pause on connection open

**Files:**
- Modify: `packages/frontend/src/Providers/MediaStream/MediaStreamProvider.tsx` — inside `ws.onopen`, after the subscription replay block (which ends with the `chatSubscribers` block around line 1069) and before `usenetBodyInflight.current.clear()`
- Test: `packages/frontend/src/Providers/MediaStream/MediaStreamProvider.pause.test.tsx` *(extend)*

**Interfaces:**
- Consumes: `pausedRef` and `pauseSentRef` from Task 1.
- Produces: nothing further.

Without this task the fix survives only until the user's next page reload — `paused` is persisted in `classicyDesktopState`, and `init` resets `Session.paused` to `false` on every connection.

- [ ] **Step 1: Write the failing test**

Append to `MediaStreamProvider.pause.test.tsx`, inside the existing `describe`:

```tsx
	it("asserts pause on a connection opened while already paused", () => {
		// The load-bearing case, and an ordinary user action rather than an edge
		// case: `paused` lives in the localStorage-persisted classicyDesktopState,
		// so pausing and reloading the page mounts the provider already paused.
		// onopen sends `init`, which resets Session.paused to false — without this
		// assertion the composer silently re-enables against a frozen clock.
		mockPaused = true;
		renderProvider();
		const ws = FakeWebSocket.instances[0];

		act(() => ws.onopen?.());

		expect(ws.sent).toContain(JSON.stringify({ type: "pause" }));
	});

	it("sends pause after init, not before", () => {
		// init resets Session.paused to false, so a pause that arrives first is
		// immediately undone by the very next frame.
		mockPaused = true;
		renderProvider();
		const ws = FakeWebSocket.instances[0];

		act(() => ws.onopen?.());

		const initAt = ws.sent.findIndex((f) => JSON.parse(f).type === "init");
		const pauseAt = ws.sent.findIndex((f) => JSON.parse(f).type === "pause");
		expect(initAt).toBeGreaterThanOrEqual(0);
		expect(pauseAt).toBeGreaterThan(initAt);
	});

	it("does not assert pause on a connection opened while running", () => {
		renderProvider();
		const ws = FakeWebSocket.instances[0];

		act(() => ws.onopen?.());

		expect(ws.sent).not.toContain(JSON.stringify({ type: "pause" }));
	});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Providers/MediaStream/MediaStreamProvider.pause.test.tsx`
Expected: the two "asserts pause…" / "sends pause after init" tests FAIL; the third passes vacuously.

- [ ] **Step 3: Add the assertion to `onopen`**

In the socket effect's `ws.onopen`, immediately after the `chatSubscribers` block and before `usenetBodyInflight.current.clear()`:

```tsx
			// `init` above resets Session.paused to false (protocol doc, §init), so
			// a connection opened while the clock is paused would hand the server a
			// running clock and re-enable the chat composer. This is not just
			// reconnect hardening: `paused` is persisted in classicyDesktopState, so
			// pausing and reloading the page lands here every time. Same reason the
			// subscriptions above are replayed.
			if (pausedRef.current) {
				ws.send(JSON.stringify({ type: "pause" }));
			}
			pauseSentRef.current = pausedRef.current;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Providers/MediaStream/MediaStreamProvider.pause.test.tsx`
Expected: PASS, 7 tests.

- [ ] **Step 5: Mutation-check the ordering assertion**

The "after init, not before" test is worthless if it passes regardless of order. Prove it bites: temporarily move the new `if (pausedRef.current)` block **above** the `ws.send(JSON.stringify({ type: "init", ... }))` call, re-run, and confirm that test FAILS. Then move it back and confirm it passes again.

- [ ] **Step 6: Run the repo checks**

```bash
pnpm --filter @rt911/frontend exec tsc -b
pnpm lint
pnpm test
```

Expected: `tsc -b` exits 0; `pnpm lint` reports 0 errors (22 pre-existing warnings are expected, none in the changed file); the full suite passes. If `tsc -b` seems to ignore a change, delete `packages/frontend/tsconfig.tsbuildinfo` and re-run — its incremental cache has masked real errors in this repo before.

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/src/Providers/MediaStream/MediaStreamProvider.tsx \
        packages/frontend/src/Providers/MediaStream/MediaStreamProvider.pause.test.tsx
git commit -m "fix(chat): assert pause on connection open

paused is persisted in classicyDesktopState and init resets Session.paused to
false, so pausing and reloading the page would silently re-enable the composer
against a frozen clock. Read through a ref: adding paused to the socket
effect's deps would rebuild the WebSocket on every pause."
```

---

### Task 3: Verify in the running desktop

**Files:** none — this task exercises Tasks 1 and 2 against a real streamer.

**Interfaces:**
- Consumes: everything above.
- Produces: confirmation that the server-side path the unit tests only stub actually fires.

The unit tests assert frames land in a `FakeWebSocket`. They cannot prove the real streamer flips `chat_state`, which is the behaviour the user actually reported. Use the `packages/frontend:verify` skill for the mechanics of driving the desktop.

- [ ] **Step 1: Check who owns port 5173 before starting anything**

```bash
ss -ltnp 2>/dev/null | grep 5173 || echo "5173 free"
```

Stale `classicy` example dev servers squat low ports in this environment, and a "feature not showing" report has traced back to exactly that. If it is occupied by something other than this worktree's dev server, stop it or start on another port.

- [ ] **Step 2: Start the dev server from THIS worktree**

```bash
cd /home/robbiebyrd/rt911/.claude/worktrees/chat-pause-gate && pnpm dev
```

Running it from the main checkout would verify the wrong code.

- [ ] **Step 3: Sign in and open IM Buddies**

Chat identity is the Directus session cookie; signed out, the app refuses every send regardless of the clock, so an unauthenticated check proves nothing about this change.

- [ ] **Step 4: Confirm the composer is usable while the clock runs**

The baseline half of the test. Without it, a composer disabled for some unrelated reason would read as success.

- [ ] **Step 5: Pause the clock in Time Machine and confirm the composer disables**

Expected: the message field and Send disable, the hint reads **"Start the clock to keep talking."**, and the buddy list shows **"Clock paused."** Both strings already exist in the codebase; seeing them is the proof the server pushed `chat_state` with `reason: "paused"`.

- [ ] **Step 6: Press Play and confirm the composer re-enables**

- [ ] **Step 7: Pause, then reload the page**

The regression Task 2 exists for. Expected: after reload the clock is still paused **and the composer is still disabled**. Before Task 2 this is where it silently re-enabled.

- [ ] **Step 8: Clean up**

Playwright MCP writes `.playwright-mcp/` and screenshots into the repo root. Remove them before finishing:

```bash
git status --short   # must show nothing but intended changes
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Destructure `paused` from the clock hook | 1, Step 3 |
| Send `pause`/`resume` on transition | 1, Step 4 |
| Suppress the initial unpaused announcement | 1, Step 4 (the `null && !paused` branch) + test 4 |
| Assert pause on every connection open | 2, Step 3 |
| Read `paused` through a ref, never the effect's deps | 1, Step 4 (`pausedRef`), Global Constraints |
| `seek` needs nothing (does not reset pause) | no task — correctly requires no code |
| No handling for `pause_ack`/`resume_ack` | no task — line 1348 already drops unknown frames |
| No change to `composeGate.ts` / `BuddyListWindow.tsx` | enforced by Global Constraints |
| Own test file matching the topic-split convention | 1, Step 1 |
| Server actually flips `chat_state` | 3 |

**Placeholder scan:** none. Every code step carries the literal code.

**Type consistency:** `pausedRef` and `pauseSentRef` are introduced in Task 1 Step 4 and consumed under those exact names in Task 2 Step 3. `pauseSentRef` is `boolean | null` in both. `renderProvider()` returns `{ ...result, again }` in Task 1 and Task 2's tests use both `again()` and the bare `renderProvider()` form, which the return type supports.

**Known residual risk:** Task 3 is the only step that exercises the real streamer. If the dev environment cannot reach a signed-in session, Tasks 1–2 still ship a client that provably sends the frames, but the end-to-end claim would rest on the server code being unchanged since it was last exercised — which it is, since this change touches no Go.
