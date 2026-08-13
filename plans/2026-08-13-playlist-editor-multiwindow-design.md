# Playlist Editor: one window per playlist, menus, and a Tools palette

**Date:** 2026-08-13
**Status:** Approved, not implemented
**Repo:** `rt911` (this repo), `packages/frontend`
**Baseline:** `main` @ `ac0dadee` — *includes* `cd6cc056` (Control window) and
`1dd67972` (live teacher room control). An earlier draft of this spec was
written against a branch predating both and invented a tool palette without
knowing a Control window already existed; the Decisions below reflect the
corrected baseline.

## Problem

The Playlist Editor is a single-window app that swaps its entire contents
between two modes: a list of the signed-in teacher's playlists, and an editor
for exactly one playlist at a time. Opening a second playlist means abandoning
the first — including its unsaved changes, which is why `PlaylistEditorMain`
carries a `closeRequested` flow that replaces the window body with a
save/discard/cancel strip.

Everything that acts on the open playlist lives in chrome stacked above the
editing surface: a header row (back button, title field, Restrict/Annotate
radios, a status dropdown, and the Save button) and a second row of six
text-labeled "Add …" buttons. Two rows of controls sit between the window title
bar and the content the user is actually editing.

Neither is how a Mac OS 8 application behaves, and this desktop is built to
behave like one. A document-based app opens a window per document, puts
document commands in the menu bar, and puts frequently-used tools in a floating
palette.

## What already exists

Every mechanism this design needs is already present. Nothing here requires a
change to the `classicy` package.

- **`ClassicyWindow` supports `windowType="utility"`** — a Platinum tool-palette
  window with a crosshatch drag region instead of a 19px title bar (`#205`). An
  `alwaysOnTop` prop exists for palettes that must float above *other* apps; we
  do not want that here (see Decisions).
- **The menu bar follows the focused window, not the app.** Classicy's focus
  reducer assigns `Desktop.appMenu` only when the newly focused window supplies
  an `appMenu`. A window that passes no `appMenu` leaves the previous window's
  menus on screen rather than blanking the bar. `IMBuddies` relies on this
  already: its utility `InfoWindow` is deliberately menu-less so that focusing
  it does not tear down the File menu.
- **`IMBuddies` is a working multi-window precedent** in this codebase — windows
  mapped live off provider state (`openChats.map(...)`), the same `appMenu`
  array handed to each document window, and a per-window cascade offset driven
  by the map index (`#318`) so windows don't stack exactly on top of each other.
- **`ClassicyMenuItem` already supports everything the new menus need**:
  `checked` (renders a Mac OS 8 ✓ in a reserved gutter so checked and unchecked
  siblings stay aligned), `menuChildren` (submenus), `balloon`
  (`{title?, content, position?}`), `keyboardShortcut`, and `disabled`.
- **`{ id: "spacer" }` is Classicy's separator convention** — an item with that
  id renders as an `<hr>` rather than a row. It is not a placeholder id.
- **`ClassicyButtonToolbar` + `ClassicyBevelButton`** produce exactly the palette
  we want: a run of controls with engraved dividers drawn automatically
  *between* groups, and an icon-only bevel button inside a toolbar defaults to a
  square box. The toolbar implements the ARIA roving-tabindex pattern, so the
  whole palette is one Tab stop.
- **`ClassicyBalloonHelp`** wraps an element and shows balloon help on hover,
  resolving its own position against the viewport.
- **Stock icons for all six Add actions already ship in `ClassicyIcons`** — no
  new art is required.
- **`playlistApi`** already exposes `listMine`, `getPlaylist`, `createPlaylist`,
  `updatePlaylist`, `deletePlaylist`, and `duplicatePlaylist`. Rename and
  publish/draft are both `updatePlaylist` calls; no new API surface is needed.

### The Control window, which already ships

`cd6cc056` added a second window to this app, and this design must not be read
as proposing it:

- **`playlist_editor_control`, titled "Control"**, holding `ControlPanel.tsx` —
  the teacher end of live room control (clock lock shipped; content lock present
  but disabled, so the group reads as the pair it will become).
- It is revealed by an existing **`Window > Control`** menu item using a
  reveal-and-focus idiom borrowed from TV's Settings window: `setShowControl(true)`
  followed by a `ClassicyWindowFocus` dispatch, so re-picking the item brings an
  already-open window forward instead of doing nothing.
