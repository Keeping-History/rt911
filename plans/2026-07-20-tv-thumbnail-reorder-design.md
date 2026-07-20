# TV Channels — drag-to-reorder thumbnail strip

**Date:** 2026-07-20
**Status:** Approved

## Problem

The TV app's thumbnail strip (`packages/frontend/src/Applications/TV/TV.tsx`,
`styles.tvThumbnailStrip`) renders channels in the fixed order the streamer
delivers them. There is no way to reorder channels, and dragging a thumbnail
gives no visual feedback of any kind.

## Goal

Let the user drag a channel thumbnail to a new position in the strip, with a
classic Mac OS 8 "outline drag" visual, and persist the resulting channel order
in the TV app's Classicy state.

## Non-goals

- Touch/mobile support (the mobile shell is a separate iPod UI with no strip).
- Keyboard-driven reordering (may follow later).
- Reordering the multi-select grid players (`selectedPlayers`) — only the
  channel strip order.

## Design

### State & ordering

- New persisted field `channelOrder: string[]` (channel source slugs) in the TV
  app's Classicy state `data`, alongside `disabledChannels`.
- Written via a new `"ClassicyAppTVSetChannelOrder"` desktop dispatch on drop,
  following the existing `"ClassicyAppTVSetDisabledChannels"` pattern.
- The strip renders `items` sorted by `channelOrder`. Channels absent from the
  saved order (new channels, or empty first-run state) append at the end in
  their default (wire) order — first run is visually identical to today.
- Scope note: the EPG panel fetches its own channel data (it takes only an
  `onClose` prop), so its row order is unaffected — only the strip reorders.
- Pure logic lives in `packages/frontend/src/Applications/TV/channelOrder.ts`
  with co-located tests:
  - `sortByChannelOrder(items, order)` — stable sort; unknown sources appended
    in input order.
  - `insertionIndexFromX(thumbnailRects, pointerX)` — index between the two
    thumbnails nearest the pointer's x-position.
  - `applyReorder(sources, fromIndex, toIndex)` — takes the displayed source
    order plus the drag's from/insertion indices and produces the new full
    `channelOrder` array; returns the input unchanged (same reference) when
    the drop is a no-op (same position), so callers can skip persisting.

### Drag interaction (pointer events)

- `pointerdown` on a thumbnail arms a potential drag and captures the pointer.
- The drag only starts after ~5px of movement; below the threshold, release
  behaves exactly like today's click (tune / toggle selection).
- While dragging:
  - The original thumbnail stays in place (classic Mac semantics).
  - A dashed-outline rectangle the size of the thumbnail follows the cursor —
    CSS marching-ants animation, Mac OS 8 style.
  - A vertical insertion bar renders between the two thumbnails nearest the
    cursor's x-position.
- `pointerup` commits: dispatch `ClassicyAppTVSetChannelOrder` with the new
  order (skipping the dispatch entirely for a no-op drop).
- `Escape` cancels the drag with no state change. Pointer capture keeps the
  drag alive when the cursor leaves the strip; pointer-capture loss cancels.

### Styling

- New classes in `TV.module.scss`: the outline rectangle (dashed border,
  marching-ants `background-position` animation, transparent fill) and the
  insertion bar. Rendered inside the strip container (positioned relative),
  not a portal — the strip is the only coordinate space that matters.

## Testing

- `channelOrder.test.ts` — unit tests for the three pure helpers: unknown
  channels appended, stable sort, insertion index at edges/midpoints, no-op
  reorder returns input.
- Component tests in the existing TV test files: a completed drag dispatches
  `ClassicyAppTVSetChannelOrder` with the reordered list; a sub-threshold
  press still tunes the channel; Escape cancels without a dispatch.
