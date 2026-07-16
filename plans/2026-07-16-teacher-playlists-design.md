# Teacher Playlists — Design Spec

**Date:** 2026-07-16
**Status:** Approved (brainstorm sign-off, section by section)
**Scope:** `packages/frontend` only. Directus gains one collection. No backend/streamer changes.

## What this is

A "Playlist" is a teacher-authored lesson script that customizes the student's desktop
experience: which media items are available (and when), which apps may open, what gets
focused/opened automatically, and how the virtual timeline jumps. Teachers share a link;
students open it; the desktop follows the script.

An admin/authoring UI is explicitly **out of scope** (planned later). So is auth —
sequencing decision: **playlist first, auth later**. The only contact point is playlist
resolution (see Delivery), designed so an auth layer can later replace "ID in the URL"
with "playlist assigned to my account" without reworking the engine. Backend enforcement
(streamer filters media per playlist) was considered and deferred as a possible future
hardening layer; enforcement in this phase is client-side only, which is acceptable for
the classroom (not adversarial) audience.

## Decisions (from brainstorm)

| Question | Decision |
|---|---|
| Sequencing vs auth | Playlist first; auth is a separate future spec |
| Delivery | Directus by ID via `?playlist=<id>` URL param |
| Time basis | **Virtual clock for everything** (2001 timeline); state is a pure function of clock position |
| Unlisted items | Per-playlist `mode`: `restrict` (whitelist) or `annotate` (overlay) |
| Out-of-window items | Hidden entirely (filtered from the catalog) |
| Focus semantics | Per-item `focus: 'once' \| 'locked'` |
| Browser scheduling | Drive the single existing Browser window; later navigation wins on overlap |
| App settings | Per-entry `locked` flag: boot-time default vs continuously enforced |
| Persistence | **None.** Not in ClassicyStore, not in ClassicyFileSystem, no localStorage. Empty Trash cannot affect it (it only touches the filesystem instance). Refresh re-fetches from Directus. |

## Data model

### Directus

New collection `playlists`, public read (same anonymous-read posture as `flight_positions`):

- `id` (uuid) — the shareable token in the URL
- `title` (string)
- `status` (standard Directus status field; only `published` is loadable)
- `definition` (json — **must be created with the `cast-json` special**, else reads 400)

One JSON document rather than normalized child collections: the future admin UI writes
one field, the frontend fetches one row, no relational modeling.

### Definition schema (TypeScript, discriminated union on `kind`)

```ts
type PlaylistDefinition = {
    version: 1
    mode: 'restrict' | 'annotate'
    entries: PlaylistEntry[]
}

type PlaylistEntry =
    | {  // media availability window
        kind: 'media'
        app: 'tv' | 'radio' | 'news' | 'flights'
        itemId: string            // channel source slug / station slug / news doc id / flight callsign
        start?: string            // virtual-clock UTC ISO; omitted = available from the beginning
        end?: string              //                        omitted = available until the end
        focus?: 'once' | 'locked' // behavior when the window opens; absent = no focus
      }
    | {  // app gating — session-long (windowed disabling deliberately deferred, YAGNI)
        kind: 'app'
        appId: string             // e.g. 'TimeMachine.app'
        disabled: true
      }
    | {  // app settings override
        kind: 'settings'
        appId: string
        values: Record<string, unknown>  // keys merged into apps[appId].data
        locked?: boolean                 // default false = boot seed only
      }
    | {  // scheduled filesystem open
        kind: 'file'
        path: string              // ClassicyFileSystem path, e.g. 'Documents:Newspapers:WTC1.pdf'
        at: string
      }
    | {  // timeline jump
        kind: 'jump'
        at: string                // when the clock crosses this…
        to: string                // …set it to this
      }
    | {  // scheduled browser navigation
        kind: 'browser'
        url: string
        at: string
        closeAt?: string
      }
```

Conventions:

- **All times are UTC ISO strings on the virtual timeline** (same convention as the
  stream wire format; display tz offset is applied elsewhere — never store `localDate`).
- `itemId` uses each app's natural stable key (TV already resolves channels by `source`
  slug; flights by callsign; news by document id; radio by station slug).
