# Block IM Buddies sending while the virtual clock is paused

**Date:** 2026-07-28
**Status:** Approved, not yet implemented

## Problem

Pausing the virtual clock — Time Machine's Pause button — does not stop a
student sending IM Buddies messages. The clock freezes, the desktop stops
advancing, and the chat composer stays fully usable.

## Root cause

This is not a missing feature. It is a missing **frame**.

Every other piece already exists:

| Piece | Where | State |
|---|---|---|
| `{"type":"pause"}` in the wire protocol | `packages/backend/docs/websocket-protocol.md` §`pause` | documented |
| Server route | `internal/handler/ws.go:529` | implemented |
| `Session.Pause()` sets `s.paused`, pushes fresh `chat_state` | `internal/session/session.go:564` | implemented |
| Gate returns `(false, "paused")` | `internal/chat/availability.go:29` | implemented |
| Composer hint "Start the clock to keep talking." | `Applications/IMBuddies/composeGate.ts:27` | implemented |
| Buddy-list status "Clock paused." | `Applications/IMBuddies/BuddyListWindow.tsx:29` | implemented |
| **Client sends the frame** | — | **missing** |

`TimeMachine.tsx:269` does exactly two things on Pause:

```tsx
const handlePause = () => { pause(); trackPauseResume("pause", dateTime); };
```

`pause()` freezes Classicy's **local** clock; `trackPauseResume` writes an
OpenReplay analytics event. Nothing reaches the WebSocket. Grepping the whole
frontend for a pause frame returns nothing.

So `Session.paused` is `false` for every session that has ever run, `Available`
never reaches its `paused` branch, `chat_state` keeps reporting enabled, and
`composeHintFor("paused")` is unreachable code.

**The mirror-image symptom:** `session.go:1037` re-checks the same gate before
sending *proactive* buddy messages. Because the server believes no one is ever
paused, a buddy can spontaneously message a student whose clock is frozen. Same
root cause, opposite direction, and the same fix closes it.

## Approach

Send the frame. This activates the design that is already built on both sides
rather than adding a second, parallel notion of "paused" to the client.

Rejected: a **client-only compose gate** (add `paused` to `ComposeGateInput`
and disable locally). Surgical and avoids touching the wire, but the server
would still believe the session is live — it would accept a send that reached
it, proactive buddy messages would keep firing, and `chat_state`'s `paused`
reason would stay dead code. It treats the symptom the user noticed and leaves
its twin in place.

**Accepted side effect:** per the protocol doc, a paused session stops
receiving `items` frames — media refills freeze app-wide (TV, Radio, News,
pager, Usenet) until resume. The doc presents this as the intent ("`pause`
freezes refills (the buffer stays valid); `resume` continues"), and a paused
clock has no use for new items, but the blast radius is wider than chat and is
recorded here deliberately.

## Design

One file: `packages/frontend/src/Providers/MediaStream/MediaStreamProvider.tsx`
— the only component permitted to talk to the streamer.

### 1. Observe the clock's pause state

The provider already calls the clock hook at line 262 and simply does not read
`paused`:

```tsx
const { localDate, dateTime, tzOffset, setDateTime, paused } = useClassicyDateTime({ tick: true });
```

An effect keyed on `paused` sends `{"type":"pause"}` or `{"type":"resume"}`
when it changes, guarded on an open socket. It must not fire on mount for the
default unpaused state — a `resume` to a session that was never paused is
harmless but meaningless traffic, and suppressing it keeps the frame log
readable.

### 2. Assert pause on every connection, including the first

Without this, the fix works only until the user's next page reload.

`paused` lives at `System.Manager.DateAndTime.paused` — inside the
localStorage-persisted `classicyDesktopState`, the same snapshot that makes the
virtual clock keep its position across a reload. So:

1. The student pauses; we send `pause`; the composer correctly disables.
2. They reload. Classicy restores `paused: true`; the clock is still frozen.
3. `onopen` sends `init`, which the protocol doc says sets `Session.paused = false`.
4. The composer re-enables against a frozen clock — the original bug, back.

Note this is *not* about dropped connections: the socket effect is marked
"Intentionally runs once on mount" and `onclose` does not reconnect. The
triggers are a fresh page load with a persisted pause, and a provider remount
(React StrictMode, or a change in the effect's callback identities). The first
of those is an ordinary user action, not an edge case.

The remedy already has a precedent inside that same function:

```tsx
// Re-establish channel subscriptions after a reconnect — the server
// does not remember subscriptions across connections.
```

Pause is the same class of state and gets the same treatment: sent
immediately after `init`, alongside the subscription replay.

`paused` must be read through a **ref** there, not captured directly. Adding it
to the socket effect's dependency array would tear down and rebuild the
WebSocket on every pause and resume — a reconnect storm from a button press.
The file already uses this pattern for `setDateTimeRef` and `isItemAvailableRef`.

`seek` deliberately does *not* reset pause (protocol doc, §`seek`), so Time
Machine seeks while paused need nothing.

### 3. Nothing else

`pause_ack` and `resume_ack` need no client handling. `MediaStreamProvider.tsx:1348`
already drops every frame that is not `items`, `init_ack`, or `seek_ack`:

```tsx
if (msg.type !== "items" && msg.type !== "init_ack" && msg.type !== "seek_ack") return;
```

No new UI, no new copy, no change to `composeGate.ts` or `BuddyListWindow.tsx`
— both already render the `paused` reason they have never yet received.

## Testing

A new `MediaStreamProvider.pause.test.tsx`. The provider's tests are split by
topic (`.clock.`, `.chat.`, `.news.`, `.weather.`, `.flights.`), each carrying
its own `FakeWebSocket` and `classicy` mock; pause gets its own file to match,
with a mutable `mockPaused` the tests flip between renders.

Note the existing mocks of `useClassicyDateTime` do not return `paused` at all,
so the new file's mock must add it.

- pausing sends `{"type":"pause"}`
- resuming sends `{"type":"resume"}`
- a re-render with no change in `paused` sends nothing
- **a connection opened while already paused sends `pause` after `init`** — the
  regression that protects §2, and the one worth writing first

An `IMBuddies` test is deliberately *not* added: the composer's response to
`chat_state` is already covered by `composeGate.test.ts`, and this change does
not alter that path. Asserting it again here would test the mock, not the fix.

## Out of scope

Two adjacent issues, recorded so they are not lost, and deliberately not fixed:

- **Forced clock mode.** The server acks `pause` but deliberately does not
  apply it while a master clock is forced (`session.go:568`), so the composer
  stays enabled. That is the server's intentional choice; the master clock
  really is running.
- **Pre-existing, unrelated:** `dateTimeLocked` is honoured only by the Mobile
  shell (`IpodShell.tsx`, `MainMenu.tsx`, `ScrubScreen.tsx`). Desktop
  `TimeMachine.tsx` never checks it, so its Pause/Play buttons stay clickable
  during forced clock mode. A separate bug in a different file.
