# IM Buddies File → Quit, and a closable Buddy List — Design

**Date:** 2026-07-27
**Status:** Approved, pending implementation plan

Give the IM Buddies windows a File menu containing Quit, the way every other
app on this desktop does, and let the Buddy List be closed and reopened.

## Goal

Sign On, Buddy List, and every Chat window carry a **File → Quit** item that
quits the app. Get Info is a utility window and is deliberately excluded.

The **Buddy List becomes closable**. Closing it puts the window away without
signing off, and the menu-bar extension's existing *Buddy List* item brings it
back.

## Current state

IM Buddies is the one app that does not pass an `appMenu` to its
`ClassicyWindow`s. Instead it renders a `ClassicyMenuBarExtension`
(`IMBuddiesMenus` in `IMBuddies.tsx`) — the icon-sized slot on the right of the
menu bar — holding New Message, Get Info, Sign Off, Quit, and the window list.

That component's own comment records why: the extension has no built-in notion
of "frontmost", so it is only ever *mounted* while IM Buddies is the focused app
(`{isFrontmost && <IMBuddiesMenus />}` in `IMBuddiesContent`).

So a Quit item already exists. It is simply not where a Mac user looks for it.

`IMBuddiesContent` renders four window components: `SignOnWindow` while
disconnected, then `BuddyListWindow`, one `ChatWindow` per open conversation,
and a single retargeting `InfoWindow`. None of them currently accept an
`appMenu`.

## Decisions

**Follow the TimeMachine precedent.** TimeMachine defines one `appMenu` at app
level and threads it into four separate window components by prop;
`BookmarksWindow` and `BookmarkDialog` both declare it as
`appMenu: React.ComponentProps<typeof ClassicyWindow>["appMenu"]`. IM Buddies
takes the same shape rather than inventing a new one.

**Keep the existing Quit in the menu-bar extension.** Quit will be reachable
both from File and from the tray menu. This duplicates one item, but it costs
nothing and avoids removing an affordance users of the shipped app may already
have learned.

**Exclude InfoWindow.** It is a utility window — a small, non-resizable,
retargeting palette — and utility windows do not own the menu bar.

**Closing the Buddy List hides it; it does not sign off or quit.** Closing a
window is not quitting, which is both the Mac convention and how AIM behaved on
the Mac. The alternatives — closing signs you off, or closing quits — both turn
an ordinary close box into a destructive control, and one of them duplicates the
File → Quit this same change introduces.

That decision carries an obligation: **there must be a way back.** Classicy's
`ClassicyWindowClose` sets `closed: true`, and `ClassicyWindowFocus` does *not*
clear it — it only sets focus and the menu bar. The menu-bar extension's
existing *Buddy List* item dispatches Focus alone, so as written it would leave
a user who closed the Buddy List with no route back short of quitting.
`ClassicyWindowOpen` on a window that already exists in state does
`{ closed: false }`, so the item must dispatch Open before Focus.

**Mark InfoWindow `windowType="utility"`.** Classicy has a first-class notion of
utility windows: its next-window-to-focus helper filters
`!closed && windowType !== "utility"`. InfoWindow is one by description but has
never declared it, which did not matter while nothing was closable. Once the
Buddy List can close, Classicy has to choose what to focus next, and an
undeclared Get Info window is eligible. TimeMachine already sets this on two
windows, so this follows existing practice rather than inventing any.

**Define the menu as a module-level constant, not a `useMemo`.** Feedback and
TimeMachine both wrap theirs in `useMemo(…, [])`. The menu here depends only on
`APP_ID`, `APP_NAME`, and `appIcon`, all module constants, so a hook adds
ceremony for a value that cannot change. A module-level constant is stable by
construction rather than by convention.

## Change set

`packages/frontend/src/Applications/IMBuddies/`:

- **`IMBuddies.tsx`** — add the constant and pass it to three windows:

  ```ts
  const APP_MENU: ClassicyMenuItem[] = [
    { id: "file", title: "File", menuChildren: [quitMenuItemHelper(APP_ID, APP_NAME, appIcon)] },
  ];
  ```

- **`SignOnWindow.tsx`**, **`BuddyListWindow.tsx`**, **`ChatWindow.tsx`** — each
  gains an `appMenu` prop typed
  `React.ComponentProps<typeof ClassicyWindow>["appMenu"]`, forwarded to its
  `ClassicyWindow`.
- **`BuddyListWindow.tsx`** — `closable={false}` becomes `closable={true}`.
- **`IMBuddies.tsx`** — `focusWindow` becomes `revealWindow`, dispatching
  `ClassicyWindowOpen` then `ClassicyWindowFocus`. Applied to every entry in the
  window list, not only the Buddy List: "bring this window to the front, opening
  it if it was closed" is what a Mac Window menu does, and every window the list
  names is mounted, so Open always finds an existing entry and only clears the
  closed flag.
- **`InfoWindow.tsx`** — gains `windowType="utility"`. No `appMenu`.

## Resolved: does a menu-less window blank the menu bar?

No. This was going to be checked in the browser, but the reducer answers it
directly. `ClassicyWindowFocus` resolves a menu from the focus event and calls
`m2`, which ends:

```js
const d = t ?? b.menuBar;
d && (V.System.Manager.Desktop.appMenu = d);
```

The assignment is guarded. A focused window that supplies no menu leaves
`Desktop.appMenu` untouched, so the previously focused window's File menu stays
on screen. Bringing Get Info forward therefore keeps File → Quit available,
which is the Mac behaviour, and InfoWindow needs no menu of its own to achieve
it.

Still worth confirming in the running app, but it is no longer an open design
question.

## Testing

`RadioScanner.test.tsx` and `FlightTracker.test.tsx` establish the idiom: mock
`ClassicyWindow`, record the `appMenu` prop it receives, and assert on its
contents.

Per window, assert the recorded `appMenu` contains a `file` menu whose
`menuChildren` include the Quit item. Plus one negative test: `InfoWindow`
passes no `appMenu`.

For the closable Buddy List:

- `BuddyListWindow` passes `closable={true}`.
- `InfoWindow` passes `windowType="utility"`.
- Choosing *Buddy List* from the menu dispatches `ClassicyWindowOpen` **and**
  `ClassicyWindowFocus` for `im_buddylist`. This is the regression test that
  matters most — Focus alone looks correct in review and strands the user at
  runtime, because the bug only appears once the window has been closed.

**Trap to avoid:** a wholesale `vi.mock("classicy")` in this repo breaks as soon
as a component imports a new symbol from the library. Mock narrowly.

## Out of scope

- Any other File menu item. Quit is what was asked for; Close, New Message and
  the rest stay where they are.
- Removing or reorganising the existing menu-bar extension.
- Giving InfoWindow a menu.
- Making Sign On or Chat windows behave differently on close. Chat windows
  already close via `closeChat`, which unmounts them and removes them from the
  window list, so they cannot be stranded the way the Buddy List could.
