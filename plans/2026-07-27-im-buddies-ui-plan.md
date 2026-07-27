# IM Buddies Frontend UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the student-facing IM Buddies chat client as AOL Instant Messenger 4 for Mac — four windows on the existing Mac OS 8 desktop, replacing the `/chatdev` developer harness.

**Architecture:** The frontend has **no chat wiring at all** today, so this starts by adding the `chat` channel to `MediaStreamProvider` (the single WebSocket every app shares). Above it, one `ClassicyApp` owns four window types and one `IMBuddiesProvider` holds all chat state, so windows stay presentational and the socket has one owner.

**Tech Stack:** Vite + React 19 + TypeScript, `classicy` (external, pinned `"latest"`), vitest + Testing Library, SCSS modules.

**Design spec:** `plans/2026-07-27-im-buddies-ui-design.md`
**Mocks:** https://claude.ai/code/artifact/7eaf34c2-0ac5-431a-835d-fde7e05116d1

## Global Constraints

From `packages/frontend/CLAUDE.md` and the design spec. Every task's requirements implicitly include these.

- **Apps never open a second WebSocket or call the streamer directly.** Always go through `MediaStreamContext` / `useMediaStream`.
- **All clock writes go through `setDateTimeFromUtc`** in `TimeMachine/setVirtualClock.ts`. This feature only *reads* the clock — it must never write it.
- **Use `virtualUtcMs(localDate, tzOffset)`, never `localDate`,** when comparing against a wire timestamp or building one.
- **New subscription channels follow the ref-counted `Set<appId>` pattern** already used for pager/mp3/news/usenet/flights. Never a bare boolean.
- **`classicy` is external and pinned to `"latest"`; never hand-edit its version.**
- **Tests are co-located** (`Foo.test.tsx` next to `Foo.tsx`) and **must call `afterEach(cleanup)`** — this project has no RTL auto-cleanup, and `render()` queries bind to `document.body`.
- **App action types are namespaced**, e.g. `"ClassicyAppIMBuddiesSetX"`.
- **The password field is theatre.** It reads nothing and submits nothing. Say so in a comment so nobody later "fixes" it into real authentication.
- **Text and text emoticons only.** No bold, italic, font or colour anywhere in compose.
- Before every commit, from the repo root: `pnpm --filter @rt911/frontend exec tsc -b && pnpm --filter @rt911/frontend exec vitest run && pnpm --filter @rt911/frontend exec eslint .`

### Wire protocol — already shipped, do not change

Server→client is binary MessagePack; client→server is JSON text.

| Direction | Frame | Payload |
|---|---|---|
| → | `subscribe` / `unsubscribe` | `{channel: "chat"}` |
| → | `chat_send` | `{profile, body}` |
| → | `chat_history` | `{profile, before, limit}` |
| ← | `chat_roster` | `{buddies: [{profile, screen_name, display_name, avatar, online}]}` |
| ← | `chat_state` | `{enabled, reason}` — `ok`/`paused`/`outside_window`/`blocked`/`not_signed_in` |
| ← | `chat_presence` | `{profile, online}` |
| ← | `chat_typing` | `{profile}` |
| ← | `chat_message` | `{id, profile, direction, body, time, kind, message_id}` |
| ← | `chat_error` | `{code, message}` |

`chat_roster` omits `buddies` entirely when empty (`omitempty` on a field shared with the 1 Hz hot path) — treat an absent field as `[]`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/Providers/MediaStream/MediaStreamProvider.tsx` *(modify)* | chat channel: wire types, state, ref-counted subscribe, senders, frame handling |
| `src/Providers/MediaStream/MediaStreamContext.ts` *(modify)* | chat surface on the context value |
| `src/Applications/IMBuddies/emoticons.tsx` *(create)* | text emoticon → graphic, pure |
| `src/Applications/IMBuddies/sounds.ts` *(create)* | named sounds + the play helper |
| `src/Applications/IMBuddies/IMBuddiesProvider.tsx` *(create)* | all chat state; the only consumer of the chat channel |
| `src/Applications/IMBuddies/SignOnWindow.tsx` *(create)* | the costume |
| `src/Applications/IMBuddies/BuddyListWindow.tsx` *(create)* | roster, groups, status line |
| `src/Applications/IMBuddies/ChatWindow.tsx` *(create)* | one conversation |
| `src/Applications/IMBuddies/InfoWindow.tsx` *(create)* | Get Info |
| `src/Applications/IMBuddies/IMBuddies.tsx` *(create)* | `ClassicyApp`, window composition, menu bar |
| `src/Applications/IMBuddies/IMBuddies.module.scss` *(create)* | AIM-specific styling |
| `src/app.tsx` *(modify)* | register the app |
| `packages/backend/internal/chat/profile.go` *(modify)* | `ProfileText` field |
| `packages/backend/internal/model/chat.go` *(modify)* | `Buddy.ProfileText` on the roster frame |
| `packages/backend/apply-profile-text.mjs` *(create)* | the one schema addition |

---

## Task 1: Chat channel in MediaStreamProvider

The frontend has no chat wiring whatsoever. Everything else depends on this.

**Files:**
- Modify: `packages/frontend/src/Providers/MediaStream/MediaStreamProvider.tsx`
- Modify: `packages/frontend/src/Providers/MediaStream/MediaStreamContext.ts`
- Test: `packages/frontend/src/Providers/MediaStream/MediaStreamProvider.chat.test.tsx`

**Interfaces:**
- Consumes: `send`, `decodeWireMessage`, the `Set<appId>` subscribe pattern (copy `subscribeFlights`/`unsubscribeFlights` at ~line 540).
- Produces, on `MediaStreamContextValue`:
```ts
export type ChatStateReason = "ok" | "paused" | "outside_window" | "blocked" | "not_signed_in";

export interface ChatBuddy {
  profile: number;
  screen_name: string;
  display_name: string;
  avatar: string;
  online: boolean;
  profile_text?: string;
}

export interface ChatMessage {
  message_id: number;
  profile: number;
  direction: "in" | "out";
  body: string;
  time: string;   // RFC3339 virtual time
  kind: string;   // typed | generated | scheduled | static | stall | refused | truncated
}