- **Forward compatibility:** validators ignore entries with unknown `kind` silently and
  bump `version` only on semantic changes. Known future extensions (explicitly out of
  scope now): `{ kind: 'command', appId, command, at }` for arbitrary app-specific
  scheduled commands (e.g. RadioScanner's focus-one-item), and windowed app disabling.

## Architecture

**One non-persisted `PlaylistProvider`** mounted in `app.tsx` as a sibling of
`MediaStreamProvider`, wrapping the desktop. Runtime state lives in React context plus a
module singleton — never the ClassicyStore/filesystem, so Empty Trash and store resets
cannot touch it.

### Boot & loading

- `app.tsx` reads `?playlist=<id>` at startup (same pattern as the `?ipod` override in
  `Mobile/detectMobile.ts`).
- Fetch `/items/playlists/<id>` from `VITE_DIRECTUS_URL` (default
  `https://api-beta.911realtime.org`). Single request; if the loader ever grows more
  requests they MUST be sequential (api-beta concurrent-fetch body-mixing bug).
- Validate the definition: malformed entries dropped with `console.warn`; unknown kinds
  ignored; structurally invalid document = load failure.

### Engine core — `playlistEngine.ts` (pure, no React)

```
evaluate(definition, virtualUtcMs) → RulesSnapshot
  // { isItemAvailable(app, itemId), disabledApps: Set<string>,
  //   lockedFocus: Map<app, itemId>, lockedSettings: Map<appId, values>,
  //   browserShouldBe: { open: true, url } | { open: false } }

collectCrossings(definition, prevMs, currMs) → TriggerEvent[]
  // jump / file-open / browser-open / browser-close / focus-once events
  // whose `at` satisfies prevMs < at ≤ currMs
```

`evaluate` answers "what should the world look like right now" — idempotent, safe to
recompute anytime, and the reason refresh/late-join/replay all work: playlist state is a
pure function of clock position. `collectCrossings` covers the things that are inherently
events. The only session history the engine carries is a single `prevMs` number.

### Trigger semantics

1. Triggers fire when the clock **ticks** across their `at` moving forward.
2. A playlist **jump does not retro-fire** triggers in the skipped region; after landing,
   only triggers ahead of the new position are pending.
3. A **manual seek** (Time Machine, if enabled) likewise fires nothing it skips; seeking
   backward behind a trigger **re-arms** it. Rule of thumb: *only natural ticking fires
   events.* This prevents seek-trap loops.
4. Corollary: a **backward** `jump` (where `to` < `at`) re-arms itself and fires again
   when the clock re-crosses `at` — an intentional, documented way to loop a segment.
   The validator warns on backward jumps so accidental infinite loops are visible.

### Provider tick loop

Subscribe to the virtual clock at 1 s resolution; keep a `prevMs` ref; distinguish
tick from seek with the same ~90 s threshold heuristic `MediaStreamProvider` uses
(`SEEK_THRESHOLD_MS`); on ticks run `collectCrossings` and dispatch resulting actions;
diff successive `evaluate()` snapshots for state-like enforcement (locked focus, locked
settings, browser desired state). Clock math uses `virtualUtcMs(localDate, tzOffset)` —
never raw `localDate`.

## Enforcement seams

### 1. Catalog gating (media windows + restrict mode)

Applied inside `MediaStreamProvider` at the existing reveal/retention tick
(`MediaStreamProvider.tsx` `drainDue`/`partitionByDue` area): items pass through
`isItemAvailable(app, itemId)` before publication, and the `sources` option lists
(`sources.video`, `sources.audio`, …) get the same filter so TV/Radio pickers never show
unavailable entries. `restrict` mode: unlisted items fail the predicate. `annotate` mode:
only items with a matching `media` entry are window-constrained.

Scope of `restrict`: it applies to the four catalogs `media` entries can address
(tv, radio, news, flights). Other stream channels (pager, usenet, weather) are not
item-filterable in v1 — a teacher who wants them gone disables those apps with
`kind: 'app'` entries. The provider's
per-second tick re-applies the predicate so windows open/close within ~1 s of their
boundary even when no new items arrive. Hidden means hidden — no per-app disabled-state
UI exists or is needed.

### 2. App gating

The provider registers plugin handlers via classicy's `registerAppEventHandler` for
**both** open paths:

- `ClassicyAppOpen` prefix — runs before the core app reducer; allowed → delegate to
  normal `openApp`; blocked → set the system error dialog via the
  `ClassicyDesktopShowErrorDialog` action with message **"You don't have permission to
  open this app."** and swallow the action.
- `ClassicyDesktopIconOpen` prefix — desktop-icon double-clicks bypass `ClassicyAppOpen`
  and call `openApp` directly, so this path gets the same veto.

If a disabled app is `open: true` in stale persisted desktop state
(`classicyDesktopState`), the provider force-closes it once at boot.

### 3. Focus / lock commands

Replicate TV's one-shot `seq`-command pattern (`TVContext.ts` — monotonic `seq`, command
written to `apps["X.app"].data.command`, consumed exactly once, retry-until-item-exists)
into `RadioScannerContext`, `News`, `FlightTracker`, and `Browser` (a `navigate`
command). Each participating app also **publishes its current selection** into its store
`data` (Radio already does via `activeStation`) so locked mode can reconcile.

