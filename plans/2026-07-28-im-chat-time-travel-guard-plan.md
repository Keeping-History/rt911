# IM Buddies chat time-travel guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewinding the virtual clock behind a conversation's newest message disables that chat's composer, with an explanation naming the resume time, until the clock catches back up.

**Architecture:** `IMBuddiesProvider` keeps a monotonic per-profile high-water mark of the newest message timestamp it has ever seen (surviving both the backward-seek wipe of `chatMessages` and `signOff`). A new pure module `composeGate.ts` turns `(server state, mark, now)` into `{ enabled, hint }`. `ChatWindow` reads the ticking clock itself and renders the result, so the per-second re-render stays out of the provider's shared context value.

**Tech Stack:** Vite + React 19 + TypeScript, vitest + @testing-library/react, `classicy` (external), Biome for lint.

**Spec:** `plans/2026-07-28-im-chat-time-travel-guard-design.md`

## Global Constraints

- **Work in the existing worktree** `.claude/worktrees/im-chat-time-guard` (branch `worktree-im-chat-time-guard`). It is already `mise trust`ed. Do not switch the shared `/home/robbiebyrd/rt911` checkout.
- **This repo has no RTL auto-cleanup.** Every test file calls `afterEach(cleanup)` itself. New test files must include it.
- **Never fully replace the `classicy` mock in `ChatWindow.test.tsx`.** It is a *partial* mock (`...(await importOriginal())`); a new import added to `ChatWindow.tsx` resolves to the real module unless the factory overrides it. Add overrides, never swap the spread for a fixed object.
- **Hard rule 3:** compare with `virtualUtcMs(localDate, tzOffset)`, never a raw `localDate`.
- **No wire-protocol change.** `ChatStateReason` gains no member; this reason is client-only.
- **Do not touch `packages/backend`.**
- Exact copy for the blocked hint: `You've traveled back before your last message. Chat resumes at <TIME>.` where `<TIME>` is `formatPlayhead(markMs, tzOffsetHours)`.
- Run commands from `/home/robbiebyrd/rt911/.claude/worktrees/im-chat-time-guard`.

---

### Task 1: The pure gate

Creates the decision function and moves `composeHintFor` next to it. `composeHintFor` **must** move: `composeGate` needs it, it currently lives in `ChatWindow.tsx`, and `ChatWindow.tsx` will import `composeGate` — leaving it in place would create an import cycle.

**Files:**
- Create: `packages/frontend/src/Applications/IMBuddies/composeGate.ts`
- Create: `packages/frontend/src/Applications/IMBuddies/composeGate.test.ts`
- Modify: `packages/frontend/src/Applications/IMBuddies/ChatWindow.tsx` (delete `composeHintFor`, lines 14–41, and its now-unused `ChatStateReason` import on line 4)
- Modify: `packages/frontend/src/Applications/IMBuddies/ChatWindow.test.tsx:5` (import `composeHintFor` from `./composeGate` instead of `./ChatWindow`)

**Interfaces:**
- Consumes: `BACKWARD_SEEK_THRESHOLD_MS` from `../../Providers/MediaStream/seekDetection`; `formatPlayhead(playheadMs: number, tzOffsetHours: number): string` from `../../lib/loopClock`; `ChatStateReason` from `../../Providers/MediaStream/MediaStreamContext`.
- Produces:
  - `composeHintFor(reason: ChatStateReason): string` — moved verbatim, same behaviour.
  - `isRewound(lastMessageAtMs: number | null, nowMs: number): boolean`
  - `composeGate(input: { serverEnabled: boolean; reason: ChatStateReason; lastMessageAtMs: number | null; nowMs: number; tzOffsetHours: number }): { enabled: boolean; hint: string }`

Note the deviation from the spec's four-positional-argument sketch: the object form carries `serverEnabled` too, so the gate returns the single combined `enabled` the window needs rather than making the window re-combine it.

- [ ] **Step 1: Write the failing test**