// on MediaStreamContextValue:
chatBuddies: ChatBuddy[];
chatEnabled: boolean;
chatReason: ChatStateReason;
chatMessages: ChatMessage[];        // append-only; the app splits by profile
chatTypingProfile: number | null;   // cleared by the next chat_message
chatError: { code: string; message: string } | null;
subscribeChat: (appId: string) => void;
unsubscribeChat: (appId: string) => void;
sendChat: (profile: number, body: string) => void;
requestChatHistory: (profile: number, before: string, limit: number) => void;
```

- [ ] **Step 1: Write the failing test**

```tsx
// MediaStreamProvider.chat.test.tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, act } from "@testing-library/react";
import { useContext } from "react";
import { MediaStreamContext } from "./MediaStreamContext";
import { MediaStreamProvider } from "./MediaStreamProvider";
import { encode } from "@msgpack/msgpack";

afterEach(cleanup);

function Probe() {
  const c = useContext(MediaStreamContext);
  return (
    <div>
      <span data-testid="buddies">{c.chatBuddies.map((b) => b.screen_name).join(",")}</span>
      <span data-testid="reason">{c.chatReason}</span>
      <span data-testid="typing">{String(c.chatTypingProfile)}</span>
      <span data-testid="msgs">{c.chatMessages.map((m) => m.body).join("|")}</span>
    </div>
  );
}

// The test harness must expose the mock socket so a test can push frames.
// Follow MediaStreamProvider.news.test.tsx, which already stubs WebSocket.

describe("chat channel", () => {
  it("populates the roster from chat_roster", async () => {
    const ws = renderWithMockSocket(<Probe />);
    act(() => ws.receive(encode({ type: "chat_roster", buddies: [
      { profile: 1, screen_name: "skaterboi1988", display_name: "Danny", avatar: "", online: true },
    ]})));
    expect(screen.getByTestId("buddies").textContent).toBe("skaterboi1988");
  });

  it("treats an absent buddies field as an empty roster", async () => {
    // chat_roster omits `buddies` entirely when empty — the field rides
    // omitempty because it shares a struct with the 1 Hz items hot path.
    const ws = renderWithMockSocket(<Probe />);
    act(() => ws.receive(encode({ type: "chat_roster" })));
    expect(screen.getByTestId("buddies").textContent).toBe("");
  });

  it("applies chat_presence to an existing buddy without dropping the rest", async () => {
    const ws = renderWithMockSocket(<Probe />);
    act(() => ws.receive(encode({ type: "chat_roster", buddies: [
      { profile: 1, screen_name: "a", display_name: "", avatar: "", online: true },
      { profile: 2, screen_name: "b", display_name: "", avatar: "", online: true },
    ]})));
    act(() => ws.receive(encode({ type: "chat_presence", profile: 1, online: false })));
    expect(screen.getByTestId("buddies").textContent).toBe("a,b");
  });

  it("clears the typing indicator when the next message lands", async () => {
    const ws = renderWithMockSocket(<Probe />);
    act(() => ws.receive(encode({ type: "chat_typing", profile: 1 })));
    expect(screen.getByTestId("typing").textContent).toBe("1");
    act(() => ws.receive(encode({ type: "chat_message", profile: 1, direction: "out",
      body: "hi", time: "2001-09-11T13:00:00Z", kind: "generated", message_id: 7 })));
    expect(screen.getByTestId("typing").textContent).toBe("null");
  });

  it("carries chat_state through, defaulting to not_signed_in before any frame", async () => {
    const ws = renderWithMockSocket(<Probe />);
    expect(screen.getByTestId("reason").textContent).toBe("not_signed_in");
    act(() => ws.receive(encode({ type: "chat_state", enabled: true, reason: "ok" })));
    expect(screen.getByTestId("reason").textContent).toBe("ok");
  });

  it("only sends one subscribe no matter how many apps ask", async () => {
    const ws = renderWithMockSocket(<Probe />);
    act(() => { ws.ctx.subscribeChat("A"); ws.ctx.subscribeChat("B"); });
    expect(ws.sent.filter((m) => m.type === "subscribe" && m.channel === "chat")).toHaveLength(1);
    act(() => ws.ctx.unsubscribeChat("A"));
    expect(ws.sent.filter((m) => m.type === "unsubscribe")).toHaveLength(0);
    act(() => ws.ctx.unsubscribeChat("B"));
    expect(ws.sent.filter((m) => m.type === "unsubscribe" && m.channel === "chat")).toHaveLength(1);
  });
});
```

> `renderWithMockSocket` does not exist yet. Read `MediaStreamProvider.news.test.tsx` and reuse its WebSocket stub verbatim rather than inventing a second one; if it is inline there, lift it into a local helper in this file only.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Providers/MediaStream/MediaStreamProvider.chat.test.tsx`
Expected: FAIL — `chatBuddies` is not a property of the context value.

- [ ] **Step 3: Add the wire types**

In `MediaStreamProvider.tsx`, beside `WsFlightsMessage` (~line 133), add:

```ts
interface WsChatRosterMessage { type: "chat_roster"; buddies?: ChatBuddy[]; }
interface WsChatStateMessage { type: "chat_state"; enabled?: boolean; reason?: ChatStateReason; }
interface WsChatPresenceMessage { type: "chat_presence"; profile: number; online?: boolean; }
interface WsChatTypingMessage { type: "chat_typing"; profile: number; }
interface WsChatMessageFrame {
  type: "chat_message";
  profile: number; direction: "in" | "out"; body: string;
  time?: string; kind?: string; message_id?: number;
}
interface WsChatErrorMessage { type: "chat_error"; code?: string; message?: string; }
```

Add all six to the `WsIncomingMessage` union at line 166.

- [ ] **Step 4: Add state, subscribe pair and senders**

