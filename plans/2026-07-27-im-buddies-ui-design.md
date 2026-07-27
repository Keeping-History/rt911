# IM Buddies — frontend UI design

**Status:** approved design, ready for an implementation plan
**Mocks:** https://claude.ai/code/artifact/7eaf34c2-0ac5-431a-835d-fde7e05116d1

## What this is

The student-facing client for the IM Buddies chat backend, dressed as **AOL Instant
Messenger 4 for Mac**. The backend has been live since 2026-07-26 and is exercised today
only by a developer harness at `/chatdev`. This replaces it.

Four windows, built from Classicy components inside the existing Mac OS 8 desktop:
**Sign On**, **Buddy List**, **Chat** (one per buddy), and **Get Info**.

## What already exists

Nothing here needs a backend change. The wire protocol is complete and deployed:

| Direction | Frame | Carries |
|---|---|---|
| → server | `subscribe` / `unsubscribe` | `{channel: "chat"}` |
| → server | `chat_send` | `{profile, body}` |
| → server | `chat_history` | `{profile, before, limit}` |
| ← client | `chat_roster` | `{buddies: [{profile, screen_name, display_name, avatar, online}]}` |
| ← client | `chat_state` | `{enabled, reason}` — `ok` / `paused` / `outside_window` / `blocked` / `not_signed_in` |
| ← client | `chat_presence` | `{profile, online}` |
| ← client | `chat_typing` | `{profile}` |
| ← client | `chat_message` | `{id, profile, direction, body, virtual_time, kind}` |
| ← client | `chat_error` | `{code, message}` |

Server→client frames are binary MessagePack; client→server is JSON text.
`GET /chat/username-available` exists for the Account app and is not used here.

## Architecture

One `ClassicyApp` (`IMBuddies.app`) owning four window types, and one provider that owns
all chat state.

```
app.tsx
└── MediaStreamProvider ................ the single WebSocket (already exists)
    └── ClassicyDesktop
        └── IMBuddies.app
            └── IMBuddiesProvider ...... subscribes to the chat channel, owns all state
                ├── SignOnWindow ....... singleton
                ├── BuddyListWindow .... singleton
                ├── ChatWindow ......... one per open conversation, keyed by profile id
                └── InfoWindow ......... one per buddy being inspected
```

**Why one provider rather than per-window subscriptions.** Every window needs the same
roster, presence and state. If each chat window subscribed independently it would
duplicate the ref-counted `subscribeChat`/`unsubscribeChat` logic, and "which window owns
the typing indicator" would have no single answer. The provider subscribes once on mount
and unsubscribes on unmount, following the existing `Set<appId>` pattern in
`MediaStreamProvider` (frontend hard rule 4).

**Windows are presentational.** Each reads from `useIMBuddies()` and renders. No window
talks to the socket, holds a timer, or derives state another window also derives.

### State shape

```ts
interface IMBuddiesState {
  connected: boolean;          // Sign On pressed, chat channel subscribed
  enabled: boolean;            // from chat_state
  reason: ChatStateReason;     // ok | paused | outside_window | blocked | not_signed_in
  buddies: Buddy[];            // from chat_roster, presence applied
  conversations: Map<number, Conversation>;
  openChats: number[];         // profile ids with an open window, in open order
  openInfo: number[];          // profile ids with an open Get Info window
}

interface Conversation {
  messages: ChatMessage[];
  typing: boolean;             // cleared when the next chat_message lands
  unread: number;              // for a background window's title
}
```

`conversations` is keyed by profile id and survives a window closing, so reopening a
conversation shows what was already said without a `chat_history` round trip.

## The windows

### 1. Sign On

A costume over the real Directus session. **No second credential exists anywhere in this
window.**

- The AIM running man, drawn as inline SVG rather than fetched.
- **Screen Name** — a `ClassicyPopUpMenu` showing `directus_users.username`, with an
  `Edit…` item that opens the Account app. A popup rather than a text field because AIM
  used one, and because the value is not editable here.