Create `packages/frontend/src/Applications/IMBuddies/composeGate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ChatStateReason } from "../../Providers/MediaStream/MediaStreamContext";
import { composeGate, composeHintFor, isRewound } from "./composeGate";

// 2001-09-11T13:07:35Z — the mark. At the product's -4 display offset this is
// 9:07:35 AM, the time the blocked hint must name.
const MARK = Date.parse("2001-09-11T13:07:35Z");
const MIN = 60_000;

function gate(over: Partial<Parameters<typeof composeGate>[0]> = {}) {
	return composeGate({
		serverEnabled: true,
		reason: "ok",
		lastMessageAtMs: MARK,
		nowMs: MARK,
		tzOffsetHours: -4,
		...over,
	});
}

describe("isRewound", () => {
	it("is true once the clock is behind the mark by more than the seek tolerance", () => {
		expect(isRewound(MARK, MARK - 7 * MIN)).toBe(true);
	});

	it("is false at the mark and past it", () => {
		expect(isRewound(MARK, MARK)).toBe(false);
		expect(isRewound(MARK, MARK + MIN)).toBe(false);
	});

	it("tolerates a reply stamped slightly ahead of the client clock", () => {
		// The streamer stamps whole-second RFC3339 at its own reading of the
		// client's virtual time, so a reply can land a fraction of a second
		// ahead. Without the tolerance the composer would blink disabled for a
		// second after every buddy reply.
		expect(isRewound(MARK, MARK - 1_500)).toBe(false);
	});

	it("never blocks a conversation that has no messages yet", () => {
		expect(isRewound(null, MARK - 60 * MIN)).toBe(false);
	});
});

describe("composeGate", () => {
	it("disables the composer and names the resume time when rewound", () => {
		const { enabled, hint } = gate({ nowMs: MARK - 7 * MIN });
		expect(enabled).toBe(false);
		expect(hint).toBe(
			"You've traveled back before your last message. Chat resumes at 9:07:35 AM.",
		);
	});

	it("outranks every wire reason, including the paused clock a rewind leaves behind", () => {
		// A Time Machine rewind usually leaves the clock paused too, so
		// "Start the clock to keep talking." would otherwise mask the real,
		// longer-lived blocker.
		const reasons: ChatStateReason[] = [
			"ok",
			"paused",
			"outside_window",
			"blocked",
			"not_signed_in",
		];
		for (const reason of reasons) {
			const { enabled, hint } = gate({
				reason,
				serverEnabled: false,
				nowMs: MARK - 7 * MIN,
			});
			expect(enabled).toBe(false);
			expect(hint).toMatch(/^You've traveled back/);
		}
	});

	it("defers to the wire reason when not rewound", () => {
		expect(gate({ serverEnabled: false, reason: "paused" })).toEqual({
			enabled: false,
			hint: "Start the clock to keep talking.",
		});
		expect(gate({ serverEnabled: false, reason: "outside_window" }).hint).toBe(
			"Nobody is online right now.",
		);
	});

	it("is fully enabled with no hint when the server is happy and time is not", () => {
		expect(gate()).toEqual({ enabled: true, hint: "" });
	});

	it("renders the resume time in the display timezone", () => {
		// Same instant, two offsets: the sentence must follow the desktop clock.
		expect(gate({ nowMs: MARK - 7 * MIN, tzOffsetHours: 0 }).hint).toContain(
			"1:07:35 PM",
		);
		expect(gate({ nowMs: MARK - 7 * MIN, tzOffsetHours: -4 }).hint).toContain(
			"9:07:35 AM",
		);
	});
});

describe("composeHintFor", () => {
	it("gives a different sentence per refusal", () => {
		expect(composeHintFor("paused")).toBe("Start the clock to keep talking.");
		expect(composeHintFor("outside_window")).toBe("Nobody is online right now.");
		expect(composeHintFor("blocked")).toBe("You can't send messages right now.");
		expect(composeHintFor("not_signed_in")).toBe("Sign on to send messages.");
		expect(composeHintFor("ok")).toBe("");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/composeGate.test.ts
```

Expected: FAIL — `Failed to resolve import "./composeGate"`.

- [ ] **Step 3: Write the implementation**

Create `packages/frontend/src/Applications/IMBuddies/composeGate.ts`:

