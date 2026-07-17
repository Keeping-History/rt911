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

## Making a stack appear in the app

Register it in
`packages/frontend/src/Applications/HyperCard/extensions/registerHyperCardExtensions.ts`
so it shows up under HyperCard's **File → Open**:

```ts
import userGuideStack from "../../../../docs/hypercard/user-guide.stack.json";

registerHyperCardStack("user-guide", userGuideStack.name, userGuideStack as HCStack);
```

(Or copy the JSON into an `extensions/*.ts` module exporting an `HCStack`,
matching how `tvChannelStack.ts` / `mp3AudioStack.ts` are shipped.)