- **Password** — a disabled field rendering a fixed run of bullets. It reads nothing and
  submits nothing. This is theatre and the code says so, so that nobody later "fixes" it
  into real authentication.
- **Save password** (checked, inert) and **Auto-login** (unchecked, inert) — period
  furniture.
- **Sign On** subscribes to the chat channel and opens the Buddy List.

If the student is not signed in to Directus, `chat_state` returns `not_signed_in`. Sign On
then opens the **Account** app instead, which is the one place real credentials are
handled.

The window closes once connected and reopens on Sign Off.

### 2. Buddy List

- Groups from data already held: one **Buddies** group with an online/total count, plus an
  **Offline** group. No schema change — AIM showed exactly this before you made custom
  groups. Order is `chat_profiles.sort`; online state is the `chat_presence` frame.
- Online buddies in black with a lit dot; offline in grey with a hollow dot.
- Double-clicking a buddy opens their chat window (or focuses it if already open).
- **IM**, **Info**, **Prefs** buttons act on the selection. IM and Info disable when no
  buddy is selected or the selected buddy is offline.
- A **status line** across the bottom carrying one sentence of clock state — see below.

### 3. Chat — one window per buddy

Chosen over tabs because it is what AIM 4 did, and because a morning where three buddies
are talking at once should feel like it.

- `ClassicyWindow` with `id={"im_chat_" + profileId}` and the buddy's screen name as the
  title. Classicy already supports several windows per app.
- **Transcript** — the student's own messages and the buddy's, each prefixed by name.
  Newest at the bottom, scrolled to.
- **Typing indicator** — `chat_typing` renders `Danny is typing…` in the transcript, and
  it is cleared by the next `chat_message` on that conversation, not by a timer. The
  backend sends typing on accepting a job, and the reply is the only thing that ends it.
- **Compose** — a single-line field, Enter to send, plus a **Send** button.
- **Smiley picker only.** No bold, italic, font or colour. The picker inserts the text
  emoticons a student could type anyway.
- Closing a window does not end the conversation; the transcript is kept in state.

**Text emoticons render as graphics on both sides.** This is what real AIM did and it
costs the backend nothing: the personas already instruct buddies to write `:-)` and
`:-/`, and `Sanitize` guarantees only ASCII survives. Stored and sent as plain text; only
the render is graphical. The mapping lives in one table
(`:-)` `:)` `:-(` `:(` `;-)` `:-/` `:-O` `<3`) and anything unmapped stays as typed.

### 4. Get Info

`persona`, `location` and `watching` are loaded from `chat_profiles` and used nowhere in
the UI. AIM's Get Info showed a buddy's profile, which makes this the period-accurate
place to let a student learn who they are talking to.

- Screen name, display name, and where they are.
- A short "profile" written from the persona — this is **curated prose, not the raw
  system prompt.** The persona is written in the second person as an instruction to a
  model ("You are Danny, 13…"); showing it verbatim would leak the mechanism. A new
  `chat_profiles.profile_text` column holds what a student sees, falling back to nothing
  when unset rather than to the persona.
- Online state and, when offline, when they are expected.

`profile_text` is the one backend addition in this design. It is nullable and additive;
the streamer sends it on the existing `chat_roster` frame.

## Menu bar

The app installs a `ClassicyMenuBarExtension` while frontmost, following AIM's own menus:

- **People** — New Message, Get Info, Sign Off
- **Window** — Buddy List, plus an item per open chat window

This is the first use of `ClassicyMenuBarExtension` in the repo.

## Sounds

Classicy's sound manager takes named sounds: register with `ClassicySoundLoad`, play with
`useSoundDispatch()` and `{type: ClassicySoundActionTypes.ClassicySoundPlay, sound}`.

Assets will be supplied separately. The design defines the names and triggers:

| Name | Plays when |
|---|---|
| `IMBuddiesSignOn` | the chat channel connects |
| `IMBuddiesBuddyIn` | a buddy goes online — the door opening |
| `IMBuddiesBuddyOut` | a buddy goes offline — the door closing |
| `IMBuddiesReceive` | a `chat_message` arrives for a window that is not frontmost |
| `IMBuddiesSend` | the student sends |