```ts
// Compose-row policy for a chat window: may the student type right now, and if
// not, what is the one sentence that explains it?
//
// Two independent things can close the composer. The streamer's chat_state
// frames carry the server's view (paused clock, nobody online, blocked, not
// signed in). This module adds the client-only one: the student has rewound the
// virtual clock behind a message this conversation already contains.
//
// That guard exists because the backend spends real effort keeping a buddy from
// referring to events that have not happened yet, and a rewind opens the same
// hole from the other side — type at 9:00 into a conversation whose last line is
// stamped 9:07 and the agent receives a turn sitting before its own previous
// answer. There is no prompt-side fix for a self-contradictory transcript.
import { formatPlayhead } from "../../lib/loopClock";
import type { ChatStateReason } from "../../Providers/MediaStream/MediaStreamContext";
import { BACKWARD_SEEK_THRESHOLD_MS } from "../../Providers/MediaStream/seekDetection";

/**
 * Renders the one-sentence explanation for why compose is (or isn't) usable
 * right now. Pure so the window itself never branches on `reason` inline — it
 * just renders whatever this returns. Unlike BuddyListWindow's statusLineFor,
 * "ok" has no news to report: an empty string means the compose row simply
 * isn't showing a hint.
 */
export function composeHintFor(reason: ChatStateReason): string {
	switch (reason) {
		case "paused":
			return "Start the clock to keep talking.";
		case "outside_window":
			return "Nobody is online right now.";
		case "blocked":
			return "You can't send messages right now.";
		case "not_signed_in":
			return "Sign on to send messages.";
		case "ok":
			return "";
		default: {
			// Exhaustiveness guard: a sixth ChatStateReason added to the wire
			// protocol without a case added here fails this type check instead
			// of silently rendering nothing.
			const unhandled: never = reason;
			return unhandled;
		}
	}
}

/**
 * True when the virtual clock sits before this conversation's newest known
 * message — i.e. the student has travelled back behind their own history.
 *
 * The comparison carries BACKWARD_SEEK_THRESHOLD_MS of slack, and that slack is
 * load-bearing rather than defensive padding. The streamer stamps each reply
 * with whole-second RFC3339 at its own reading of the client's virtual time, so
 * a reply can legitimately land a fraction of a second AHEAD of the client
 * clock; an exact `nowMs < markMs` test would blink the composer disabled for
 * about a second after every buddy reply. Reusing the seek threshold also keeps
 * one definition of "a real backward move": a rewind too small to trigger a seek
 * is too small to close the composer.
 *
 * A conversation with no messages yet (`null`) is never rewound — there is
 * nothing to contradict.
 */
export function isRewound(lastMessageAtMs: number | null, nowMs: number): boolean {
	if (lastMessageAtMs === null) return false;
	return nowMs < lastMessageAtMs - BACKWARD_SEEK_THRESHOLD_MS;
}

export interface ComposeGateInput {
	/** The streamer's own enable flag, from chat_state. */
	serverEnabled: boolean;
	reason: ChatStateReason;
	/** Newest message instant for THIS conversation, true UTC ms, or null. */
	lastMessageAtMs: number | null;
	/** The virtual clock as true UTC ms (virtualUtcMs, never a raw localDate). */
	nowMs: number;
	/** Display-timezone offset, for rendering the resume time. */
	tzOffsetHours: number;
}

export interface ComposeGate {
	enabled: boolean;
	hint: string;
}

/**
 * The single answer the compose row renders: one combined `enabled` for the
 * field, Send, and the emoticon controls, plus the sentence to show.
 *
 * Being rewound OUTRANKS every wire reason. A Time Machine rewind usually
 * leaves the clock paused as well, so deferring to the server would show
 * "Start the clock to keep talking." — true, but not the blocker that will
 * still be there once the clock is running.
 */
export function composeGate({
	serverEnabled,
	reason,
	lastMessageAtMs,
	nowMs,
	tzOffsetHours,
}: ComposeGateInput): ComposeGate {
	if (isRewound(lastMessageAtMs, nowMs)) {
		// Non-null by isRewound's own contract.
		const resumesAt = formatPlayhead(lastMessageAtMs as number, tzOffsetHours);
		return {
			enabled: false,
			hint: `You've traveled back before your last message. Chat resumes at ${resumesAt}.`,
		};
	}
	return { enabled: serverEnabled, hint: composeHintFor(reason) };
}
```

- [ ] **Step 4: Delete the old copy of `composeHintFor` and fix its importers**

In `ChatWindow.tsx`, delete the whole `composeHintFor` block (the doc comment plus function, lines 14–41) and drop `ChatStateReason` from the type import on line 4 — that import exists only for it. Leave the `import { useIMBuddies }` line and everything else alone for now; Task 3 rewires the component body.

Add, alongside the existing imports:

```ts
import { composeHintFor } from "./composeGate";
```

(Task 3 replaces this with the `composeGate` import; keeping it here means the file still compiles and its tests still pass at the end of *this* task.)

In `ChatWindow.test.tsx`, change line 5 from:

```ts
import { cascadePosition, ChatWindow, composeHintFor } from "./ChatWindow";
```

to:

```ts
import { cascadePosition, ChatWindow } from "./ChatWindow";
import { composeHintFor } from "./composeGate";
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/
```

Expected: PASS — every IMBuddies file, including the untouched `ChatWindow` describe blocks.

- [ ] **Step 6: Typecheck and lint**

```bash
pnpm --filter @rt911/frontend exec tsc -b --force
pnpm --filter @rt911/frontend exec eslint src/Applications/IMBuddies/
```

Expected: both clean. `--force` matters: a cached `tsc -b` has masked real errors in this repo before.

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/src/Applications/IMBuddies/composeGate.ts \
        packages/frontend/src/Applications/IMBuddies/composeGate.test.ts \
        packages/frontend/src/Applications/IMBuddies/ChatWindow.tsx \
        packages/frontend/src/Applications/IMBuddies/ChatWindow.test.tsx
git commit -m "feat(im-buddies): add the compose gate, the pure rewind rule

composeHintFor moves here from ChatWindow so the gate can use it without
an import cycle. isRewound reuses BACKWARD_SEEK_THRESHOLD_MS so a rewind
too small to be a seek is also too small to close the composer, and a
reply stamped a beat ahead of the client clock does not blink it shut.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The provider's high-water mark

**Files:**
- Modify: `packages/frontend/src/Applications/IMBuddies/IMBuddiesProvider.tsx`
- Modify: `packages/frontend/src/Applications/IMBuddies/IMBuddiesProvider.test.tsx`

**Interfaces:**
- Consumes: `isRewound` from `./composeGate` (Task 1).
- Produces: `IMBuddiesValue.lastMessageAtFor(profile: number): number | null` — newest message instant for that conversation in true UTC ms, or `null` if it has never had one. Task 3 calls this.

- [ ] **Step 1: Write the failing tests**

First extend the test harness so a test can simulate the backward-seek wipe. In `IMBuddiesProvider.test.tsx`, inside `Harness`, right after the `pushMessage` `useCallback` block (about line 154), add:

```tsx
		// Stands in for MediaStreamProvider's backward-seek branch, which clears
		// chatMessages outright (`if (nowMs < prevMs) setChatMessages([])`). The
		// mark must survive this — after a rewind the transcript no longer holds
		// the message being rewound behind, so max(messages.time) is not a usable
		// source for it.
		const clearMessages = useCallback(() => setChatMessages([]), []);
		clearMessagesRef.current = clearMessages;
