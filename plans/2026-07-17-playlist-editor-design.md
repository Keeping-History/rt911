# Playlist Editor App & Classicy File Open Dialog — Design Spec

**Date:** 2026-07-17
**Status:** Approved (brainstorm sign-off, section by section)
**Depends on:**
- Teacher Playlists engine (shipped — `plans/2026-07-16-teacher-playlists-design.md`)
- Playlist Auth (implemented — `plans/2026-07-16-playlist-auth-design.md`; `AuthProvider`,
  `Account` app, and `playlistApi.ts` all exist in `packages/frontend`)

**Scope:** Three interlocking pieces in one spec, implemented as phases A → B → C so each
lands independently:

- **A. Classicy library** (`~/classicy`): `ClassicyTree` selection/disabled extensions, a
  volume-provider interface, and a new `ClassicyFileOpenDialog` component.
- **B. rt911 Directus network volume** (`packages/frontend`): a
  `ClassicyFileDialogVolume` implementation exposing playlist-addressable collections as
  browsable folders.
- **C. Playlist editor app** (`packages/frontend`): sign-in-gated Classicy app for
  creating/editing the full `PlaylistDefinition`, saved via the existing `playlistApi.ts`.

## Decisions (from brainstorm)

| Question | Decision |
|---|---|
| App purpose | The playlist **editor** deferred by the auth spec; picking a "file" from the network volume = adding a playlist entry; persistence via `playlistApi.ts` |
| Editor scope | **Full definition editor** — UI for all six entry kinds (media, app, settings, file, jump, browser) |
| Tree component | Use the recently added `ClassicyTree`; extend it (selection, disabled) rather than build new |
| Data architecture | **Volume-provider abstraction** in classicy (Approach 1); Directus knowledge stays in rt911; rejected: materializing network data into `ClassicyFileSystem` (eager loads, pollutes persisted FS), rt911-only dialog (not reusable) |
| Grayed files | **Filter mismatch only** — files not matching the active file-type filter are visible but grayed/unclickable; no data-driven availability logic |
| Decomposition | One spec, phased plan A → B → C (classicy publishes first) |
| Timeline display | **Read-only** in v1; flags for indeterminate items, bars for windowed items; drag-editing deferred |
| Gating UX | Anonymous open → modal stop-alert with a single **Quit** button that quits the app |

## §A Classicy library work

All new library code lives in `src/SystemFolder/SystemResources/FileDialog/` except the
tree changes. Everything is additive — no breaking changes; default behavior of existing
components is unchanged.

### A1. Volume provider interface

```ts
export type ClassicyFileDialogEntry = {
    id: string                 // stable within the volume
    name: string
    kind: 'folder' | 'file'
    fileType?: ClassicyFileSystemEntryFileType | string  // existing enum, extensible with app-specific strings
    icon?: string
    meta?: Record<string, unknown>   // opaque payload returned to the caller on select
}

export type ClassicyFileDialogVolume = {
    id: string
    label: string              // "Macintosh HD", "911 Realtime Archive"
    icon?: string              // drive / network-volume icon
    list(path: string[]): Promise<ClassicyFileDialogEntry[]>   // lazy, one folder at a time
}
```

Two built-in volume factories ship with the library, both thin wrappers over the existing
`ClassicyFileSystem` (`statDir` + entry metadata), resolving synchronously behind the
async signature:

- `desktopVolume(fs)` — the Desktop folder
- `fileSystemVolume(fs, drive)` — a classic drive

Network volumes are anything else the host passes in; classicy never knows about Directus.

### A2. `ClassicyTree` extensions (additive)

- `ClassicyTreeNode` gains:
  - `disabled?: boolean` — grayed via the standard disabled styling, not clickable,
    skipped by keyboard navigation
  - `selectable?: boolean`
  - `buttons?: ClassicyTreeNodeButton[]` — multiple per-leaf buttons (the existing
    single `button` prop remains supported; `buttons` wins if both are set)
- New tree-level props:
  - `selectionMode?: 'none' | 'single' | 'multi'` (default `'none'` — current behavior)
  - `selectedIds?: string[]`
  - `onSelectNode?: (id: string, node: ClassicyTreeNode, e: MouseEvent) => void`
