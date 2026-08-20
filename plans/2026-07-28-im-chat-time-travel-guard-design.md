# IM Buddies chat — time-travel guard — Design

**Date:** 2026-07-28
**Status:** Approved, pending implementation plan

A conversation that has already happened must not be able to happen again
earlier. Once a chat has a message in it, rewinding the Time Machine behind that
message closes the composer until the clock catches back up.

## Goal

When a student has sent or received at least one message in a conversation and
then rewinds the virtual clock to before that message's timestamp:

- the message field, the Send button, and the emoticon controls in that chat
  window are disabled;
- the compose row explains why, and names the time chat resumes;
- everything re-enables on its own the moment the clock reaches that timestamp
  again.

The guard is **per conversation**. A rewind that blocks a chat with one buddy
leaves a conversation that has no messages yet fully usable.

## Why

The backend already spends real effort keeping a buddy from referring to events
that have not happened yet — that is what its knowledge-tier system is for.
The client can open the same hole from the other side: rewind to 9:00, type into
a conversation whose last line is stamped 9:07, and the agent receives a turn
that sits *before* its own previous answer. The transcript it is handed is then
self-contradictory, and there is no prompt-side fix for that. Closing the
composer is the cheap, honest guard.

## Current state

`ChatWindow` already renders a disabled composer and a one-line explanation. It
takes `enabled` and `reason` from `useIMBuddies()`, which passes through
`chat_state` frames from the streamer, and turns `reason` into a sentence with
the pure `composeHintFor(reason)`. `ChatStateReason` is a **wire** type —
`"ok" | "paused" | "outside_window" | "blocked" | "not_signed_in"` — and
`composeHintFor` has an exhaustiveness guard so a sixth wire value fails the type
check rather than rendering nothing.

So the UI seam this feature needs already exists. What does not exist is any
client-side notion of the conversation's own position in time.

Two facts about the surrounding code shape the design:

**A backward seek erases the transcript.** `MediaStreamProvider` clears
`chatMessages` entirely on any backward seek (the `if (nowMs < prevMs)` branch,
`MediaStreamProvider.tsx:963`) and `IMBuddiesProvider` re-requests a page of
history per open conversation, `before` the new instant. So immediately after a
rewind the transcript no longer contains the message being rewound behind.
`max(messages.time)` is therefore **not** a usable source for the mark — by the
time it matters, it is gone.

**The provider deliberately does not tick.** `IMBuddiesProvider` reads the clock
but keeps `localDate` out of its context value, mirroring it into
`virtualNowMsRef` instead, precisely so the value is not rebuilt once a second
for every consumer. A gate derived from the ticking clock must not undo that.

## Decisions

### The mark lives in the provider, monotonically

`IMBuddiesProvider` keeps a per-profile high-water mark of the newest message
timestamp it has ever seen for that conversation, in true UTC ms, raised in an
effect over `chatMessages`. It is fed by **both directions** — the buddy's lines
and the student's own local echoes — since the requirement is "sent *or*
received".

It only ever increases. It is **not** cleared by the backward-seek wipe of
`chatMessages`, and **not** cleared by `signOff` — unlike `openChats`,
`readMarks`, and the rest of the view state that `signOff` resets. It is
knowledge about the timeline, not a view of it; clearing it on sign-off would
leave Sign Off → rewind → Sign On as a way to reach a state the guard exists to
prevent, because a history replay only ever returns messages *before* the
current instant and so could never rebuild it. It is lost on page reload, which
is acceptable: reload restarts the session's whole in-memory world.

A message whose `time` does not parse is skipped rather than allowed to poison
the mark — the same tolerance the existing conversation sort applies.

Exposed as `lastMessageAtFor(profile): number | null`. It is held as a ref
mirrored into state so that a *new* message re-renders consumers, while the
per-second clock tick does not.

### The decision is a pure function

New `composeGate.ts`, beside the window that uses it:

```ts
composeGate(reason, lastMessageAtMs, nowMs, tzOffset) → { enabled, hint }
```

Blocked when:

```
nowMs < lastMessageAtMs - BACKWARD_SEEK_THRESHOLD_MS
```

The tolerance is the existing 2s constant from `seekDetection.ts`, and it is
load-bearing rather than defensive padding. The streamer stamps each reply with
whole-second RFC3339 at its own reading of the client's virtual time, so a reply
can legitimately land a fraction of a second *ahead* of the client clock. With
an exact `nowMs < markMs` test the composer would blink disabled for about a
second after every buddy reply. `BACKWARD_SEEK_THRESHOLD_MS` is already this
codebase's definition of "a real backward move" — the same threshold that
decides whether a rewind is a seek at all — so a rewind too small to trigger a
seek is also too small to close the composer.