- **It already has the "which playlist am I acting on?" problem this design
  solves.** It takes `playlistId={openRecord?.id ?? null}` and degrades to
  `CONTROL_NO_PLAYLIST` ("Open a playlist to control it live.") when nothing is
  open. Once playlists are multi-window, `openRecord` stops being meaningful and
  the Control window needs exactly the `activeId` routing the Add tools need —
  one seam serves both surfaces.
- `ControlPanel` holds lock state locally and flips it **only after the server
  accepts**, because room commands are fire-and-forget and the streamer stores
  nothing to read back. That behavior is load-bearing and out of scope here.
- `Providers/Playlist/RoomControlBridge.tsx` and `roomApi.ts` are the student
  end and the transport. Untouched by this design.

## Decisions

Each of these was chosen explicitly; the rejected alternative is recorded so a
later reader doesn't relitigate it.

1. **The list window persists.** "My Playlists" is the app's `defaultWindow` and
   stays open behind the document windows, as a home base. *Rejected:* closing
   the list on open (loses the home base), and folding the playlist list into
   the Tools palette (conflates a tool palette with navigation).

2. **One global Tools palette, not one per document.** A single utility window
   whose buttons act on the frontmost playlist document. *Rejected:* a palette
   paired to each document (doubles window count), and hiding the palette when
   no document is open (appearing/disappearing chrome is jumpy — it greys out
   instead).

2a. **The Add tools get their own palette; they do NOT join the existing
   Control window.** The Control window drives a *live* session — locking the
   clock for students watching right now. The Add tools *author* a playlist.
   Those are different modes of use, and merging them would put a button that
   changes what thirty students see next to a button that appends a row to a
   draft. *Rejected:* adding the toolbar to `ControlPanel.tsx` alongside the Lock
   group, and one window split into Tools/Live sections. The cost accepted here
   is one more window and one more `Window` menu item.

3. **File > Rename… renames in place.** No copy is created; `File > Duplicate`
   already covers the copy case. *Rejected:* true "Save As" semantics, and
   shipping both as two items.

4. **Save warnings become a modal `ClassicyAlert` scoped to the document
   window.** `SaveBar`'s validation gates are kept exactly; only their
   presentation changes. *Rejected:* a bottom status strip and the window
   placard — both reintroduce persistent chrome, which is what this change is
   removing.

5. **Status is a `File > Status ▸` submenu** with checkmarked Draft / Published
   children. *Rejected:* two top-level checkmarked items (lengthens File), and a
   single item whose verb flips (hides the current state).

6. **Quit is only ever `File > Quit`.** Closing any window — the list included —
   closes just that window and leaves the app running. *Rejected:* "closing the
   list quits" and "last window out quits".

7. **Duplicate opens the copy in a new window,** focused, leaving the original
   window untouched. *Rejected:* creating it silently and only refreshing the
   list.

8. **Stock `ClassicyIcons` glyphs for the palette.** *Rejected:* blocking on
   bespoke art. Balloon help carries the meaning; swapping in custom PNGs later
   changes only the imports.

9. **The Tools palette carries a menu of last resort, and is the one
   non-closable window.** Decision 6 creates a hole: with every window closable
   and no "last window quits" rule, closing all windows leaves no window
   supplying an `appMenu`, so the menu bar keeps showing the *stale* File menu of
   a window that no longer exists — its Save and Delete items pointing at a dead
   document, and no reachable `File > Quit`. The palette therefore passes an
   `appMenu` **only while zero document windows are open**: a short File +
   Window menu. While any document window exists the palette stays menu-less, so
   clicking it leaves the frontmost document's menus on screen instead of
   swapping the menu bar out from under the user mid-click.

   The palette is consequently `closable={false}` (but `collapsable`), which is
   a deliberate departure from the Control window's closable + `Window > Control`
   reveal pattern. The palette is the app's guaranteed menu anchor; the Control
   window is not, and keeps its existing behavior unchanged.

10. **A `Window` menu with a live open-window list.** The app already has
   `Window > Control`. With N playlist documents, a window buried behind others
   would otherwise be unreachable, so the menu gains Tools plus one item per open
   window. Following `IMBuddies`, the list is rebuilt from provider state on
   every render — never snapshotted — so a window opening or closing is
   reflected in the same render that mounts or unmounts it.

## Architecture

### Windows

Six window kinds under one `ClassicyApp` (`PlaylistEditor.app`). Two of them —
Control and the gate — already exist and change only where noted:

| Window | id | Type | Menus | Notes |
|---|---|---|---|---|
| My Playlists | `playlist_editor_list` | document | File, Window | `defaultWindow`. Persistent. Renamed from `playlist_editor_main`. |
| Playlist document | `playlist_doc_<playlistId>` | document | File, Edit, Window | One per open playlist; cascaded by index. |
| Tools palette | `playlist_editor_tools` | **utility** | File, Window (only when no document is open) | **New.** `closable={false}`, `collapsable`. Not `alwaysOnTop`. |
| Control | `playlist_editor_control` | document | — | **Exists.** Only its `playlistId` source changes: `openRecord?.id` → `activeId`. |
| Rename dialog | `playlist_rename_dialog` | modal | — | **New.** Singleton; targets `activeId`. |
| Sign-in gate | `playlist_editor_gate` | modal | — | Unchanged. |

`playlist_editor_main` is renamed to `playlist_editor_list` because it stops
being "the app's one window" and becomes specifically the list. Window ids are
persisted in the Classicy store, so a returning user's saved geometry for the old
id is simply not found and the window opens at its `initialPosition` — acceptable
for a rename that also changes the window's size and role.

The Control window stays a plain document window, `closable`, revealed by
`Window > Control`. It is **not** converted to a utility palette: it is not the
menu anchor (decision 9), and changing its class would alter shipped behavior
this design has no reason to touch. It supplies no `appMenu` today and continues
not to, so focusing it leaves the frontmost document's menus on screen.

A document window's title is the playlist's current title, tracking
`state.title` live as Rename changes it. Mac OS 8 has no dirty-title convention,
so an unsaved document is not marked in its title bar; `File > Save` being
enabled is the dirty indicator.

**Signed out**, only the gate renders — no list window, no palette, no Control
window. That is today's behavior (every other window is already gated on
`status === "signedIn"`) and decision 6 does not change it: the gate is modal,
and closing it still quits, because a signed-out app has nothing it could do.

`ClassicyAlert` cannot host the Rename field — its contract is explicitly "only
an icon, text, and buttons — no other controls." The Rename dialog is therefore
a small non-resizable modal `ClassicyWindow` wrapping a form, following
`TimeMachine/BookmarkDialog.tsx` (a `ClassicyWindow` shell + a separate
`…DialogForm` component, so the form is testable without the window chrome).

The palette is deliberately **not** `alwaysOnTop`. `alwaysOnTop` floats a
palette above *every other app's* windows even when its own app is backgrounded;
the Playlist Editor's palette should drop behind whatever app the teacher
switches to, which is the default `#234` behavior.

### State

`PlaylistEditorMain` currently owns a `useReducer(editorReducer, record,
initialEditorState)`. A floating palette cannot dispatch into per-window
component state, so editor state lifts to an app-level provider keyed by
playlist id:

```ts
type EditorStates = Record<string, EditorState>   // one entry per open document
type KeyedAction = { playlistId: string } & EditorAction
```

`editorReducer` and `EditorState` are **unchanged**. A thin keyed wrapper routes
each action to `states[action.playlistId]` and leaves the rest of the map alone.
This preserves every existing `editorState.test.ts` case and adds one small,
independently testable reducer.

The provider holds:

- `states: EditorStates` — keyed editor state, one entry per open document.
- `records: Record<string, PlaylistRecord>` — the last-saved record per open
  document, so a save can refresh the list window without a refetch.
- `openIds: string[]` — open documents in open order; the index drives each
  window's cascade offset.
- `activeId: string | null` — the last-focused document window's playlist id.
- `dialogMode: "media" | "file" | null` — the singleton file-open dialog.
- `renaming: boolean` — whether the Rename dialog is up.
- `showControl: boolean` — kept exactly as it is today, for `Window > Control`.

The Tools palette needs no visibility flag: it is non-closable and always
rendered while signed in (decision 9).

### How the palette reaches the active document

`activeId` is set by each document window when *it* becomes focused, read from
app-manager state:

```ts
useAppManager((s) =>
    s.System.Manager.Applications.apps[APP_ID]?.windows
        .find((w) => w.id === myWindowId)?.focused)
```

Focusing the **palette** does not clear `activeId` — the palette is a utility
window and its own focus is irrelevant to which document it targets. This is the
Mac palette semantic: the palette acts on the last-focused document, so clicking
a palette button never has to be preceded by re-selecting the document.

With `activeId === null` (only the list open, or nothing at all), every palette
button and every `Edit > Add…` item is disabled.