- Multi-select semantics: Cmd-click toggles, Shift-click ranges within the same folder.
- Selection rendering: standard inverted row highlight.
- The tree stays a dumb presentational primitive — no data fetching; consumers rebuild
  `nodes` and use `onToggleNode` for lazy expansion.

### A3. `ClassicyFileOpenDialog`

Follows the `ClassicyColorPickerDialog` pattern exactly: controlled `open` prop, renders
a `modal={true}` `ClassicyWindow`, callbacks out.

```ts
type ClassicyFileOpenDialogProps = {
    id: string
    appId: string
    open: boolean
    title?: string                          // default "Open"
    volumes: ClassicyFileDialogVolume[]     // first entry is initially active
    selectionMode?: 'single' | 'multi'      // default 'single'
    fileTypeFilters?: { label: string; types: string[] | null }[]  // null types = show all
    onOpenFunc: (selections: Array<{
        volumeId: string
        path: string[]                      // folder path within the volume
        entry: ClassicyFileDialogEntry      // includes the opaque `meta`
    }>) => void
    onCancelFunc?: () => void
}
```

**Layout** (Mac OS 8 StandardFile, adapted for a tree):

- **Top:** `ClassicyPopUpMenu` of volumes (with volume icon). Switching volumes swaps the
  tree to that volume's root and clears the selection.
- **Middle:** the `ClassicyTree` in a scrollable sunken well (list-box style). Folders
  lazy-load on expand via `volume.list(path)`; while loading, a temporary child row shows
  a `ClassicySpinner`; a failed load renders an inline "Couldn't open this folder" row
  that retries on click.
- **Bottom left:** a "Show:" `ClassicyPopUpMenu` when `fileTypeFilters` is provided.
- **Bottom right:** Cancel + **Open** (default button). Open is disabled until at least
  one file is selected.

**Filtering & graying:** files whose `fileType` is not in the active filter get
`disabled: true` on their tree node — grayed and unclickable but still visible. Folders
are never grayed (users can always traverse). Changing the filter drops now-disabled
items from the selection.

**Selection & activation:** single mode = click replaces selection; multi = Cmd/Shift as
in A2. Double-click an enabled file = immediate Open with that file. Double-click a
folder toggles expansion. Enter triggers Open when enabled; Escape cancels.

### A4. Release coordination

Classicy work merges first; push to main auto-bumps + publishes to npm. rt911 consumes
`"latest"` (the pre-commit hook auto-bumps the lockfile). During development, use
`pnpm use:local` / `use:published` from `packages/frontend`.

## §B Directus network volume (rt911)

A single `directusVolume.ts` in `packages/frontend` implements
`ClassicyFileDialogVolume` with `id: 'rt911-archive'`, label **"911 Realtime Archive"**,
and a network-drive icon. Folder hierarchy per collection, each structured to fit its
data:

| Top folder | Structure | Leaf `fileType` | Leaf `meta` |
|---|---|---|---|
| TV Channels | by network → channel | `tv-channel` | `{ app: 'tv', itemId: <source slug> }` |
| Radio Stations | flat (small list) | `radio-station` | `{ app: 'radio', itemId: <station slug> }` |
| News | by publication → document | `news-document` | `{ app: 'news', itemId: <doc id>, publishedAt }` |
| Flights | Notable Flights folder + by airline → flight | `flight` | `{ app: 'flights', itemId: <callsign>, departure, arrival }` |

The `meta` payload leads with exactly the addressing the playlist engine already uses
(`PlaylistEntry` media keys), so the editor consumes dialog selections with zero
translation. The extra keys (`publishedAt`, `departure`, `arrival` — UTC ISO) exist for
the timeline display (§C4): flag placement for news and the actual-flight shading for
flights, without any additional fetches. The editor stores them alongside its entry state
(not in the saved definition).

**Implementation discipline:**

- `list()` fetches lazily, one folder per call; **all Directus requests are serialized**
  through a small in-module queue (api-beta concurrent-fetch body-mixing bug — same rule
  as `useRouteIndex` / `useNotableCrashSites`).