### Blocked outranks the wire reasons

When blocked, the hint wins over every `ChatStateReason` sentence. A rewind
usually leaves the clock paused as well, so `"Start the clock to keep talking."`
would otherwise mask the real, longer-lived blocker. When not blocked the gate
delegates to the existing `composeHintFor(reason)`, unchanged.

The hint names the resume time:

> You've traveled back before your last message. Chat resumes at 9:07:35 AM.

Formatted with `formatPlayhead(ms, tzOffsetHours)` from `lib/loopClock.ts` — the
existing helper that shifts a UTC instant by the display offset and formats it
as UTC, which is the same trick the menu-bar clock uses. Reused rather than
reinvented.

Seconds are shown, not minutes. Marks land on whole seconds (both the wire
format and `wireTimestamp` truncate), so a mark of 9:07:35 rendered as
"9:07 AM" would read as a lie to a student sitting blocked at 9:07:10.

`ChatStateReason` gains no new member. It is a wire type; this reason is
client-only and never appears in a frame. `composeGate` returns a rendered
string, so nothing downstream needs a sixth case.

### The window supplies the clock

`ChatWindow` calls `useClassicyDateTime({ tick: true })` itself and converts
with `virtualUtcMs(localDate, tzOffset)` (hard rule 3 — `localDate` is a display
value). That per-second re-render is what re-enables the composer at the moment
the clock arrives, and it keeps the tick inside the one component that needs it
instead of in the provider's shared context value. Each open chat window
re-rendering once a second is the same cost TV and RadioScanner already pay.

The window feeds one combined `enabled` to the input, the Send button, and the
emoticon controls — exactly where it passes `!enabled` today — and renders
`hint` in the existing `chatComposeHint` div.

### `send()` refuses too

`IMBuddiesProvider.send` returns without touching the wire when the gate is
closed, using `virtualNowMsRef` and the same marks. A disabled button is a UI
state; this is the actual invariant. It costs three lines and closes the gap
between a stale render and a keystroke.

## Out of scope

- **Incoming messages are untouched.** The guard is about what the student can
  send. A buddy's line arriving while blocked still renders.
- **The Buddy List is untouched.** Its own status line and the IM button keep
  working; a blocked conversation can still be opened, read, and scrolled.
- **No backend or wire change.** Entirely client-side.

## Testing

`composeGate.test.ts` (pure):

- blocked when now is behind the mark by more than the tolerance; allowed when
  past it; allowed exactly at it;
- a null mark is always allowed (a conversation with no messages);
- a mark up to 2s ahead of now does **not** block (the reply-skew case);
- the blocked hint outranks each of the five `ChatStateReason` values;
- the unblocked hint matches `composeHintFor` for each of those values;
- the resume time renders in the display timezone — 13:07:35Z at −4 → "9:07:35 AM".

`IMBuddiesProvider`:

- the mark survives the backward-seek clear of `chatMessages`;
- the mark survives `signOff`;
- the mark rises for both an incoming message and the student's own echo;
- `send` does not reach the wire while blocked.

`ChatWindow`:

- after a rewind, the input and Send are disabled and the hint is rendered;
- both are live again once the clock reaches the mark;
- a conversation with no messages is never blocked.

## Files

| File | Change |
|---|---|
| `Applications/IMBuddies/composeGate.ts` | new — the pure gate |
| `Applications/IMBuddies/composeGate.test.ts` | new |
| `Applications/IMBuddies/IMBuddiesProvider.tsx` | the mark, `lastMessageAtFor`, guarded `send` |
| `Applications/IMBuddies/ChatWindow.tsx` | read the clock, call the gate, feed the combined `enabled` |
| `Applications/IMBuddies/IMBuddiesProvider.test.tsx` | mark lifetime + guarded send |
| `Applications/IMBuddies/ChatWindow.test.tsx` | disabled/enabled either side of the mark |

## Open verification point

`ChatWindow` currently mirrors the hint into the input's `placeholder`. The
blocked sentence is long for a 260px window and may look cramped there even
though the hint div reads fine. Keep the mirroring, check it in the browser
during implementation, and fall back to a short placeholder only if it actually
looks bad.
