---
id: "050-3ed3"
title: "Radio Traffic plays audio and fetches data when its window is closed"
<<<<<<<< HEAD:stories/050-3ed3-in_progress-P1-radio-traffic-plays-audio-and-fetches-when-closed.md
status: in_progress
priority: P1
type: fix
created: 2026-08-19T03:42:50.000Z
updated: 2026-08-19T03:50:20.000Z
========
status: complete
priority: P1
type: fix
created: 2026-08-19T03:42:50.000Z
updated: 2026-08-19T04:05:23.000Z
>>>>>>>> worktree-agent-a233bdb3a82f44879:stories/050-3ed3-complete-P1-radio-traffic-plays-audio-and-fetches-when-closed.md
dependencies: []
plan: "plans/radio-traffic-redesign.md"
plan_step: "App shell and audio orchestration"
---

# Radio Traffic plays audio and fetches data when its window is closed

## Problem Statement

`RadioTraffic` is rendered unconditionally in `Desktop.tsx` (`<RadioTraffic />`,
never behind an `isOpen` check), so the component — and every effect inside it
— is mounted for the lifetime of the desktop, not for the lifetime of the
app's window. Two of those effects have real cost regardless of whether the
listener ever opened the app:

- The mount-only effect calls `subscribeMp3(appId)` unconditionally, opting
  this app into the shared WebSocket's mp3 side-channel (see
  `MediaStreamProvider.tsx`'s ref-counted `subscribeMp3`/`unsubscribeMp3`
  pair) the moment the desktop boots.
- The audio-registration effect calls `ensure(itemId, url)` for every LIVE
  card (and any user-started PREVIOUS clip), which per `audioCoordinator.ts`
  creates a real `<audio>` element and points it at a URL — the browser
  fetches and, unless muted, plays it — for every listener's desktop, whether
  or not they have ever clicked the Radio Traffic icon.

Sibling apps already have the fix's shape available: `RadioTuner.tsx` and
`TV.tsx` both read `isOpen` off `state.System.Manager.Applications.apps[appId]?.open`
(currently only to fire an analytics `trackAppToggle` call) — that selector
is the correct gate, it is just not wired to anything that stops work.

The existing unmount cleanup (`releaseAll()` in `RadioTraffic.tsx`) is not a
substitute: it fires on component unmount, and this component never unmounts.
Closing the window today leaves every LIVE element registered, fetching and
audible.

## Acceptance Criteria

- [x] `subscribeMp3(appId)` is not called, and mp3 data is not requested from
      the streamer, while the Radio Traffic window is closed
- [x] no `<audio>` element is created or fetched (`ensure()`) for any item
      while the window is closed
- [x] closing the window releases every registered element (`release()`/
      `releaseAll()`), the same as the unmount path does today
- [x] reopening the window resumes LIVE playback at the clock's current
      position, exactly as if the app had been open the whole time — no replay
      from a stale offset, no silent gap in the badge/position reporting
- [x] a PREVIOUS clip a listener started by hand before closing the window is
      released, not left playing invisibly, when the window closes
- [x] the app's persisted settings (filters, tool, lane order, mutes) are
      unaffected by open/close — this is a lifecycle change, not a state reset
- [x] a co-located test exercises open->close->reopen and asserts
      `subscribeMp3`/`ensure`/`release` are called at the right transitions
- [x] tsc, vitest and oxlint all pass

## Files

- packages/frontend/src/Applications/RadioTraffic/RadioTraffic.tsx
- packages/frontend/src/Applications/RadioTraffic/RadioTraffic.test.tsx
- packages/frontend/src/Applications/RadioTraffic/audioCoordinator.ts

## Proof

- [ ] [completeness] Completeness
- [ ] [feature-availability] Feature availability
- [ ] [robustness] Robustness
- [ ] [resilience] Resilience
- [ ] [security] Security
- [ ] [defense-in-depth] Defense in depth
- [ ] [input-validation] Input validation
- [ ] [thread-safety] Thread safety
- [ ] [configurability] Configurability

## Work Log

### 2026-08-19T04:05:23.000Z - Gate the mp3 subscription and audio registration on isOpen

Added the `isOpen` selector (`state.System.Manager.Applications.apps[appId]?.open`)
to `RadioTraffic.tsx`, the same one `RadioTuner.tsx`/`TV.tsx` already read for
their analytics toggle, and used it for real work here:

- The mount-only `subscribeMp3(appId)`/`unsubscribeMp3(appId)` effect is now
  gated on `isOpen` — closed, it subscribes nothing; the existing ref-counted
  `Set<appId>` in `MediaStreamProvider.tsx` needed no changes.
- The audio-registration effect (the one calling `ensure(itemId, url)` for
  every LIVE card and any hand-started PREVIOUS clip) is gated the same way,
  so a closed window registers no new `<audio>` element and triggers no fetch.
- Skipping the registration effect's body while closed does nothing about
  elements it registered *before* the close, so a new effect keyed on `isOpen`
  going false calls `releaseAll()` and clears `registeredRef` — the same
  cleanup the pre-existing unmount effect does, now reachable without an
  actual unmount (which this component still never does, since it stays
  mounted for the desktop's lifetime).

No changes were needed in `audioCoordinator.ts` — `ensure`/`release`/
`releaseAll` already did exactly what the close/reopen transitions needed.

Added a co-located "the window lifecycle (story 050)" describe block to
`RadioTraffic.test.tsx` covering: starting closed (no subscribe, no
elements), an item arriving while closed (no new element), and a full
close→reopen cycle asserting every LIVE and hand-started PREVIOUS element is
released then freshly re-registered (proven by element identity change) with
the position/badge pipe still live, plus a check that persisted settings
(filters/tool/lane order/mutes) are untouched by the cycle. One trap along
the way: asserting the reopened badge via a raw `el.dispatchEvent("timeupdate")`
needs its own `act()` wrap — unlike `fireEvent`, a raw `dispatchEvent` isn't
auto-flushed, and an existing test in the same file only worked because a
*later* `fireEvent.click` incidentally flushed the pending update.

Verified: `RadioTraffic.test.tsx` (59/59), the full RadioTraffic directory
(668/668), the full frontend suite (292 files / 3147 tests, all green),
`tsc -b` clean, and `pnpm lint` clean (oxlint's pre-existing warnings
elsewhere in the app are untouched; nothing new in the files this story
changed).