```

Declare the ref beside `pushMessageRef` (about line 129):

```tsx
	const clearMessagesRef: React.MutableRefObject<(() => void) | null> = { current: null };
```

and expose it in the returned object beside `pushMessage` (about line 223):

```tsx
		clearMessages: () => clearMessagesRef.current?.(),
```

Then append these tests inside the existing `describe("IMBuddiesProvider", ...)` block:

```tsx
	it("remembers a conversation's newest message instant", () => {
		const view = renderWithChat(<Probe />, {});
		expect(view.ctx.lastMessageAtFor(1)).toBeNull();

		act(() => {
			view.pushMessage({
				profile: 1,
				direction: "out",
				body: "still at the office",
				time: "2001-09-11T13:07:35Z",
			});
		});
		expect(view.ctx.lastMessageAtFor(1)).toBe(Date.parse("2001-09-11T13:07:35Z"));
		// Per conversation, not app-wide: a buddy you have not written to yet is
		// still fully usable.
		expect(view.ctx.lastMessageAtFor(2)).toBeNull();
	});

	it("only ever moves the mark forward", () => {
		const view = renderWithChat(<Probe />, {});
		act(() => {
			view.pushMessage({
				profile: 1,
				direction: "out",
				body: "later",
				time: "2001-09-11T13:07:35Z",
			});
		});
		act(() => {
			// A history backfill inserts OLDER lines into the same flat array.
			view.pushMessage({
				message_id: 5,
				profile: 1,
				direction: "out",
				body: "earlier",
				time: "2001-09-11T13:01:00Z",
			});
		});
		expect(view.ctx.lastMessageAtFor(1)).toBe(Date.parse("2001-09-11T13:07:35Z"));
	});

	it("survives the backward-seek wipe of chatMessages", () => {
		const view = renderWithChat(<Probe />, {});
		act(() => {
			view.pushMessage({
				profile: 1,
				direction: "out",
				body: "still at the office",
				time: "2001-09-11T13:07:35Z",
			});
		});
		act(() => view.clearMessages());
		expect(view.ctx.conversationFor(1).messages).toHaveLength(0);
		expect(view.ctx.lastMessageAtFor(1)).toBe(Date.parse("2001-09-11T13:07:35Z"));
	});

	it("survives signOff", () => {
		// Unlike openChats/readMarks, the mark is knowledge about the timeline,
		// not a view of it. Clearing it here would make Sign Off -> rewind ->
		// Sign On a way back into the state this guard exists to prevent, because
		// a history replay only ever returns messages BEFORE the current instant
		// and so could never rebuild it.
		const view = renderWithChat(<Probe />, {});
		act(() => {
			view.pushMessage({
				profile: 1,
				direction: "out",
				body: "still at the office",
				time: "2001-09-11T13:07:35Z",
			});
		});
		act(() => view.ctx.signOff());
		expect(view.ctx.lastMessageAtFor(1)).toBe(Date.parse("2001-09-11T13:07:35Z"));
	});

	it("counts the student's own line too, not just the buddy's", () => {
		const view = renderWithChat(<Probe />, {});
		act(() => view.ctx.send(1, "are you okay"));
		expect(view.ctx.lastMessageAtFor(1)).toBe(Date.parse(DEFAULT_CLOCK_ISO));
	});

	it("refuses to send while the clock is rewound behind the conversation", () => {
		const view = renderWithChat(<Probe />, {});
		act(() => {
			view.pushMessage({
				profile: 1,
				direction: "out",
				body: "still at the office",
				time: "2001-09-11T13:07:35Z",
			});
		});
		act(() => view.setClock("2001-09-11T13:00:00Z"));

		act(() => view.ctx.send(1, "this must not reach the wire"));

		// A disabled button is a UI state; this is the actual invariant. No wire
		// call, no local echo, and no send chirp for a line that never went.
		expect(view.sendChat).not.toHaveBeenCalled();
		expect(view.localEchoes).toHaveLength(0);
		expect(view.playSound).not.toHaveBeenCalledWith(IM_SOUNDS.send);
	});

	it("sends again once the clock reaches the conversation", () => {
		const view = renderWithChat(<Probe />, {});
		act(() => {
			view.pushMessage({
				profile: 1,
				direction: "out",
				body: "still at the office",
				time: "2001-09-11T13:07:35Z",
			});
		});
		act(() => view.setClock("2001-09-11T13:00:00Z"));
		act(() => view.setClock("2001-09-11T13:07:35Z"));

		act(() => view.ctx.send(1, "sorry, back"));
		expect(view.sendChat).toHaveBeenCalledWith(1, "sorry, back");
	});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/IMBuddiesProvider.test.tsx
