# TV Channels — remember last selection across reloads

**Date:** 2026-07-22
**App:** `packages/frontend/src/Applications/TV`
**Status:** Approved design

## Problem

The TV Channels app should remember the last channel selected in single view and
the set of selected videos in MultiView, persist them to the app's ClassicyState,
and restore them when the page reloads.

The persistence machinery already exists but stores the wrong key. The single-view
active channel (`activePlayer`) and the MultiView selection (`selectedPlayers`,
`mutedGridPlayers`, `gridPlayerVolumes`) are all persisted as **numeric MediaItem
ids**. Those ids belong to the *currently-airing program item* and rotate on every
program rollover and on every fresh stream. So on reload the restored id matches no
current item, and the re-home effect at `TV.tsx:325-330` silently resets the active
player to `items[0]` — the remembered channel and grid selection are lost.

This is the same trap that made `channelOrder` and `currentChannel` store `source`
slugs instead of ids (see the comments in `TVContext.ts`).

## Principle

**Translate at the persistence boundary.** Runtime state stays keyed by item id
(video elements are keyed by id). Only what we write to and read back from the store
changes: persist channel **identity** as the `source` slug, and resolve slugs back to
live item ids once the stream's `items` arrive.

## Persisted fields — `state.System.Manager.Applications.apps["TV.app"].data`

| Field | Meaning | Status |
|---|---|---|
| `currentChannel: string` | single-view active channel slug | already written by the effect at `TV.tsx:208`; **now also read back** to restore `activePlayer` |
| `multiSelectMode: boolean` | grid vs single view | already persisted; id-independent, unchanged |
| `selectedChannels: string[]` | MultiView selected channel slugs | **new** (replaces id-based `selectedPlayers` at rest) |
| `mutedChannels: string[]` | MultiView muted channel slugs | **new** (replaces id-based `mutedGridPlayers` at rest) |
| `channelVolumes: Record<string, number>` | per-channel grid volume keyed by slug | **new** (replaces id-keyed `gridPlayerVolumes` at rest) |

The id-based fields (`selectedPlayers`, `mutedGridPlayers`, `gridPlayerVolumes`) remain
purely runtime React state inside `TV.tsx`; they are no longer the source of truth for
restore and are no longer written to the store.

## Components

### 1. `TVContext.ts`

`ClassicyAppTVSetGridState` carries the slug-based fields instead of the id-based ones:

```ts
case "ClassicyAppTVSetGridState":
    apps[appId].data = {
        ...appData,
        multiSelectMode: action.multiSelectMode,
        selectedChannels: action.selectedChannels,
        mutedChannels: action.mutedChannels,
        channelVolumes: action.channelVolumes,
    };
    return ds;
```

The `ActionMessage` shape and any typed action creator are updated to match.
`currentChannel` (`tvSetCurrentChannel`) is unchanged.

### 2. Write side — `persistGridState` (`TV.tsx:494`)

Map the live runtime ids to slugs via `items` immediately before dispatching, so what
lands in the store is slug-based. An id that no longer resolves to an item (a channel
that dropped out) is dropped from the persisted set. `channelVolumes` is rebuilt from
`gridPlayerVolumesRef.current` mapped through the id→slug lookup. The existing
"volumes ride from a ref, layout/mute changes trigger the effect" arrangement is
preserved. `currentChannel` continues to be published by the existing effect at `:208`.

### 3. Restore side — new one-shot effect in `TV.tsx`

When `items` first becomes non-empty, resolve the persisted slugs to current item ids
and seed the runtime state exactly once:

- `activePlayer` ← id of the item whose `source === currentChannel`
- `selectedPlayers` ← ids of items whose `source` is in `selectedChannels`
- `mutedGridPlayers` ← ids of items whose `source` is in `mutedChannels`
- `gridPlayerVolumes` ← `{ [id]: vol }` for each slug in `channelVolumes` that resolves

Guarded by a `restoredRef` (a `useRef(false)`) so it runs once when items first arrive
and never clobbers later user edits. A slug that does not resolve (a channel disabled
in Settings or absent at the current virtual time) is simply skipped.

For single view, an unresolved `currentChannel` means `activePlayer` is left at its
initial value; the existing re-home effect (`TV.tsx:325-330`) then sets `items[0]`,
delivering the chosen **fall back to first channel** behavior for free.

## Data flow on reload

```
ClassicyState (localStorage)
  → appState.data { currentChannel, selectedChannels, mutedChannels, channelVolumes }
  → restore effect (fires once, when items first populate)
  → runtime id-keyed state (activePlayer, selectedPlayers, mutedGridPlayers, gridPlayerVolumes)
  → video elements
```

## Edge cases

- **Program rollover mid-session:** runtime ids change, but persistence is slug-based,
  so a later reload still resolves. Live playback is unaffected (runtime uses live ids,
  existing behavior).
- **Persisted channel missing at the current virtual time (or disabled in Settings):**
  the slug is skipped on restore and single view falls back to `items[0]` via the
  re-home effect. **Accepted limitation (see below):** this fallback is *destructive*
  for single view — the pre-existing `currentChannel`-publish effect (`TV.tsx:208`)
  then rewrites the stored slug to the fallback channel, so the originally-remembered
  channel is forgotten rather than restored if it later reappears.
- **Race with the re-home effect:** restore seeds `activePlayer` from the slug; the
  re-home effect is the fallback only when the slug does not resolve.

### Accepted limitation — single-view fallback forgets the remembered channel

`currentChannel` serves two roles: the restore source *and* the "where is the TV
actually tuned" signal that the Playlist engine (`PlaylistProvider`) reads for its
locked-focus reconciliation. When the remembered channel is unavailable at reload,
those two roles diverge — the screen shows the fallback while the user "wants" the
absent channel. Rather than split the field (a separate `rememberedChannel` updated
only on explicit user tuning) or suppress the publish (which would feed Playlist a
channel the TV isn't showing), the shipped behavior keeps `currentChannel` = the
actually-displayed channel: reload reliably restores the last channel **when it is
available**, and otherwise falls back to the first channel and forgets the remembered
one. This is a deliberate scope decision, not an oversight. MultiView selection is
unaffected — it is persisted as its own `selectedChannels` slug list.

## Testing

- **`TVContext.test.ts`:** `ClassicyAppTVSetGridState` persists the new slug fields
  (`selectedChannels`, `mutedChannels`, `channelVolumes`) into app data.
- **New restore test (`TV.tsx`):** seed `appState.data` with `currentChannel` +
  `selectedChannels` + `mutedChannels` + `channelVolumes` and a set of mock `items`
  whose ids differ from any previously persisted ids; assert the restore effect
  resolves the slugs to the correct current item ids for `activePlayer` /
  `selectedPlayers` / `mutedGridPlayers` / `gridPlayerVolumes`, and that an unresolved
  single-view slug falls back to `items[0]`.
- **Update `TV.embed.test.tsx` and `TV.reorder.test.tsx`:** they currently inject
  id-based `selectedPlayers` into mock app data and assert id-based `SetGridState`
  payloads; migrate them to the slug-based fields.

## Out of scope

- No change to how the active channel plays, seeks, or reads the virtual clock.
- No change to `channelOrder`, `disabledChannels`, caption state, or volume-limit
  persistence.
- No new wire/streamer traffic — this is purely client-side ClassicyState.
