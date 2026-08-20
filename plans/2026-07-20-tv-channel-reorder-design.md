# TV Channel Reorder — Design

**Date:** 2026-07-20
**Status:** Approved (brainstorm complete; implementation plan to follow)
**Package:** `packages/frontend` — `src/Applications/TV/`

## Problem

The TV app's thumbnail strip lists channels in whatever order they first
arrived over the WebSocket — there is no explicit sort anywhere in the chain
(`useMediaStream`'s `applyFilter` filters but never sorts; `MediaStreamProvider`'s
`mergeById` preserves first-insertion order). Users should be able to drag
thumbnails into an order they choose, have it persist locally, and have it take
precedence if server-side ordering is added later.

Dragging must not focus a video: only a plain click focuses it (or adds it to
multiview when multiview mode is active).

## Decisions (from brainstorm)

| Question | Decision |
|---|---|
| Ordering identity | **`item.source`** (channel slug), never `item.id` — ids change as programs roll over the virtual clock. |
| Unknown channels | **Append to the end**, preserving the incoming array's relative order. |
| Drag vs click | **5px movement threshold** on the whole tile; no drag handle, no long-press. |
| DnD implementation | **Hand-rolled pointer events** — no `dnd-kit`/`react-dnd`/HTML5 DnD. |
| Persistence | New `channelOrder: string[]` in `apps["TV.app"].data` via a reducer action; Classicy snapshots it to `localStorage` automatically. |

### Why not a library

`dnd-kit` would give keyboard reordering and animated transforms, but it is a
new runtime dependency plus sensor/context wiring for one horizontal strip;
its `PointerSensor` activation constraint is exactly the threshold we need
anyway. HTML5 native DnD has no threshold concept (making click/drag
disambiguation hacky), an unstylable browser drag image, and no touch support —
which matters because `src/Mobile/` shares this codebase.

## Architecture

Three new units, each independently testable, plus small wiring changes in
`TV.tsx`.

### 1. `TV/channelOrder.ts` — pure ordering

```ts
orderChannels(items: MediaItem[], channelOrder: string[]): MediaItem[]
moveChannel(order: string[], from: string, to: string): string[]
```

`orderChannels`:
- Items whose `source` appears in `channelOrder` come first, in that sequence.
- All others follow, **preserving the incoming array's relative order** — this
  is the precedence rule: the user's order wins; the underlying order (today
  arrival order, tomorrow server order) supplies the default for the rest.
- Slugs in `channelOrder` with no matching item are skipped (a disabled or
  not-yet-streamed channel must not leave a hole or throw).

`moveChannel`:
- If `from` is not already in `order`, first **materialize the current visible
  order** into slugs, then apply the move. Without this, the first drag would
  produce a one-element array and send every other channel to the end.
- Returns a new array; never mutates.

### 2. `TV/useThumbnailReorder.ts` — gesture state

Owns all pointer state so `TV.tsx` (already ~40KB) gains wiring, not logic.

- `onPointerDown(source)` — record `{source, startX, startY}` and
  `setPointerCapture` so moves keep arriving if the pointer leaves the tile.
  Nothing visible yet; this may still be a click.
- `onPointerMove` — if not dragging and `Math.hypot(dx, dy) > 5`, enter drag
  mode. While dragging, derive the drop target by comparing pointer x against
  each tile's `getBoundingClientRect()` midpoint. Exposes `dragSource` and
  `dropTarget` for styling.
- `onPointerUp` — if dragging: commit via `moveChannel`, dispatch, and set
  `suppressClickRef`. If never dragged: do nothing, let the native click fire.
- `onPointerCancel` / `Escape` — abort: no reorder, no suppression.
- `consumeSuppressedClick(): boolean` — returns **and clears** the flag in one
  call, so suppression cannot leak into the next genuine click.

Threshold constant: `DRAG_THRESHOLD_PX = 5`.

### 3. Persistence — `TVContext.ts`

New reducer case alongside the existing ones:

```
"ClassicyAppTVSetChannelOrder" → data.channelOrder: string[]
```

Dispatched from a `persistChannelOrder` callback modeled on the existing
`persistGridState` / `persistCaptionState` pattern (`TV.tsx:468-490`). Classicy's
store snapshots `apps["TV.app"].data` to `localStorage` under
`classicyDesktopState`, so this is the entire persistence story — local,
per-user, no direct storage calls, consistent with the app's rule that TV state
moves only through action dispatch.

### 4. `TV.tsx` wiring

- Read `channelOrder` from app state; render the strip from
  `orderChannels(items, channelOrder)` (`TV.tsx:1041-1093`). Ordering applies to
  the thumbnail strip only — playback, the EPG panel, and multiview selection
  are untouched.
- Attach `onPointerDown`/`Move`/`Up`/`Cancel` to the existing tile `<button>`.
- Guard the existing `onClick` (`TV.tsx:1056-1073`) with
  `if (reorder.consumeSuppressedClick()) return;` — preserving both current
  behaviors exactly: `setActivePlayer` in normal mode, `togglePlayerSelection`
  in multiview mode.
- Leave the existing `onKeyDown` (Enter/Space) path completely alone.

### 5. Styling — `TV.module.scss`

- `touch-action: none` on the tile, or the mobile shell scrolls the
  `overflow-x: auto` strip instead of dragging.
- Dragged tile at reduced opacity; 2px insertion marker on the drop-target
  edge, using the module's existing palette. No animated transforms.

## Non-goals

- **Keyboard-accessible reordering.** Reordering is pointer-only. The existing
  Enter/Space activation is untouched, so this is additive, not a regression —
  but it is explicitly not covered, and worth revisiting if the strip becomes a
  primary navigation surface.
- Server-side ordering itself (this design only defines precedence for when it
  arrives).
- Cross-device sync of the order (local only, per the requirement).
- Reordering any other list (EPG, multiview grid).

## Testing

- **`channelOrder.test.ts`** — saved order wins; unknown channels append
  preserving incoming relative order; stale slugs skipped; `moveChannel`
  materializes visible order on first drag; **order is stable when `item.id`
  changes but `source` does not** (the program-rollover trap).
- **`useThumbnailReorder.test.ts`** — 3px move then release → no reorder, no
  suppression; 20px move → reorder + suppression; `consumeSuppressedClick`
  clears after one read; cancel aborts cleanly.
- **`TVContext.test.ts`** — add a `ClassicyAppTVSetChannelOrder` case including
  "preserves unrelated fields", matching the existing reducer tests.
- **`TV.reorder.test.tsx`** — built on `TV.embed.test.tsx`'s mock scaffold
  (mocked `classicy`, mocked `useMediaStream`): a plain click still focuses; a
  plain click in multiview mode still toggles selection; a drag does neither.
  This is the regression guard for the core requirement.
- New test files need `afterEach(cleanup)` — this repo's vitest setup has no
  RTL auto-cleanup.

## Risks

- **Program rollover** is the main correctness trap; covered by keying on
  `source` and by an explicit test.
- **Click suppression leaking** into a subsequent click would break focusing;
  covered by the consume-and-clear API and its test.
- **Touch scrolling vs dragging** on the mobile shell; covered by
  `touch-action: none`, but should be verified on a real device — the iOS shell
  has a history of surprises (see `project-mobile-ipod-shell` notes).