```ts
const [chatBuddies, setChatBuddies] = useState<ChatBuddy[]>([]);
const [chatEnabled, setChatEnabled] = useState(false);
// not_signed_in until the server says otherwise: assuming a working chat before
// the first chat_state would flash an enabled UI at someone who cannot use it.
const [chatReason, setChatReason] = useState<ChatStateReason>("not_signed_in");
const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
const [chatTypingProfile, setChatTypingProfile] = useState<number | null>(null);
const [chatError, setChatError] = useState<{ code: string; message: string } | null>(null);
const chatSubscribers = useRef<Set<string>>(new Set());

const subscribeChat = useCallback((appId: string) => {
  const wasEmpty = chatSubscribers.current.size === 0;
  chatSubscribers.current.add(appId);
  if (wasEmpty) send({ type: "subscribe", channel: "chat" });
}, [send]);

const unsubscribeChat = useCallback((appId: string) => {
  chatSubscribers.current.delete(appId);
  if (chatSubscribers.current.size === 0) send({ type: "unsubscribe", channel: "chat" });
}, [send]);

const sendChat = useCallback((profile: number, body: string) => {
  send({ type: "chat_send", profile, body });
}, [send]);

const requestChatHistory = useCallback((profile: number, before: string, limit: number) => {
  send({ type: "chat_history", profile, before, limit });
}, [send]);
```

- [ ] **Step 5: Handle the frames**

In `ws.onmessage`, after the `flights` block:

```ts
if (msg.type === "chat_roster") {
  // buddies rides omitempty on a struct shared with the 1 Hz items path, so an
  // empty roster arrives as an absent field rather than [].
  setChatBuddies((msg as WsChatRosterMessage).buddies ?? []);
  return;
}
if (msg.type === "chat_state") {
  const m = msg as WsChatStateMessage;
  setChatEnabled(m.enabled === true);
  setChatReason(m.reason ?? "not_signed_in");
  return;
}
if (msg.type === "chat_presence") {
  const m = msg as WsChatPresenceMessage;
  setChatBuddies((prev) =>
    prev.map((b) => (b.profile === m.profile ? { ...b, online: m.online === true } : b)));
  return;
}
if (msg.type === "chat_typing") {
  setChatTypingProfile((msg as WsChatTypingMessage).profile);
  return;
}
if (msg.type === "chat_message") {
  const m = msg as WsChatMessageFrame;
  // The reply is what ends the typing indicator — not a timer. The backend
  // sends chat_typing on accepting the job and the message when it lands.
  setChatTypingProfile(null);
  setChatMessages((prev) => [...prev, {
    message_id: m.message_id ?? 0,
    profile: m.profile,
    direction: m.direction,
    body: m.body,
    time: m.time ?? "",
    kind: m.kind ?? "generated",
  }]);
  return;
}
if (msg.type === "chat_error") {
  const m = msg as WsChatErrorMessage;
  setChatError({ code: m.code ?? "", message: m.message ?? "" });
  return;
}
```

Add every new value to the context `value` object and to `MediaStreamContextValue` in `MediaStreamContext.ts`, with the types from the Interfaces block above.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Providers/MediaStream/`
Expected: PASS, and every pre-existing MediaStream test still green.

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/src/Providers/MediaStream/
git commit -m "feat(chat): add the chat channel to MediaStreamProvider"
```

---

## Task 2: `profile_text` — the one backend addition

Get Info cannot show `persona` verbatim: it is written as a second-person instruction to a model ("You are Danny, 13, in eighth grade…"). Showing it would leak the mechanism and read as nonsense.

**Files:**
- Modify: `packages/backend/internal/model/chat.go`
- Modify: `packages/backend/internal/chat/profile.go`
- Create: `packages/backend/apply-profile-text.mjs`
- Test: `packages/backend/internal/chat/profile_test.go`

**Interfaces:**
- Produces: `Profile.ProfileText string`; `model.Buddy.ProfileText string` with json tag `profile_text`; `Roster` copies it through.

- [ ] **Step 1: Write the failing test**

```go
func TestRosterCarriesProfileText(t *testing.T) {
	// Get Info needs student-facing prose. It must never fall back to Persona,
	// which is a second-person instruction to a model and would leak the
	// mechanism -- an empty profile is a curation gap, a leaked persona is a
	// broken illusion.
	got := Roster([]Profile{{
		ID: 1, ScreenName: "danny",
		Persona:     "You are Danny, 13, in eighth grade in Columbus.",
		ProfileText: "13. eighth grade. tony hawk pro skater 3 is the best game ever made.",
	}}, WindowStart.Add(time.Hour))

	if got[0].ProfileText != "13. eighth grade. tony hawk pro skater 3 is the best game ever made." {
		t.Errorf("ProfileText = %q", got[0].ProfileText)
	}
}

func TestRosterLeavesProfileTextEmptyRatherThanUsingPersona(t *testing.T) {
	got := Roster([]Profile{{ID: 1, ScreenName: "danny", Persona: "You are Danny."}},
		WindowStart.Add(time.Hour))

	if got[0].ProfileText != "" {
		t.Errorf("ProfileText must stay empty, got %q", got[0].ProfileText)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/backend && go test ./internal/chat/ -run RosterCarriesProfileText`
Expected: compile failure — `ProfileText` undefined.

- [ ] **Step 3: Implement**

`internal/model/chat.go` — add to `Buddy`:
```go
	ProfileText string `json:"profile_text,omitempty"`
```

`internal/chat/profile.go` — add `ProfileText string` to `Profile`, add `profile_text` to `profileSelect` (last column), scan it into a `*string` local and `derefStr` it, and copy it in `Roster`:
```go
			ProfileText: p.ProfileText,
```

**Walk the SELECT and Scan lists position by position after editing.** A mismatch compiles fine and loads wrong data into wrong fields.

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/backend && go build ./... && go vet ./... && go test ./... -race`
Expected: PASS.

- [ ] **Step 5: Write the schema script**

`apply-profile-text.mjs`, modelled exactly on `apply-broadcast-markets.mjs`: dry-run by default, `--apply` to write, required env with no localhost fallback. It adds one nullable field:

```js
const FIELD = {
  collection: "chat_profiles",
  field: "profile_text",
  type: "text",
  meta: {
    interface: "input-multiline",
    note: "What a student sees in Get Info. Write it as the buddy would describe themselves — NOT the persona, which is an instruction to the model.",
  },
  schema: { is_nullable: true },
};
```

Do **not** apply it to production in this task; that is a human step.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/internal/model/chat.go packages/backend/internal/chat/ packages/backend/apply-profile-text.mjs
git commit -m "feat(chat): add profile_text for the Get Info window"
```