Two rules. **No sound on the initial roster** — connecting at 9:15 with two buddies
already online must not fire two door-opens, so buddy sounds fire only on a presence
*change* after the first roster. And every sound respects Classicy's existing mute, which
`ClassicySoundDisableOne` already scopes per sound.

## Clock states

The server refuses sends when paused, outside the window, or blocked. The UI explains
that; it does not enforce it.

| `chat_state.reason` | Buddy list | Chat window |
|---|---|---|
| `ok` | normal | normal |
| `outside_window` | all offline, `Nobody is online until 8:00 AM.` | input disabled, `Nobody is online right now.` |
| `paused` | all offline, `Clock paused.` | input disabled, `Start the clock to keep talking.` |
| `blocked` | all offline, `You can't send messages right now.` | input disabled, same |
| `not_signed_in` | Sign On window returns | window closes |

**An open conversation survives the clock stopping.** The window and transcript stay put,
so a student who pauses to read something finds the conversation where they left it.

**A backward seek is different.** History is re-read filtered to the new virtual time, so
a buddy stops remembering what has not happened yet. The provider re-issues `chat_history`
for every open conversation on a backward seek.

The threshold is **`BACKWARD_SEEK_THRESHOLD_MS` (2s), not `SEEK_THRESHOLD_MS` (90s)** —
`seekDetection.ts` deliberately keeps two. The 90s figure exists so routine clock drift
does not trigger a refill storm, and it is the right bound for a *forward* jump. Backward
is asymmetric: moving back even ten seconds can leave a buddy holding messages from after
the new time, which is the exact failure the tier system exists to prevent. Using the
larger constant here would leave small backward seeks showing a conversation that has not
happened yet.

## Error handling

- **`chat_error`** renders in the affected conversation as a system line, not an alert.
  A modal over a chat window would be more disruptive than the error.
- **Queue full** arrives as a normal `chat_message` with `kind: "stall"` — the in-character
  "hang on, phones ringing". The UI shows it as the buddy speaking, because that is what it
  is meant to be. No special casing.
- **Socket drops** are `MediaStreamProvider`'s existing concern. The provider marks itself
  disconnected and the Sign On window returns.
- **A send while disabled** cannot happen — the input is disabled — but if it did, the
  server refuses and pushes `chat_state`. The client never assumes it knows better.

## Testing

Co-located `*.test.tsx`, following the repo's existing pattern (`afterEach(cleanup)` —
this project has no RTL auto-cleanup).

- **`emoticons.test.ts`** — pure. Every mapped emoticon renders; an unmapped one stays as
  typed; a `:-)` inside a word is not replaced.
- **`IMBuddiesProvider.test.tsx`** — frames in, state out. A roster populates buddies;
  presence flips one; `chat_typing` sets and the next `chat_message` clears; a message for
  a closed conversation increments unread; a backward seek re-requests history.
- **`SignOnWindow.test.tsx`** — `not_signed_in` opens the Account app rather than
  connecting; the password field submits nothing.
- **`ChatWindow.test.tsx`** — Enter sends and clears; a disabled state blocks the button
  and shows the right sentence per reason.
- **Sound triggers** — the initial roster fires no buddy sounds; a later presence change
  does.

## Out of scope

- **Away messages and idle.** AIM had both. Nothing in the backend models them.
- **Warn and Block buttons.** Blocking is a moderation action the backend performs; a
  student-facing Block would imply a feature that does not exist.
- **Chat rooms.** The backend is one-to-one only.
- **Buddy icons.** `chat_profiles.avatar` exists but no art does. The list uses the
  online/offline dot, and this can be added later without a design change.
- **Mobile.** `src/Mobile/` is a separate shell; this is the desktop app.

## The one backend change

`chat_profiles.profile_text` — nullable text, the student-facing profile shown in Get
Info, sent on `chat_roster`. Everything else in this design uses the wire protocol as it
already ships.
