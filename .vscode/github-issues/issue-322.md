---
id: 4988618002
number: 322
title: 'Buddies: update help, setup buttons with actions'
state: open
created_at: '2026-07-27T13:48:55Z'
updated_at: '2026-07-27T14:42:41Z'
author:
  login: robbiebyrd
  id: 1775127
  avatar_url: 'https://avatars.githubusercontent.com/u/1775127?v=4'
  url: 'https://api.github.com/users/robbiebyrd'
assignees: []
labels: []
url: 'https://api.github.com/repos/Keeping-History/rt911/issues/322'
html_url: 'https://github.com/Keeping-History/rt911/issues/322'
---
# Buddies: update help, setup buttons with actions

---

**Author:** @robbiebyrd
**Created:** 2026-07-27T13:48:55Z
**Updated:** 2026-07-27T14:42:41Z

---

## Comments

### @robbiebyrd - 2026-07-27T14:37:23Z

## What's there now

Both buttons are literally inert — `SignOnWindow.tsx:170-175`:

```tsx
<ClassicyButton onClickFunc={() => {}} buttonSize="small">Setup</ClassicyButton>
<ClassicyButton onClickFunc={() => {}} buttonSize="small">Help</ClassicyButton>
```

They shipped as period furniture: AIM 4's sign-on window had them, so the costume has them.

## Decision recorded

Confirmed with @robbiebyrd:

- **Setup → the Account app.** That is where the username and the real credentials live, and it is the only genuine configuration this app has.
- **Help → a Getting Started HyperCard stack** explaining who the buddies are and how to talk to them.

## Plan

**Setup** is straightforward. `SignOnWindow` already opens the Account app on the signed-out path — reuse that same dispatch rather than writing a second one, so there is one way this app opens Account.

**Help** has a prerequisite: *the stack does not exist yet.* Per the existing HyperCard integration, `.stack` files open through Finder's `data.openFiles`, **not** a plugin router, and live in `public/stacks`. So:

1. Author an IM Buddies stack in `public/stacks` — who the buddies are, that they only know what has happened by the current clock time, and how to start a conversation.
2. Wire Help to open it the same way the existing Getting Started stack is opened.
3. **Until the stack exists, Help should be `disabled`, not a no-op.** A button that visibly does nothing when clicked is worse than one that is plainly unavailable — it reads as a broken app rather than an unfinished one.

## Open question

Who writes the stack's copy? This is student-facing prose about a September 11 chat, so it is a content decision rather than an implementation one. The code work is small; the writing is the real deliverable.


### @robbiebyrd - 2026-07-27T14:41:23Z

## Decision: remove Help for now

Confirmed with @robbiebyrd: **drop the Help button**; it will be re-added when there is something for it to open.

That removes the HyperCard stack prerequisite from this issue entirely. Revised scope:

1. **Setup → the Account app**, reusing the dispatch `SignOnWindow` already makes on the signed-out path, so there is one way this app opens Account.
2. **Delete the Help button.** Not disabled — removed. A permanently greyed control is its own small lie about what the app is about to do.
3. Re-check the button row's layout with one fewer button so Setup and Sign On do not end up oddly spaced.

The Getting Started stack idea is worth keeping, but it belongs in its own issue when the copy is ready to be written — it is a content deliverable, not a wiring one.


### @robbiebyrd - 2026-07-27T14:42:41Z

Split the Help button's stack out to #328 so it is not lost when Help is removed here. This issue is now just: wire Setup → Account app, delete Help, re-check the button row's spacing.