---

## Task 3: Emoticon rendering

What real AIM did, and free: personas already instruct buddies to write `:-)`, and `Sanitize` guarantees only ASCII survives.

**Files:**
- Create: `packages/frontend/src/Applications/IMBuddies/emoticons.tsx`
- Test: `packages/frontend/src/Applications/IMBuddies/emoticons.test.tsx`

**Interfaces:**
- Produces: `renderEmoticons(text: string): ReactNode[]` and `EMOTICONS: ReadonlyArray<[string, string]>` (token → accessible label).

- [ ] **Step 1: Write the failing test**

```tsx
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { renderEmoticons } from "./emoticons";

afterEach(cleanup);

const shown = (text: string) => {
  render(<p data-testid="out">{renderEmoticons(text)}</p>);
  return screen.getByTestId("out");
};

describe("renderEmoticons", () => {
  it("replaces a known emoticon with a graphic", () => {
    expect(shown("im scared :-(").querySelectorAll("[data-emoticon]")).toHaveLength(1);
  });

  it("keeps the surrounding words intact", () => {
    expect(shown("im scared :-(").textContent).toContain("im scared");
  });

  it("leaves an unmapped token as typed", () => {
    const el = shown("what :-P");
    expect(el.querySelectorAll("[data-emoticon]")).toHaveLength(0);
    expect(el.textContent).toBe("what :-P");
  });

  it("does not fire inside a word", () => {
    // A URL or a timestamp must not sprout a face. Sanitize strips URLs, but
    // "8:30" reaching this must stay text.
    const el = shown("meet at 8:30");
    expect(el.querySelectorAll("[data-emoticon]")).toHaveLength(0);
  });

  it("handles several in one message", () => {
    expect(shown(":-) hi :-)").querySelectorAll("[data-emoticon]")).toHaveLength(2);
  });

  it("returns plain text unchanged", () => {
    expect(shown("just words").textContent).toBe("just words");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/emoticons.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
import type { ReactNode } from "react";
import styles from "./IMBuddies.module.scss";

/**
 * Text emoticons AIM rendered as faces. Longest-first so ":-)" wins over ":)".
 * The label is what a screen reader announces in place of the graphic.
 */
export const EMOTICONS: ReadonlyArray<[string, string]> = [
  [":-)", "smiling"], [":-(", "frowning"], [";-)", "winking"],
  [":-/", "unsure"], [":-O", "surprised"], ["<3", "heart"],
  [":)", "smiling"], [":(", "frowning"],
];

// Word-boundary-ish: an emoticon must not fire inside a token, so "8:30" stays
// a time. Preceded by start-or-space, followed by end-or-space.
const PATTERN = new RegExp(
  `(^|\\s)(${EMOTICONS.map(([t]) => t.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")).join("|")})(?=\\s|$)`,
  "g",
);

const LABELS = new Map(EMOTICONS);

export function renderEmoticons(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(PATTERN)) {
    const at = (m.index ?? 0) + m[1].length;
    if (at > last) out.push(text.slice(last, at));
    const token = m[2];
    out.push(
      <span
        key={`e${key++}`}
        data-emoticon={token}
        className={styles.emoticon}
        role="img"
        aria-label={LABELS.get(token) ?? token}
      />,
    );
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
```

Add to `IMBuddies.module.scss`:
```scss
.emoticon {
  display: inline-block; width: 13px; height: 13px; vertical-align: -2px;
  border-radius: 50%; background: #ffcc33; border: 1px solid #b8860b;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/emoticons.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/IMBuddies/
git commit -m "feat(chat): render text emoticons as AIM smileys"
```

---

## Task 4: Sound registry

Assets are supplied separately. This task defines the names, the registration, and the two rules that keep them from misfiring.

**Files:**
- Create: `packages/frontend/src/Applications/IMBuddies/sounds.ts`
- Test: `packages/frontend/src/Applications/IMBuddies/sounds.test.ts`

**Interfaces:**
- Produces:
```ts
export const IM_SOUNDS = {
  signOn: "IMBuddiesSignOn",
  buddyIn: "IMBuddiesBuddyIn",
  buddyOut: "IMBuddiesBuddyOut",
  receive: "IMBuddiesReceive",
  send: "IMBuddiesSend",
} as const;

export function presenceSounds(
  prev: ReadonlyMap<number, boolean> | null,
  next: ReadonlyMap<number, boolean>,
): string[];
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { IM_SOUNDS, presenceSounds } from "./sounds";

const m = (o: Record<number, boolean>) => new Map(Object.entries(o).map(([k, v]) => [Number(k), v]));

describe("presenceSounds", () => {
  it("plays nothing for the first roster", () => {
    // Connecting at 9:15 with two buddies already online must not fire two
    // door-opens. Sounds mark a CHANGE, and the first roster is not a change.
    expect(presenceSounds(null, m({ 1: true, 2: true }))).toEqual([]);
  });

  it("plays the door opening when a buddy comes online", () => {
    expect(presenceSounds(m({ 1: false }), m({ 1: true }))).toEqual([IM_SOUNDS.buddyIn]);
  });

  it("plays the door closing when a buddy goes offline", () => {
    expect(presenceSounds(m({ 1: true }), m({ 1: false }))).toEqual([IM_SOUNDS.buddyOut]);
  });

  it("plays nothing when nothing changed", () => {
    expect(presenceSounds(m({ 1: true, 2: false }), m({ 1: true, 2: false }))).toEqual([]);
  });

  it("plays once per buddy that changed", () => {
    const got = presenceSounds(m({ 1: false, 2: true }), m({ 1: true, 2: false }));
    expect(got).toHaveLength(2);
    expect(got).toContain(IM_SOUNDS.buddyIn);
    expect(got).toContain(IM_SOUNDS.buddyOut);
  });

  it("ignores a buddy that appeared for the first time", () => {
    // A new profile added mid-session is not someone walking through a door.
    expect(presenceSounds(m({ 1: true }), m({ 1: true, 2: true }))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/sounds.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Named sounds registered with Classicy's sound manager. Assets are supplied
 * separately and loaded with ClassicySoundLoad; these names are what the app
 * plays by, and what ClassicySoundDisableOne mutes by.
 */
export const IM_SOUNDS = {
  signOn: "IMBuddiesSignOn",
  buddyIn: "IMBuddiesBuddyIn",
  buddyOut: "IMBuddiesBuddyOut",
  receive: "IMBuddiesReceive",
  send: "IMBuddiesSend",
} as const;

/**
 * Which door sounds a roster change earns.
 *
 * `prev === null` means this is the first roster of the session and returns
 * nothing: connecting mid-morning with buddies already online must not fire a
 * door-open for each. A buddy appearing for the first time is likewise silent —
 * that is configuration arriving, not somebody signing on.
 */
export function presenceSounds(
  prev: ReadonlyMap<number, boolean> | null,
  next: ReadonlyMap<number, boolean>,
): string[] {
  if (prev === null) return [];
  const out: string[] = [];
  for (const [profile, online] of next) {
    if (!prev.has(profile)) continue;
    const was = prev.get(profile);
    if (was === online) continue;
    out.push(online ? IM_SOUNDS.buddyIn : IM_SOUNDS.buddyOut);
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/sounds.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/IMBuddies/sounds.ts packages/frontend/src/Applications/IMBuddies/sounds.test.ts
git commit -m "feat(chat): define IM Buddies sound names and presence triggers"
```

---

## Task 5: IMBuddiesProvider

All chat state. Every window reads from here; none touches the socket.

**Files:**
- Create: `packages/frontend/src/Applications/IMBuddies/IMBuddiesProvider.tsx`
- Test: `packages/frontend/src/Applications/IMBuddies/IMBuddiesProvider.test.tsx`

**Interfaces:**
- Consumes: `MediaStreamContext` (Task 1), `presenceSounds`/`IM_SOUNDS` (Task 4), `shouldSeek` from `Providers/MediaStream/seekDetection`, `virtualUtcMs` from `Providers/MediaStream/virtualClock`, `useClassicyDateTime`.
- Produces:
```ts
export interface Conversation { messages: ChatMessage[]; unread: number; }

export interface IMBuddiesValue {
  connected: boolean;
  enabled: boolean;
  reason: ChatStateReason;
  buddies: ChatBuddy[];
  conversationFor: (profile: number) => Conversation;
  typingProfile: number | null;
  openChats: number[];
  openInfo: number[];
  signOn: () => void;
  signOff: () => void;
  openChat: (profile: number) => void;
  closeChat: (profile: number) => void;
  openInfoFor: (profile: number) => void;
  closeInfoFor: (profile: number) => void;
  send: (profile: number, body: string) => void;
  markRead: (profile: number) => void;
}

export function useIMBuddies(): IMBuddiesValue;
export const IMBuddiesProvider: React.FC<{ children: ReactNode }>;
```

- [ ] **Step 1: Write the failing test**

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, act } from "@testing-library/react";
import { IMBuddiesProvider, useIMBuddies } from "./IMBuddiesProvider";

afterEach(cleanup);

// Stub MediaStreamContext with a controllable value; see
// src/Applications/Alerts/Alerts.test.tsx for the established mocking shape.

function Probe() {
  const im = useIMBuddies();
  return (
    <div>
      <span data-testid="open">{im.openChats.join(",")}</span>
      <span data-testid="unread1">{im.conversationFor(1).unread}</span>
      <span data-testid="msgs1">{im.conversationFor(1).messages.map((m) => m.body).join("|")}</span>
    </div>
  );
}

describe("IMBuddiesProvider", () => {
  it("splits the flat message list per conversation", () => {
    renderWithChat(<Probe />, { chatMessages: [
      { message_id: 1, profile: 1, direction: "out", body: "hi", time: "", kind: "generated" },
      { message_id: 2, profile: 2, direction: "out", body: "other", time: "", kind: "generated" },
    ]});
    expect(screen.getByTestId("msgs1").textContent).toBe("hi");
  });

  it("counts unread for a conversation with no open window", () => {
    renderWithChat(<Probe />, { chatMessages: [
      { message_id: 1, profile: 1, direction: "out", body: "hi", time: "", kind: "generated" },
    ]});
    expect(screen.getByTestId("unread1").textContent).toBe("1");
  });

  it("clears unread when the window is opened", () => {
    const { ctx } = renderWithChat(<Probe />, { chatMessages: [
      { message_id: 1, profile: 1, direction: "out", body: "hi", time: "", kind: "generated" },
    ]});
    act(() => ctx.openChat(1));
    expect(screen.getByTestId("unread1").textContent).toBe("0");
  });

  it("opening an already-open chat does not duplicate the window", () => {
    const { ctx } = renderWithChat(<Probe />, {});
    act(() => { ctx.openChat(1); ctx.openChat(1); });
    expect(screen.getByTestId("open").textContent).toBe("1");
  });

  it("keeps the transcript when a window closes", () => {
    const { ctx } = renderWithChat(<Probe />, { chatMessages: [
      { message_id: 1, profile: 1, direction: "out", body: "hi", time: "", kind: "generated" },
    ]});
    act(() => { ctx.openChat(1); ctx.closeChat(1); });
    expect(screen.getByTestId("msgs1").textContent).toBe("hi");
  });

  it("re-requests history for every open conversation on a backward seek", () => {
    // Seeking back must make a buddy stop remembering what has not happened.
    // shouldSeek() already encodes the asymmetry: forward needs 90s, backward
    // only 2s, because moving back even ten seconds can leave messages from
    // after the new time on screen.
    const { ctx, requestChatHistory, setClock } = renderWithChat(<Probe />, {});
    act(() => { ctx.openChat(1); ctx.openChat(2); });
    requestChatHistory.mockClear();
    act(() => setClock("2001-09-11T12:40:00Z")); // backwards
    expect(requestChatHistory).toHaveBeenCalledTimes(2);
  });

  it("plays the receive sound only for a conversation with no open window", () => {
    // The sound exists to catch a message the student cannot currently see.
    // One for an open window would be noise on top of the message they are
    // already reading.
    const { ctx, playSound, pushMessage } = renderWithChat(<Probe />, {});
    act(() => ctx.openChat(1));
    playSound.mockClear();
    act(() => pushMessage({ profile: 1, direction: "out", body: "seen" }));
    expect(playSound).not.toHaveBeenCalledWith(IM_SOUNDS.receive);
    act(() => pushMessage({ profile: 2, direction: "out", body: "unseen" }));
    expect(playSound).toHaveBeenCalledWith(IM_SOUNDS.receive);
  });

  it("does not re-request history on ordinary forward ticks", () => {
    const { ctx, requestChatHistory, setClock } = renderWithChat(<Probe />, {});
    act(() => ctx.openChat(1));
    requestChatHistory.mockClear();
    act(() => setClock("2001-09-11T13:00:01Z")); // one second later
    expect(requestChatHistory).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/IMBuddiesProvider.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Key points, in order:

1. `subscribeChat("IMBuddies.app")` on `signOn`, `unsubscribeChat` on `signOff` and unmount.
2. Derive `conversations` from the flat `chatMessages` with `useMemo`, grouping by `profile`.
3. `unread` counts inbound-to-student messages (`direction === "out"`, i.e. from the buddy) whose `message_id` is above a per-profile `readMark`. `openChat` and `markRead` set the mark to the newest id.
4. Presence sounds: keep a `useRef<Map<number, boolean> | null>(null)`, feed `presenceSounds(prev, next)` on every roster/presence change, dispatch each with `useSoundDispatch()`, then store `next`. `null` on the first pass is what suppresses the initial-roster burst.
5. **The receive sound.** When a `chat_message` arrives whose conversation has no
   open window, play `IM_SOUNDS.receive`. This reuses the unread signal already
   computed in point 3 rather than asking Classicy which window is frontmost —
   simpler, and it fires in exactly the case that matters: a message a student
   cannot currently see. A message for a window that is open is silent.
6. Backward-seek history: keep `useRef(prevUtcMs)`, and on clock change call `shouldSeek(prev, now)`. **Use `shouldSeek` rather than comparing thresholds by hand** — it already encodes the forward/backward asymmetry. On a seek, call `requestChatHistory(profile, isoOfNow, 40)` for each open chat.
7. Read the clock with `useClassicyDateTime({ tick: true })` and convert with `virtualUtcMs(localDate, tzOffset)` — never compare `localDate` to a wire timestamp (frontend hard rule 3).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/IMBuddies/
git commit -m "feat(chat): add IMBuddiesProvider, the single owner of chat state"
```

---

## Task 6: Sign On window

**Files:**
- Create: `packages/frontend/src/Applications/IMBuddies/SignOnWindow.tsx`
- Test: `packages/frontend/src/Applications/IMBuddies/SignOnWindow.test.tsx`

**Interfaces:**
- Consumes: `useIMBuddies()`, `useAuth()` from `Providers/Auth/AuthContext`, `useAppManagerDispatch` to open the Account app.
- Produces: `SignOnWindow: React.FC` rendering a `ClassicyWindow` with `id="im_signon"`.

- [ ] **Step 1: Write the failing test**

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SignOnWindow } from "./SignOnWindow";

afterEach(cleanup);

describe("SignOnWindow", () => {
  it("shows the student's screen name", () => {
    renderSignOn({ user: { username: "skaterboi1988" } });
    expect(screen.getByText("skaterboi1988")).toBeTruthy();
  });

  it("connects when Sign On is pressed", () => {
    const { signOn } = renderSignOn({ user: { username: "me" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign On" }));
    expect(signOn).toHaveBeenCalled();
  });

  it("opens the Account app instead of connecting when not signed in", () => {
    // The one place real credentials are handled. Pretending to authenticate
    // here would be the costume lying about what it is.
    const { signOn, openApp } = renderSignOn({ user: null, reason: "not_signed_in" });
    fireEvent.click(screen.getByRole("button", { name: "Sign On" }));
    expect(signOn).not.toHaveBeenCalled();
    expect(openApp).toHaveBeenCalledWith("Account.app");
  });

  it("submits nothing from the password field", () => {
    // It is theatre: fixed bullets over a value nobody typed, read by nothing.
    const { signOn } = renderSignOn({ user: { username: "me" } });
    const pw = screen.getByLabelText("Password") as HTMLInputElement;
    expect(pw.readOnly || pw.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Sign On" }));
    expect(signOn).toHaveBeenCalledWith();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/SignOnWindow.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

A `ClassicyWindow` (`closable`, not resizable, not zoomable) containing: the running-man SVG inline; a `ClassicyPopUpMenu` of one item showing `user.username` plus an `Edit…` item opening `Account.app`; a **disabled** password input whose value is a fixed bullet run with `aria-label="Password"`; two inert `ClassicyCheckbox`es; and `Setup` / `Help` / `Sign On` buttons where only `Sign On` is wired. A
successful connect plays `IM_SOUNDS.signOn`.

Comment the password field explicitly:
```tsx
{/*
  Theatre. Renders bullets over a value nobody typed; nothing reads it and
  nothing submits it. Authentication is the Directus session cookie the browser
  already holds. Do not wire this to anything.
*/}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/SignOnWindow.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/IMBuddies/SignOnWindow*
git commit -m "feat(chat): add the AIM sign-on window"
```

---

## Task 7: Buddy List window

**Files:**
- Create: `packages/frontend/src/Applications/IMBuddies/BuddyListWindow.tsx`
- Test: `packages/frontend/src/Applications/IMBuddies/BuddyListWindow.test.tsx`

**Interfaces:**
- Consumes: `useIMBuddies()`.
- Produces: `BuddyListWindow: React.FC`, `ClassicyWindow` `id="im_buddylist"`; `statusLineFor(reason: ChatStateReason, windowStartLabel: string): string` exported for its own test.

- [ ] **Step 1: Write the failing test**

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BuddyListWindow, statusLineFor } from "./BuddyListWindow";

afterEach(cleanup);

describe("statusLineFor", () => {
  it("explains each refusal in one sentence", () => {
    expect(statusLineFor("outside_window", "8:00 AM")).toBe("Nobody is online until 8:00 AM.");
    expect(statusLineFor("paused", "8:00 AM")).toBe("Clock paused.");
    expect(statusLineFor("blocked", "8:00 AM")).toBe("You can't send messages right now.");
  });

  it("says when it signed on rather than nothing", () => {
    expect(statusLineFor("ok", "8:00 AM")).toMatch(/Signed on/);
  });
});

describe("BuddyListWindow", () => {
  it("groups online buddies with a count", () => {
    renderBuddyList({ buddies: [
      { profile: 1, screen_name: "a", display_name: "", avatar: "", online: true },
      { profile: 2, screen_name: "b", display_name: "", avatar: "", online: false },
    ]});
    expect(screen.getByText("Buddies (1/2)")).toBeTruthy();
  });

  it("opens a chat on double-click", () => {
    const { openChat } = renderBuddyList({ buddies: [
      { profile: 1, screen_name: "a", display_name: "", avatar: "", online: true },
    ]});
    fireEvent.doubleClick(screen.getByText("a"));
    expect(openChat).toHaveBeenCalledWith(1);
  });

  it("does not open a chat for an offline buddy", () => {
    const { openChat } = renderBuddyList({ buddies: [
      { profile: 1, screen_name: "a", display_name: "", avatar: "", online: false },
    ]});
    fireEvent.doubleClick(screen.getByText("a"));
    expect(openChat).not.toHaveBeenCalled();
  });

  it("disables IM and Info with nothing selected", () => {
    renderBuddyList({ buddies: [] });
    expect((screen.getByRole("button", { name: "IM" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/BuddyListWindow.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
export function statusLineFor(reason: ChatStateReason, windowStartLabel: string): string {
  switch (reason) {
    case "outside_window": return `Nobody is online until ${windowStartLabel}.`;
    case "paused":         return "Clock paused.";
    case "blocked":        return "You can't send messages right now.";
    case "not_signed_in":  return "Not signed on.";
    default:               return "Signed on.";
  }
}
```

The window renders a `Buddies (online/total)` group and an `Offline (n)` group, each row showing a dot and the screen name, offline rows greyed. Selection is local state; `IM` and `Info` act on it and are disabled when the selection is empty or offline. The status line sits under a rule at the bottom.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/BuddyListWindow.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/IMBuddies/BuddyListWindow*
git commit -m "feat(chat): add the buddy list window"
```

---

## Task 8: Chat window

**Files:**
- Create: `packages/frontend/src/Applications/IMBuddies/ChatWindow.tsx`
- Test: `packages/frontend/src/Applications/IMBuddies/ChatWindow.test.tsx`

**Interfaces:**
- Consumes: `useIMBuddies()`, `renderEmoticons` (Task 3), `IM_SOUNDS` (Task 4).
- Produces: `ChatWindow: React.FC<{ profile: number }>`, `ClassicyWindow` `id={"im_chat_" + profile}`; `composeHintFor(reason: ChatStateReason): string`.

- [ ] **Step 1: Write the failing test**

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatWindow, composeHintFor } from "./ChatWindow";

afterEach(cleanup);

describe("composeHintFor", () => {
  it("gives a different sentence per refusal", () => {
    expect(composeHintFor("paused")).toBe("Start the clock to keep talking.");
    expect(composeHintFor("outside_window")).toBe("Nobody is online right now.");
    expect(composeHintFor("blocked")).toBe("You can't send messages right now.");
    expect(composeHintFor("ok")).toBe("");
  });
});

describe("ChatWindow", () => {
  it("sends on Enter and clears the field", () => {
    const { send } = renderChat(1, { enabled: true, reason: "ok" });
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "hey" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(send).toHaveBeenCalledWith(1, "hey");
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("does not send an empty message", () => {
    const { send, playSound } = renderChat(1, { enabled: true, reason: "ok" });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(send).not.toHaveBeenCalled();
    // and no sound either -- a keystroke that does nothing must not chirp
    expect(playSound).not.toHaveBeenCalled();
  });

  it("plays the send sound when a message actually goes", () => {
    const { playSound } = renderChat(1, { enabled: true, reason: "ok" });
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "hey" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(playSound).toHaveBeenCalledWith(IM_SOUNDS.send);
  });

  it("disables compose and explains why when the clock is paused", () => {
    renderChat(1, { enabled: false, reason: "paused" });
    expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Start the clock to keep talking.")).toBeTruthy();
  });

  it("shows the typing indicator only for its own buddy", () => {
    renderChat(1, { enabled: true, reason: "ok", typingProfile: 2 });
    expect(screen.queryByText(/is typing/)).toBeNull();
  });

  it("renders a stall message as the buddy speaking", () => {
    // Queue-full arrives as a normal chat_message with kind "stall". It is
    // meant to read as the buddy, so it gets no special treatment.
    renderChat(1, { enabled: true, reason: "ok", messages: [
      { message_id: 1, profile: 1, direction: "out", body: "hang on, phones ringing",
        time: "", kind: "stall" },
    ]});
    expect(screen.getByText(/hang on, phones ringing/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/ChatWindow.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
export function composeHintFor(reason: ChatStateReason): string {
  switch (reason) {
    case "paused":         return "Start the clock to keep talking.";
    case "outside_window": return "Nobody is online right now.";
    case "blocked":        return "You can't send messages right now.";
    case "not_signed_in":  return "Sign on to send messages.";
    default:               return "";
  }
}
```

The transcript lists each message as `<name>: <body>` with `renderEmoticons(body)`, scrolled to the bottom on change. The typing line renders only when `typingProfile === profile`. Compose is one input plus a smiley picker and a Send button, all disabled when `!enabled`, with `composeHintFor(reason)` shown in place of the field's placeholder. Send calls `send(profile, text.trim())`, plays `IM_SOUNDS.send` via
`useSoundDispatch()`, and clears the field.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/ChatWindow.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/IMBuddies/ChatWindow*
git commit -m "feat(chat): add the per-buddy chat window"
```

---

## Task 9: Get Info window

**Files:**
- Create: `packages/frontend/src/Applications/IMBuddies/InfoWindow.tsx`
- Test: `packages/frontend/src/Applications/IMBuddies/InfoWindow.test.tsx`

**Interfaces:**
- Consumes: `useIMBuddies()`, `ChatBuddy.profile_text` (Task 2).
- Produces: `InfoWindow: React.FC<{ profile: number }>`, `ClassicyWindow` `id={"im_info_" + profile}`.

- [ ] **Step 1: Write the failing test**

```tsx
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { InfoWindow } from "./InfoWindow";

afterEach(cleanup);

describe("InfoWindow", () => {
  it("shows the student-facing profile", () => {
    renderInfo(1, { profile: 1, screen_name: "skaterboi1988", display_name: "Danny",
      avatar: "", online: true, profile_text: "13. eighth grade." });
    expect(screen.getByText(/13\. eighth grade\./)).toBeTruthy();
  });

  it("says nothing rather than something wrong when there is no profile", () => {
    // profile_text is deliberately allowed to be empty. Falling back to the
    // persona would print a second-person instruction to a model at a student.
    renderInfo(1, { profile: 1, screen_name: "a", display_name: "", avatar: "", online: true });
    expect(screen.getByText("No profile.")).toBeTruthy();
  });

  it("shows whether they are online", () => {
    renderInfo(1, { profile: 1, screen_name: "a", display_name: "", avatar: "", online: false });
    expect(screen.getByText(/Offline/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/InfoWindow.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

A small non-resizable `ClassicyWindow` titled `Info: <screen_name>` showing the screen name, display name, online state, and `profile_text` in a bordered read-only area — or the literal string `No profile.` when it is empty. **Never fall back to `persona`.**

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/InfoWindow.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/Applications/IMBuddies/InfoWindow*
git commit -m "feat(chat): add the Get Info window"
```

---

## Task 10: Compose the app, menu bar, and register it

**Files:**
- Create: `packages/frontend/src/Applications/IMBuddies/IMBuddies.tsx`
- Create: `packages/frontend/src/Applications/IMBuddies/app.png` (copy an existing app icon as a placeholder; art to follow)
- Modify: `packages/frontend/src/app.tsx`
- Test: `packages/frontend/src/Applications/IMBuddies/IMBuddies.test.tsx`

**Interfaces:**
- Consumes: every window from Tasks 6–9, `IMBuddiesProvider` (Task 5).
- Produces: `IMBuddies: React.FC` — `ClassicyApp` `id="IMBuddies.app"`, `defaultWindow="im_signon"`.

- [ ] **Step 1: Write the failing test**

```tsx
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { IMBuddies } from "./IMBuddies";

afterEach(cleanup);

describe("IMBuddies", () => {
  it("starts on the sign-on window", () => {
    renderApp({ connected: false });
    expect(screen.getByText("Instant Messenger")).toBeTruthy();
  });

  it("shows the buddy list once connected", () => {
    renderApp({ connected: true });
    expect(screen.getByText("Buddy List")).toBeTruthy();
  });

  it("renders one chat window per open conversation", () => {
    renderApp({ connected: true, openChats: [1, 2], buddies: [
      { profile: 1, screen_name: "a", display_name: "", avatar: "", online: true },
      { profile: 2, screen_name: "b", display_name: "", avatar: "", online: true },
    ]});
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
  });

  it("does not render a chat window for a closed conversation", () => {
    renderApp({ connected: true, openChats: [] });
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rt911/frontend exec vitest run src/Applications/IMBuddies/IMBuddies.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`IMBuddies.tsx` wraps everything in `IMBuddiesProvider` inside a `ClassicyApp` (`id="IMBuddies.app"`, `name="Instant Messenger"`, `defaultWindow="im_signon"`), then renders `SignOnWindow` when not connected, `BuddyListWindow` when connected, and maps `openChats` / `openInfo` to `ChatWindow` / `InfoWindow`.

The menu bar uses `ClassicyMenuBarExtension` — **the first use in this repo**, so read its props from `node_modules/classicy/dist/classicy.es.js` before writing:

- **People** — New Message, Get Info, Sign Off
- **Window** — Buddy List, then one item per open chat

Include `quitMenuItemHelper(appId, appName, appIcon)` in the app menu, as every other app does.

- [ ] **Step 4: Register it**

In `src/app.tsx`, import `IMBuddies` and render it inside `ClassicyDesktop` alongside the other applications.

- [ ] **Step 5: Run the whole suite**

Run from the repo root:
```bash
pnpm --filter @rt911/frontend exec tsc -b
pnpm --filter @rt911/frontend exec vitest run
pnpm --filter @rt911/frontend exec eslint .
```
Expected: `tsc` clean, every test green (1,725 existing plus the new ones), no new eslint errors.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/Applications/IMBuddies/ packages/frontend/src/app.tsx
git commit -m "feat(chat): add the IM Buddies app to the desktop"
```

---

## Verification before merge

- [ ] `tsc -b` clean; full vitest suite green; `eslint .` no new errors.
- [ ] `go build ./... && go vet ./... && go test ./... -race` green in `packages/backend` (Task 2 touched it).
- [ ] Sign On → Buddy List → double-click a buddy → send → reply arrives in that buddy's window.
- [ ] Two chat windows open at once, each showing only its own conversation.
- [ ] Typing indicator appears on send and is cleared by the reply, not a timer.
- [ ] Pause the clock: buddies grey out, the status line says `Clock paused.`, compose disables, and the open window keeps its transcript.
- [ ] Seek backwards past 2 seconds: history is re-requested and messages from after the new time disappear.
- [ ] A text emoticon typed by a buddy renders as a face; `8:30` does not.
- [ ] Get Info shows `profile_text`, or `No profile.` — never the persona.
- [ ] With `chat_profiles.profile_text` unapplied, Get Info still renders (the field is absent, not broken).

## Deliberately out of scope

- **Away messages, idle, Warn, Block, chat rooms, buddy icons.** See the design spec.
- **Sound assets.** Names and triggers ship here; the audio is supplied separately and registered with `ClassicySoundLoad`.
- **Removing the `/chatdev` harness** and its `CHAT_DEV_UI` / `CHAT_TRUSTED_ORIGINS` infra entries. Do that once this app is exercised in a browser, not before.
- **Mobile.** `src/Mobile/` is a separate shell.
