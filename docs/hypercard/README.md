# HyperCard stacks

Portable HyperCard stack documents authored against the schema in classicy's
`HyperCardModel.ts` (`HCStack`). Stacks are pure JSON — no code, no fetching —
and render live data only through the registered extension parts documented in
`packages/frontend/src/Applications/HyperCard/README.md`. Stack files ship in
`packages/frontend/public/stacks/` so the desktop's virtual file system can
reference them by URL.

## Getting Started (the user-guide stack)

Lives at `packages/frontend/public/stacks/getting-started.stack.json`, served
by the frontend at `/stacks/getting-started.stack.json` and surfaced on the
desktop as **Macintosh HD → Getting Started.stack** (see the
`ClassicyFileSystemEntryFileType.Stack` entry in
`src/data/DefaultFileSystem.ts`). Double-clicking it in the Finder routes to
HyperCard, which fetches, validates (`validateStack`), and opens it.

It is the [USER-README](../../USER-README.md) user guide as an interactive tour:
a welcome card, desktop/clock basics, the quick-start journey, a reference-times
card, one card per application, and closing tips. Each app card carries an
**Open <App>** button (`openApp` action with the real Classicy app id), and the
TV card embeds a live channel via the shipped `directusVideo` part
(`channelId: 3`, same row the built-in TV Channels demo stack uses).

It deliberately uses only parts/actions that have shipped: built-in part types
plus `directusVideo`. (The `directusNews`/`directusPager` parts and the
`setDateTime` command are still branch-only; the reference-times card opens
Time Machine rather than jumping the clock directly. Swap in `setDateTime`
buttons once that PR lands.)

## The Oregon Trail (an example game stack)

Lives at `packages/frontend/public/stacks/oregon-trail.stack.json`, served at
`/stacks/oregon-trail.stack.json` and mounted on the desktop as **Macintosh HD →
The Oregon Trail.stack**. It re-creates the classic Apple II / MECC educational
game entirely in the HyperCard JSON stack language — no code, no fetching, only
the built-in part types (`label`, `field`, `button`) and declarative actions.

It exercises the full breadth of the stack engine: stack-global `variables`
(money, food, health, oxen, miles, …), the `put`/`add`/`subtract`/`multiply`
container arithmetic, `if`/`then`/`else` branching over the expression language,
`answer` dialogs for encounters, `beep`, `visual` transitions, and named-card
`go` navigation. An outfitting **store** does live budget math; each trail card
recomputes an on-screen status bar from the variables via a background
`onOpenCard` handler; river crossings, breakdowns and mountain cold resolve
deterministically from the party's own supplies and the departure month; and the
journey ends on a scored **arrive** card or a **died** card. Because the engine
is deterministic (its expression evaluator has no randomness), outcomes fall out
of the player's choices — the game is a solvable resource-management puzzle, and
its balance is verifiable by walking the cards.

## Making a stack appear in the app

Two routes:

1. **As a file on the virtual disk** (how Getting Started ships): put the
   JSON in `packages/frontend/public/stacks/`, then add a
   `ClassicyFileSystemEntryFileType.Stack` entry to
   `src/data/DefaultFileSystem.ts` whose `_url` points at the served path.
   Double-clicking the file routes to HyperCard, which fetches and validates
   it (classicy ≥0.42, `handlesFileTypes` routing).

2. **In HyperCard's File → Open menu**: register an `HCStack` object in
   `packages/frontend/src/Applications/HyperCard/extensions/registerHyperCardExtensions.ts`
   via `registerHyperCardStack(id, name, stack)`, matching how
   `tvChannelStack.ts` / `mp3AudioStack.ts` are shipped (stacks under `src/`
   as TS modules; `public/` assets can't be imported at build time).