**The Control window rides the same seam.** It changes from
`playlistId={openRecord?.id ?? null}` to `playlistId={activeId}`, with
`playlistTitle` read from `states[activeId].title` so a rename is reflected
immediately. Its existing `CONTROL_NO_PLAYLIST` fallback then covers "no document
window is frontmost" without any change to `ControlPanel.tsx` itself — the
component's props already model exactly this. Note the consequence worth stating
plainly: with several playlists open, `Lock > Clock` acts on the **last-focused**
one, which is why the window names the playlist it is controlling in its body.

`ClassicyFileOpenDialog` moves up to the provider level alongside the palette. It
is already a singleton (`id="playlist_editor_open"`), it is now triggered from
the palette rather than from a document body, and its `onOpenFunc` dispatches
`selectionsToEntries(...)` to `activeId`. Its `volumes` still come from
`useClassicyFileSystem()` plus `createDirectusVolume`, and the `sourcesRef`
pattern (a ref so the volume's closures see live source lists while the volume's
own identity stays stable for the dialog's per-folder cache) is preserved
verbatim — it is load-bearing, not incidental.

### Save, and the `useSavePlaylist` extraction

`SaveBar.tsx` is replaced by a `useSavePlaylist(state)` hook that returns the
same three validation gates as state rather than as rendered JSX:

- definition fails to parse → block, "This playlist is invalid and can't be saved."
- validation drops entries (`parsed.definition.entries.length < state.entries.length`)
  → block with the warning list, because saving raw state would silently lose
  them on next open.
- validation warns but drops nothing → confirm ("Save Anyway").
- `AuthRequiredError` on write → "You've been signed out. Sign in via the
  Account app, then save again."

A `ClassicyAlert` scoped to the document window renders whichever of those
states is active. This extraction is what lets `File > Save`, the dirty-close
prompt, and `File > Delete…` share one code path instead of three copies of the
gate logic — the reason `SaveBar` was embedded in the close-confirm strip today.

## Menus

### Playlist document window — File

| Item | Behavior |
|---|---|
| Open… | Opens (if closed) and focuses `playlist_editor_list`. |
| `spacer` | |
| Save (⌘S) | Disabled unless `state.dirty`. Runs the `useSavePlaylist` gates. |
| Rename… | Opens the Rename dialog; `updatePlaylist` renames in place on OK. |
| Duplicate | `duplicatePlaylist`, then opens the copy in a new focused window. |
| `spacer` | |
| Status ▸ | ✓ Draft / ✓ Published — checked on the current status. |
| `spacer` | |
| Delete… | Confirmation alert; on confirm deletes and closes this window. Does **not** also raise the dirty-save prompt — the document is being destroyed, so offering to save it first is incoherent. Per HIG the safe button (Cancel) is the alert's default. |
| `spacer` | |
| Quit | `quitMenuItemHelper(APP_ID, APP_NAME, appIcon)`. |

The item is labeled **Rename…**, not "Save As…". Given decision 3 it renames in
place, and "Save As…" would promise a copy that `Duplicate` actually provides.

### Playlist document window — Edit

| Item | Behavior |
|---|---|
| ✓ Restrict | `setMode: "restrict"`. Carries `balloon`. |
| ✓ Annotate | `setMode: "annotate"`. Carries `balloon`. |
| `spacer` | |
| Add… ▸ | Media…, File…, App Rule, Settings, Jump, Browser |

Balloon copy:

- **Restrict** — "Students see only what this playlist includes. Everything else
  on the desktop is hidden or disabled."
- **Annotate** — "Students keep the full desktop. This playlist only adds notes,
  jumps, and scheduled events on top of it."

The six `Add…` children and the six palette buttons dispatch through one shared
helper (`addActions(dispatch, playlistId)`), so the two surfaces cannot drift
apart as entry kinds are added.

### Every window — Window

Shared by the list window and every playlist document (decision 10):

| Item | Behavior |
|---|---|
| Control | Existing item, unchanged: reveal-and-focus `playlist_editor_control`. |
| Tools | Focus `playlist_editor_tools`. No reveal needed — it is never closed. |
| `spacer` | |
| My Playlists | Reveal-and-focus the list window. |
| *(one per open document)* | The playlist's title; focuses its window. Rebuilt every render from `openIds`. |

### List window — File

New · Open · `spacer` · Quit. The list window's existing action buttons (New,
Open, Duplicate, Delete, Copy Link) are unchanged.

### Tools palette — File and Window (only while no document window is open)

File: Open · `spacer` · Quit. Window: as above, minus the empty document list.
See decision 9 for why these appear conditionally.

## Tools palette contents

A `ClassicyButtonToolbar` of six icon-only `ClassicyBevelButton`s, each wrapped
in `ClassicyBalloonHelp`, in three groups — the toolbar draws the engraved
dividers between them automatically:

| Group | Button | Icon | Entry created |
|---|---|---|---|
| 1 | Add Media… | `system.quicktime.movie` | opens the file dialog in `media` mode |
| 1 | Add File… | `system.files.document` | opens the file dialog in `file` mode |
| 2 | Add App Rule | `system.files.application` | `{kind:"app", appId:"TimeMachine.app", disabled:true}` |
| 2 | Add Settings | `system.files.preferences` | `{kind:"settings", appId:"TV.app", values:{}}` |
| 3 | Add Jump | `system.extensions.dateAndTime` | `{kind:"jump", at:"", to:""}` |
| 3 | Add Browser | `system.network.globe` | `{kind:"browser", url:"http://", at:""}` |

Every button is disabled when `activeId === null`. Each balloon names the action
and says what it adds, since the buttons carry no text label.

## What the removed header displaces

`playlistEditorHeader` and `playlistEditorAddBar` are deleted. `playlistEditorBody`
becomes the document window's first child, with `PlaylistTimeline` beneath it as
today.

| Was in the header | Now |
|---|---|
| ‹ My Playlists | The list window is always open; `File > Open…` |
| Title text field | Window title bar + `File > Rename…` |
| Restrict / Annotate radios | `Edit` menu, with balloon help |
| Status `<select>` | `File > Status ▸` |
| Save button | `File > Save` (⌘S) |
| `SaveBar` inline warnings | `ClassicyAlert` per document window |
| Six "Add …" text buttons | Tools palette + `Edit > Add… ▸` |

The dirty-close flow stops replacing the window body with a strip and becomes a
Save / Don't Save / Cancel `ClassicyAlert`, consistent with decision 4. Per
decision 6 it fires on closing a *document window*, and closing that window no
longer quits the app.

## Testing

**Untouched** (pure logic, no window model dependency): `editorState.test.ts`,
`timelineLayout.test.ts`, `resolveTimelineMeta.test.ts`, `directusVolume.test.ts`,
`directusQueue.test.ts`, `parsePlaylist.test.ts`, `PlaylistTimeline.test.tsx`,
`EntryForm.test.tsx`, `PlaylistList.test.tsx`.

**Rewritten:** `PlaylistEditor.test.tsx`, `PlaylistEditorMain.test.tsx`,
`SaveBar.test.tsx` (becomes `useSavePlaylist.test.ts`),
`PlaylistEditor.integration.test.tsx`.

**`ControlPanel.test.tsx` keeps all its existing cases** — the component's props
are unchanged, so only the wiring above it moves. One case is added at the
`PlaylistEditor` level: the Control window's `playlistId` follows `activeId`, so
focusing a different playlist window retargets it, and closing the last document
window returns it to `CONTROL_NO_PLAYLIST`.

**New coverage:**

- Keyed reducer routes an action to one playlist id and leaves the others' state
  identical (reference equality, not just deep equality).
- Palette buttons and `Edit > Add…` items are disabled when `activeId === null`.
- A palette click dispatches into the *last-focused document*, not the first
  open one, and not the palette-focus event.
- Menu of last resort: with zero document windows the palette supplies a File
  menu; with one or more it supplies none.
- Per-window dirty isolation: saving document A leaves document B's `dirty` flag
  set.
- Closing a document window does not quit the app; `File > Quit` does.
- Duplicate opens a second window rather than replacing the first.
- Rename updates the document window's title and the list row, and Cancel
  leaves both unchanged.
- Signed out, neither the list window nor the palette renders — only the gate,
  and closing the gate still quits.
- `File > Delete…` on a dirty document does not raise the dirty-save prompt.
- The `Window` menu lists exactly the open document windows, and picking one
  focuses it.

Frontend vitest has no RTL auto-cleanup — every new test file needs its own
`afterEach(cleanup)`.

## Out of scope

- Any change to the `classicy` package.
- Any change to the playlist runtime engine (`Providers/Playlist/*`), the wire
  protocol, or the Directus schema.
- **Live room control.** `ControlPanel.tsx`'s internals, `roomApi.ts`,
  `RoomControlBridge.tsx`, and the streamer's `/room` endpoint are untouched.
  The only change in that area is which playlist id the Control window is handed
  — a one-prop change at the call site, not inside the component.
- Content locking (the disabled second button in the Control window's Lock
  group) remains unbuilt.
- Visual polish of the editor body beyond removing the two chrome rows.
- Bespoke palette icon art (decision 8 defers it; the imports are the only thing
  that would change).