```

Expected: FAIL — `view.ctx.lastMessageAtFor is not a function`.

- [ ] **Step 3: Add the mark to the provider**

In `IMBuddiesProvider.tsx`, add the import:

```ts
import { isRewound } from "./composeGate";
```

Add to `IMBuddiesValue` (after `conversationFor`):

```ts
	/**
	 * The newest message instant for a conversation, true UTC ms, or null if it
	 * has never had one. The compose gate's input — see composeGate.ts.
	 */
	lastMessageAtFor: (profile: number) => number | null;
```

Add the state and the effect that raises it, directly after the `readMarks` state declaration:

```tsx
	// Per-conversation high-water mark of the newest message instant ever seen,
	// in true UTC ms. Deliberately NOT derived from the current transcript: a
	// backward seek clears chatMessages outright in MediaStreamProvider, so by
	// the moment this matters the message being rewound behind is already gone
	// from it. Deliberately NOT cleared by signOff either (see the mark's
	// absence from that callback) — it is knowledge about the timeline rather
	// than a view of it, and a history replay only ever returns messages BEFORE
	// the current instant, so nothing could rebuild it.
	const [lastMessageAt, setLastMessageAt] = useState<Record<number, number>>({});
	useEffect(() => {
		setLastMessageAt((prev) => {
			let next = prev;
			for (const message of chatMessages) {
				const at = Date.parse(message.time);
				// An unparseable time is skipped rather than allowed to poison the
				// mark — the same tolerance conversationsByProfile's sort applies.
				if (Number.isNaN(at)) continue;
				if (at <= (next[message.profile] ?? Number.NEGATIVE_INFINITY)) continue;
				if (next === prev) next = { ...prev };
				next[message.profile] = at;
			}
			return next;
		});
	}, [chatMessages]);

	const lastMessageAtFor = useCallback(
		(profile: number): number | null => lastMessageAt[profile] ?? null,
		[lastMessageAt],
	);
