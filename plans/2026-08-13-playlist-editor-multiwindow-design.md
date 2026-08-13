# Playlist Editor: one window per playlist, menus, and a Control Window

**Date:** 2026-08-13
**Status:** Approved, not implemented
**Repo:** `rt911` (this repo), `packages/frontend`

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

## Decisions

Each of these was chosen explicitly; the rejected alternative is recorded so a
later reader doesn't relitigate it.

1. **The list window persists.** "My Playlists" is the app's `defaultWindow` and
   stays open behind the document windows, as a home base. *Rejected:* closing
   the list on open (loses the home base), and folding the playlist list into
   the Control Window (conflates a tool palette with navigation).

2. **One global Control Window, not one per document.** A single utility window
   whose buttons act on the frontmost playlist document. *Rejected:* a palette
   paired to each document (doubles window count), and hiding the palette when
   no document is open (appearing/disappearing chrome is jumpy — it greys out
   instead).

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

9. **The palette carries a menu of last resort.** Decision 6 creates a hole:
   with every window closable and no "last window quits" rule, closing all
   windows leaves no window supplying an `appMenu`, so the menu bar keeps
   showing the *stale* File menu of a window that no longer exists — its Save
   and Delete items pointing at a dead document, and no reachable `File > Quit`.
   The palette therefore passes an `appMenu` **only while zero document windows
   are open**: a two-item File menu (Open, Quit). While any document window
   exists the palette stays menu-less, so clicking it leaves the frontmost
   document's menus on screen instead of swapping the menu bar out from under
   the user mid-click. The palette itself is `closable={false}`, so the app
   always retains at least one window while it runs.

## Architecture

### Windows

Four window kinds under one `ClassicyApp` (`PlaylistEditor.app`):

| Window | id | Type | Menus | Notes |
|---|---|---|---|---|
| My Playlists | `playlist_editor_list` | document | File (short) | `defaultWindow`. Persistent. |
| Playlist document | `playlist_doc_<playlistId>` | document | File, Edit | One per open playlist; cascaded by index. |
| Control Window | `playlist_editor_palette` | **utility** | File (only when no document is open) | `closable={false}`. Not `alwaysOnTop`. |
| Rename dialog | `playlist_rename_dialog` | modal | — | Singleton; targets `activeId`. |
| Sign-in gate | `playlist_editor_gate` | modal | — | Unchanged from today. |

A document window's title is the playlist's current title, tracking
`state.title` live as Rename changes it. Mac OS 8 has no dirty-title convention,
so an unsaved document is not marked in its title bar; `File > Save` being
enabled is the dirty indicator.

**Signed out**, only the gate renders — no list window, no palette. That is
today's behavior and decision 6 does not change it: the gate is modal, and
closing it still quits, because a signed-out app has nothing it could do.

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

### List window — File

New · Open · `spacer` · Quit. The list window's existing action buttons (New,
Open, Duplicate, Delete, Copy Link) are unchanged.

### Palette — File (only while no document window is open)

Open · `spacer` · Quit. See decision 9.

## Control Window contents

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
| Six "Add …" text buttons | Control Window + `Edit > Add… ▸` |

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

Frontend vitest has no RTL auto-cleanup — every new test file needs its own
`afterEach(cleanup)`.

## Out of scope

- Any change to the `classicy` package.
- Any change to the playlist runtime engine (`Providers/Playlist/*`), the wire
  protocol, or the Directus schema.
- Visual polish of the editor body beyond removing the two chrome rows.
- Bespoke palette icon art (decision 8 defers it; the imports are the only thing
  that would change).