- Per-folder results cached in a session-lifetime `Map`; collapse/re-expand and dialog
  reopen reuse the same volume instance without refetching.
- Only published/public rows arrive (public read permissions enforce this server-side);
  no client-side availability logic — graying is purely filter-driven.
- Exact field names/queries are verified against the live schema **at plan time**, not
  assumed here (flight field limits are license-gated — known gotcha).

The Playlist app passes three volumes to the dialog: `Desktop`, `Macintosh HD` (both from
§A1 factories), and `911 Realtime Archive`. For `file`-kind entries the dialog is invoked
with **local volumes only**, since those entries address `ClassicyFileSystem` paths (the
editor joins the returned `path` + entry name with `:` to form the classic path).

## §C Playlist editor app

New Classicy app: **`PlaylistEditor.app`** (display name "Playlists"), desktop icon +
Finder entry, registered like any other app. (The id avoids colliding with the playlist
*engine's* existing `ClassicyAppPlaylist` event prefix in `playlistStoreActions.ts`.)

### C1. Sign-in gating

On open, the app checks `useAuth()`:

- `anonymous` → instead of the editor window, a modal Mac OS 8 stop-alert: *"You must be
  signed in to create playlists."* with a single default **Quit** button that quits the
  app (same `quitAppHelper` path the engine uses). Closing the dialog also quits. Nothing
  else renders.
- `loading` → a small splash with `ClassicySpinner` until auth resolves (no error flash
  for signed-in users on slow boots).
- `signedIn` → the editor.
- Mid-session sign-out swaps the editor back to the alert.

### C2. Editor window — two views, one window

1. **My Playlists** (initial view): the teacher's playlists via `playlistApi.listMine()`
   — title, status (draft/published), updated date — with **New**, **Duplicate**,
   **Delete** (confirm dialog), and **Open** buttons. Published rows also get **Copy
   Link** (the `?playlist=<id>` student URL).
2. **Editor** (per playlist): title field, `mode` radio (restrict/annotate), status popup
   (draft/published), the **entry list**, and the **timeline display** (C4). The entry
   list is a `ClassicyTree` with one branch per entry kind (Media, Apps, Settings, Files,
   Jumps, Browser); each leaf is a summarized entry with per-leaf **Edit** / **Remove**
   buttons (the A2 `buttons` slot).

### C3. Adding & editing entries

- **Media** → `ClassicyFileOpenDialog` with all three volumes, `fileTypeFilters` covering
  the four media types, **multi-select**; each selection becomes
  `{ kind: 'media', app, itemId }` from `meta`; window (`start`/`end`) and `focus` are
  edited per entry afterward.
- **File** → same dialog, local volumes only, single-select → `{ kind: 'file', path, at }`.
- **App / Settings / Jump / Browser** → small per-kind forms: popup of known appIds,
  `ClassicyDatePicker` + `ClassicyTimePicker` for virtual-timeline datetimes (UTC ISO
  stored; display tz applied in UI), JSON textarea with parse-on-blur validation for
  settings `values`.

### C4. Timeline display (read-only, rt911 component `PlaylistTimeline`)

A read-only strip at the bottom of the editor view. Playlist-domain-specific, so it lives
in rt911, not classicy.

- **X-axis:** the virtual timeline spanning the clock's min/max bounds (2001-09-09 →
  09-18), hour/day ticks labeled in display timezone (UTC-4), positions computed from UTC
  ISO via the existing `virtualUtcMs` convention.
- **Flag row (top):** entries without a determinate extent render as **flags** — a pole
  planted at their moment with a small pennant carrying icon + short label. Covers news
  documents (planted at publication time) and point events (jumps — with a small arrow
  toward the landing time, file opens, browser navigations). Flags stagger vertically to
  avoid overlap. A news entry with an explicit start/end window plants its flag at
  `start` with a hairline extent line along the flag row; the flag stays the primary
  glyph.
