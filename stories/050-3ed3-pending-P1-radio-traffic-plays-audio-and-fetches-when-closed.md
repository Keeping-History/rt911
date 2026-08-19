---
id: "050-3ed3"
title: "Radio Traffic plays audio and fetches data when its window is closed"
status: pending
priority: P1
type: fix
created: 2026-08-19T03:42:50.000Z
updated: 2026-08-19T03:42:50.000Z
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

- [ ] `subscribeMp3(appId)` is not called, and mp3 data is not requested from
      the streamer, while the Radio Traffic window is closed
- [ ] no `<audio>` element is created or fetched (`ensure()`) for any item
      while the window is closed
- [ ] closing the window releases every registered element (`release()`/
      `releaseAll()`), the same as the unmount path does today
- [ ] reopening the window resumes LIVE playback at the clock's current
      position, exactly as if the app had been open the whole time — no replay
      from a stale offset, no silent gap in the badge/position reporting
- [ ] a PREVIOUS clip a listener started by hand before closing the window is
      released, not left playing invisibly, when the window closes
- [ ] the app's persisted settings (filters, tool, lane order, mutes) are
      unaffected by open/close — this is a lifecycle change, not a state reset
- [ ] a co-located test exercises open->close->reopen and asserts
      `subscribeMp3`/`ensure`/`release` are called at the right transitions
- [ ] tsc, vitest and oxlint all pass

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