- `focus: 'once'` — at window start (a crossing event): open the owning app **through the
  gated open path** and dispatch the tune/focus command.
- `focus: 'locked'` — same, plus: while the window is active, if the app's published
  selection diverges from the target, re-dispatch the command.
- Validation: a focus or settings entry targeting a disabled app is skipped with a
  warning — disable wins.

### 4. Browser scheduling & file opens

- `browser` entries: `at` crossing → open Browser app + dispatch navigate command;
  `closeAt` crossing → quit the app (existing `quitAppHelper` path). Overlaps: the later
  navigation wins (single persistent Browser window; multi-window was considered and
  rejected as a separate sub-project).
- `file` entries: `at` crossing → dispatch `ClassicyAppFinderOpenFile` for the resolved
  path; the existing handler routes by file type (PDF → PDF Viewer) exactly as a
  double-click would; a bad path surfaces the normal Finder error dialog.

### 5. Clock jumps

`jump` entries dispatch the same `ClassicyManagerDateTimeSet` action Time Machine uses,
via the shared `TimeMachine/setVirtualClock.ts` helper. **This amends the repo rule
"only TimeMachine mutates the clock" to "TimeMachine and the playlist engine, both via
the same helper"** — update `packages/frontend/CLAUDE.md` accordingly in the same PR.
Downstream, `MediaStreamProvider` sees the jump as a seek (> 90 s) and performs its
normal buffer-clear + re-window; no new machinery. Jumps outside the clock's
min/max bounds are clamped by the existing boundary logic.

### 6. App settings

- Unlocked: at boot, **after store hydration**, merge `values` into `apps[appId].data`
  (overrides both app defaults and the student's persisted state, so every student starts
  identically). Students may change afterward.
- Locked: additionally subscribe to the store and revert diverging keys while the
  playlist is active.
- Mechanism: the playlist plugin registers its own action prefix with a generic
  "merge these keys into this app's `data`" handler — no per-app set-state actions.
- Caveat (acceptance criterion per setting): only settings the app reads reactively from
  the store take live effect; apps that copy store → local state once at mount won't
  reflect a locked revert until reopened. Settings shipped in playlists must be verified
  store-reactive.

## Error handling

| Failure | Behavior |
|---|---|
| Fetch fails / unknown ID / invalid document | System error dialog "This playlist could not be loaded." then boot **unrestricted** (fail-open — classroom, not adversarial; loud so the teacher notices) |
| Malformed individual entry | Dropped at validation with `console.warn`; rest of playlist runs |
| Unknown `kind` | Ignored silently (forward compatibility) |
| Focus target not yet in stream | Command consumer retries until the item appears (TV's existing behavior, kept in the replicas) |
| Focus/settings on a disabled app | Entry skipped with warning; disable wins |
| Jump beyond clock min/max | Clamped by existing boundary logic |

## Testing

- **Engine (bulk of coverage):** table-driven vitest specs for the pure functions —
  `evaluate()` at boundary times (start−1s, start, end, end+1s), `collectCrossings()`
  across tick/jump/seek/rewind-rearm scenarios, restrict vs annotate, validation.
- **Provider:** mocked clock ticks → assert dispatched actions (veto, tune commands,
  error dialog, settings merge/revert), seek-vs-tick threshold, locked reconciliation.
  New test files need `afterEach(cleanup)` (no RTL auto-cleanup in this repo).
- **Command consumers:** per-app tests in the existing style; TV's command tests are the
  template.
- **E2E (Playwright):** one happy-path spec — boot with `?playlist=` against a fixture,
  assert a disabled app shows the permission dialog and a windowed channel
  appears/disappears across a jump. Assert against behavior/store, not menu UI
  (known Classicy menu-click flakiness).
