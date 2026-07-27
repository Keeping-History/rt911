# IM Buddies File → Quit — Design

**Date:** 2026-07-27
**Status:** Approved, pending implementation plan

Give the IM Buddies windows a File menu containing Quit, the way every other
app on this desktop does.

## Goal

Sign On, Buddy List, and every Chat window carry a **File → Quit** item that
quits the app. Get Info is a utility window and is deliberately excluded.

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
- **`InfoWindow.tsx`** — unchanged.

## Open question, to be answered by observation

When InfoWindow is frontmost and declares no `appMenu`, does Classicy keep
showing the app's File menu or blank it?

In real Mac OS the menu bar belongs to the *application*, so bringing a utility
window forward does not remove File. Whether Classicy models it that way could
not be read out of the minified bundle, so it will be checked in the running app
rather than assumed.

If Classicy does blank the menu bar, that is reported back rather than resolved
by quietly giving InfoWindow a menu it was specified not to have.

## Testing

`RadioScanner.test.tsx` and `FlightTracker.test.tsx` establish the idiom: mock
`ClassicyWindow`, record the `appMenu` prop it receives, and assert on its
contents.

Per window, assert the recorded `appMenu` contains a `file` menu whose
`menuChildren` include the Quit item. Plus one negative test: `InfoWindow`
passes no `appMenu`.

**Trap to avoid:** a wholesale `vi.mock("classicy")` in this repo breaks as soon
as a component imports a new symbol from the library. Mock narrowly.

## Out of scope

- Any other File menu item. Quit is what was asked for; Close, New Message and
  the rest stay where they are.
- Removing or reorganising the existing menu-bar extension.
- Giving InfoWindow a menu.