```

Guard `send` — insert as its first statement, before `sendChat`:

```tsx
			// The composer is already disabled for this case (composeGate), but a
			// disabled button is a UI state and this is the invariant: a turn that
			// sits before the buddy's own previous answer must never reach the
			// wire, whatever a stale render or a stray keystroke does.
			if (isRewound(lastMessageAt[profile] ?? null, virtualNowMsRef.current)) return;
```

and add `lastMessageAt` to `send`'s dependency array.

Finally add `lastMessageAtFor` to the context value object and to the `useMemo` dependency array.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/IMBuddiesProvider.test.tsx
```

Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/IMBuddies/IMBuddiesProvider.tsx \
        packages/frontend/src/Applications/IMBuddies/IMBuddiesProvider.test.tsx
git commit -m "feat(im-buddies): track each conversation's newest message instant

A monotonic per-profile mark, fed by both directions and surviving both
the backward-seek wipe of chatMessages and signOff — neither of which
could be rebuilt from, since a history replay only returns messages
before the current instant. send() now refuses while rewound, so the
invariant does not depend on a button's disabled attribute.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire the window

**Files:**
- Modify: `packages/frontend/src/Applications/IMBuddies/ChatWindow.tsx`
- Modify: `packages/frontend/src/Applications/IMBuddies/ChatWindow.test.tsx`

**Interfaces:**
- Consumes: `composeGate` (Task 1), `lastMessageAtFor` (Task 2), `virtualUtcMs` from `../../Providers/MediaStream/virtualClock`, `useClassicyDateTime` from `classicy`.
- Produces: nothing further; this is the last code task.

- [ ] **Step 1: Write the failing tests**

In `ChatWindow.test.tsx`, add a controllable clock to the hoisted state. Extend the `imState` object (line 23) with:

```ts
	lastMessageAt: null as number | null,
```

and add a separate hoisted clock:

```ts
// The virtual clock ChatWindow reads for itself. A true UTC instant; the
// component converts with virtualUtcMs, so the mock reports localDate already
// shifted by tzOffset, exactly as the real hook does.
const clockState = vi.hoisted(() => ({ utcMs: Date.parse("2001-09-11T13:10:00Z"), tzOffset: -4 }));
```

Add `lastMessageAtFor` to the mocked `useIMBuddies` (inside the existing `vi.mock("./IMBuddiesProvider", ...)` factory):

```ts
		lastMessageAtFor: () => imState.lastMessageAt,
```

Add `useClassicyDateTime` to the **existing partial** classicy mock factory — do not replace the `importOriginal` spread:

```ts
	// ChatWindow reads the clock itself (that per-second re-render is what
	// re-enables the composer the moment the clock arrives), so this partial
	// mock has to serve it: the real hook needs a ClassicyAppManagerProvider
	// tree, which this file deliberately does not build.
	useClassicyDateTime: () => ({
		localDate: new Date(clockState.utcMs + clockState.tzOffset * 3_600_000),
		tzOffset: clockState.tzOffset,
	}),
```

Extend `renderChat`'s `overrides` type with `lastMessageAt?: number | null; nowUtcMs?: number;` and set them at the top of its body:

```ts
	imState.lastMessageAt = overrides.lastMessageAt ?? null;
	clockState.utcMs = overrides.nowUtcMs ?? Date.parse("2001-09-11T13:10:00Z");
```

Then add these tests to the `describe("ChatWindow", ...)` block:

```tsx
	it("closes the composer when the clock is rewound behind the conversation", () => {
		renderChat(1, {
			enabled: true,
			reason: "ok",
			lastMessageAt: Date.parse("2001-09-11T13:07:35Z"),
			nowUtcMs: Date.parse("2001-09-11T13:00:00Z"),
		});
		expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
		expect(
			screen.getByText(
				"You've traveled back before your last message. Chat resumes at 9:07:35 AM.",
			),
		).toBeTruthy();
		// The Send button goes with it — the field alone would still let Enter
		// through the click path.
		const send = screen.getByText("Send").closest("button");
		expect(send?.disabled).toBe(true);
	});

	it("reopens the composer once the clock reaches the conversation", () => {
		renderChat(1, {
			enabled: true,
			reason: "ok",
			lastMessageAt: Date.parse("2001-09-11T13:07:35Z"),
			nowUtcMs: Date.parse("2001-09-11T13:07:35Z"),
		});
		expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(false);
		expect(screen.queryByText(/traveled back/)).toBeNull();
	});

	it("leaves a conversation with no messages alone, however far back the clock is", () => {
		renderChat(1, {
			enabled: true,
			reason: "ok",
			lastMessageAt: null,
			nowUtcMs: Date.parse("2001-09-11T09:00:00Z"),
		});
		expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(false);
	});

	it("shows the rewind reason ahead of the paused-clock one", () => {
		// A Time Machine rewind usually pauses the clock too. "Start the clock to
		// keep talking." is true but not the blocker that outlives it.
		renderChat(1, {
			enabled: false,
			reason: "paused",
			lastMessageAt: Date.parse("2001-09-11T13:07:35Z"),
			nowUtcMs: Date.parse("2001-09-11T13:00:00Z"),
		});
		expect(screen.queryByText("Start the clock to keep talking.")).toBeNull();
		expect(screen.getByText(/traveled back/)).toBeTruthy();
	});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/ChatWindow.test.tsx
```

Expected: FAIL — the composer renders enabled and no `traveled back` text exists.

- [ ] **Step 3: Wire the component**

In `ChatWindow.tsx`, replace the Task 1 placeholder import with:

```ts
import { composeGate } from "./composeGate";
```

Add to the `classicy` import: `useClassicyDateTime`. Add:

```ts
import { virtualUtcMs } from "../../Providers/MediaStream/virtualClock";
```

Pull `lastMessageAtFor` out of `useIMBuddies()` alongside the existing destructured values, then replace the `const hint = composeHintFor(reason);` line with:

```tsx
	// This window reads the clock itself rather than taking it from the
	// provider. Two reasons: IMBuddiesProvider deliberately keeps localDate out
	// of its context value so that value is not rebuilt once a second for every
	// consumer, and the per-second re-render is exactly what re-enables the
	// composer the moment the clock reaches the conversation again.
	// virtualUtcMs strips the display offset back off (hard rule 3).
	const { localDate, tzOffset } = useClassicyDateTime({ tick: true });
	const { enabled: composeEnabled, hint } = composeGate({
		serverEnabled: enabled,
		reason,
		lastMessageAtMs: lastMessageAtFor(profile),
		nowMs: virtualUtcMs(localDate, tzOffset),
		tzOffsetHours: tzOffset,
	});
```