- **Duration lanes (below):** windowed entries with real extent — TV channels, radio
  stations, flights — as bars grouped by app, from `start` to `end`; omitted ends extend
  to the timeline edge with a faded ramp (unbounded reads differently from "ends here").
  Focus annotations: ▸ marker at start for `once`, lock glyph for `locked`. Flight bars
  additionally shade the actual departure→arrival span inside the availability bar
  (data already in `flight_tracks`).
- **Metadata resolution:** entries added via the dialog carry `publishedAt` /
  `departure` / `arrival` in their picked `meta` (§B). When an existing playlist is
  loaded, that metadata isn't in the saved definition — the editor resolves it lazily
  through the same serialized Directus queue (one lookup per news/flight entry, cached
  for the session); until resolved, a news flag plants at the entry's `start` (or the
  timeline origin) and a flight bar shows without the actual-flight shading.
- **Interaction:** click a flag/bar → selects that entry in the entry tree and opens its
  edit form; hover tooltip with exact times. Nothing draggable in v1.
- **Rendering:** absolutely-positioned divs in a scrollable well — no canvas or chart
  library; styled with Classicy system colors/patterns.

### C5. Save flow

Editor state lives in React only — nothing in ClassicyStore/localStorage (same discipline
as auth and playlist runtime state). Save runs the assembled definition through the
existing `parsePlaylist` validator first; problems surface in a dialog before writing via
`playlistApi.create` / `update`. Dirty-state tracking gives a "Save changes before
closing?" three-button alert (Save / Don't Save / Cancel) on window close.

## Error handling

| Case | Behavior |
|---|---|
| App opened anonymous | Modal stop-alert; **Quit** button (and window-close) quits the app |
| Auth still loading at open | Spinner splash; resolves to editor or the alert |
| Mid-session sign-out / 401 on any API call | Editor swaps to the alert; a failed **save** keeps editor state so work isn't silently lost — sign back in via Account app and retry |
| 403 (not owner) | Classicy error dialog (auth-spec behavior, unchanged) |
| Volume `list()` fails in the dialog | Inline "Couldn't open this folder" row; click retries |
| `parsePlaylist` finds problems on save/publish | Alert listing them; invalid entries = blocked, warnings (e.g. backward jump) = proceed/cancel choice |
| Delete playlist | Confirm dialog first |
| Close with unsaved changes | Save / Don't Save / Cancel |

## Testing

- **classicy** (vitest + Storybook stories, in-repo conventions):
  - `ClassicyTree`: selection modes (none/single/multi, Cmd/Shift), disabled rows not
    clickable and skipped by keyboard nav, `buttons` slot.
  - `ClassicyFileOpenDialog`: volume switching resets tree + selection; lazy-load spinner
    row; error-retry row; filter graying + selection drop on filter change; single/multi
    semantics; double-click/Enter/Escape; `onOpenFunc` payload shape.
- **rt911** (vitest; new test files need `afterEach(cleanup)` — no RTL auto-cleanup):
  - `directusVolume`: folder mapping per collection; request serialization (assert no
    overlapping fetches); per-folder cache.
  - Playlist app: three auth states + quit path; list/editor transitions; entry
    add-from-dialog (mocked dialog); per-kind forms; save gate through `parsePlaylist`;
    dirty-close flow.
  - `PlaylistTimeline`: pure layout math extracted (`timeToX`, lane assignment, flag
    stagger) and table-tested; light render tests for bars vs flags.
- **E2E (Playwright), one spec:** mocked `/users/me` anonymous → alert + Quit removes the
  window; signed-in fixture → new playlist → File Open dialog against a mocked Directus
  volume → add a TV channel → save → assert the PATCH body. Assert behavior/store, never
  menu UI (known Classicy menu-click flakiness).
- **Release order:** phase A merges and publishes before B/C consume it; the plan
  sequences this explicitly.

## Out of scope (explicit)

- Timeline drag-editing (bars/flags are read-only in v1).
- Windowed app disabling, `command`-kind entries (future engine extensions, per the
  teacher-playlists spec).
- Server-side definition validation (endpoint-extension mechanism remains in the back
  pocket).
- Migrating existing ownerless playlists; teacher-to-teacher collaboration beyond
  duplicate.
- Any change to the student consumption path (`loadPlaylist`, the engine, the wire
  format).