Replace all four `disabled={!enabled}` occurrences (emoticon picker buttons, the picker toggle, `ClassicyInput`, and the Send `ClassicyButton`) with `disabled={!composeEnabled}`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/
```

Expected: PASS — all IMBuddies suites.

- [ ] **Step 5: Full check**

```bash
pnpm --filter @rt911/frontend exec tsc -b --force
pnpm --filter @rt911/frontend exec eslint .
pnpm --filter @rt911/frontend test
```

Expected: all clean. If `tsc` reports an unused `enabled` or a missing dep, fix it rather than suppressing it.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/Applications/IMBuddies/ChatWindow.tsx \
        packages/frontend/src/Applications/IMBuddies/ChatWindow.test.tsx
git commit -m "feat(im-buddies): disable a rewound conversation's composer

The window reads the ticking clock itself, so the composer reopens on
its own the second the clock reaches the conversation again — and the
provider's context value stays free of the per-second churn.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Browser verification and the placeholder question

The spec's one open point: `ChatWindow` mirrors `hint` into the input's `placeholder`, and the blocked sentence is long for a 260px window. Tests cannot answer whether it looks acceptable.

**Files:**
- Possibly modify: `packages/frontend/src/Applications/IMBuddies/ChatWindow.tsx` (only if the placeholder looks bad)

**Interfaces:**
- Consumes: everything from Tasks 1–3. Produces nothing.

- [ ] **Step 1: Launch the desktop**

Use the `packages/frontend:verify` skill — it documents how to drive this app with Playwright MCP against the Vite dev server. Check who owns port 5173 before starting: stale servers squat it in this environment, and "the feature isn't showing" has meant "you're looking at a different app" here before.

- [ ] **Step 2: Reproduce the guard by hand**

1. Sign on to IM Buddies and open a conversation with a buddy.
2. Send a message; wait for the reply so the conversation has a mark.
3. Open Time Machine and rewind ten minutes.
4. Confirm: the field, Send, and the `:-)` button are all disabled, and the compose row reads `You've traveled back before your last message. Chat resumes at <time>.` with a time that matches the message you just exchanged.
5. Travel forward past that time. Confirm the composer re-enables without any further interaction.

- [ ] **Step 3: Judge the placeholder**

Screenshot the blocked window at its default 260px width. If the mirrored sentence in the disabled input reads as cramped or truncated mid-word, change the `placeholder` prop to a short constant while leaving the hint div's full sentence alone:

```tsx
	placeholder={composeEnabled ? "Type a message" : "Can't chat yet"}
```

If it looks fine, change nothing and say so.

- [ ] **Step 4: Commit any adjustment**

```bash
git add packages/frontend/src/Applications/IMBuddies/ChatWindow.tsx
git commit -m "fix(im-buddies): shorten the blocked composer's placeholder

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

Skip this step entirely if Step 3 changed nothing.

- [ ] **Step 5: Report**

Report to the user: the browser-verified behaviour, the placeholder decision, and the final `pnpm --filter @rt911/frontend test` count. Do not open a PR without being asked.

---

## Self-review

**Spec coverage.** Per-conversation scope → Task 2's mark keyed by profile, asserted in Task 2 Step 1 and Task 3's null-mark test. Monotonic mark surviving the seek wipe and `signOff` → Task 2. The 2s tolerance → Task 1. Blocked outranks wire reasons → Tasks 1 and 3. Resume time via `formatPlayhead`, seconds precision → Task 1. Window supplies the clock → Task 3. `send()` refuses → Task 2. `ChatStateReason` unchanged → no task touches it. Out-of-scope items (incoming messages, Buddy List, backend) → no task touches them. Open verification point → Task 4.

**Deviations from the spec, both deliberate.** `composeGate` takes an object including `serverEnabled` rather than the spec's four positional arguments, so it returns the single combined `enabled` the window needs. `composeHintFor` moves from `ChatWindow.tsx` to `composeGate.ts` to avoid an import cycle — the spec assumed it could stay put.

**Type consistency.** `lastMessageAtFor` returns `number | null` in Task 2 and is consumed as `lastMessageAtMs: number | null` in Tasks 1 and 3. `isRewound(lastMessageAtMs, nowMs)` has the same argument order in its definition (Task 1), its tests (Task 1), and its provider call site (Task 2). `composeGate`'s five input fields match between definition, tests, and the Task 3 call site.
