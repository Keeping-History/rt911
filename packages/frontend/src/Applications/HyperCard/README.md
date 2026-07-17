# HyperCard extensions

The **HyperCard app itself ships with `classicy`** and is auto-mounted by
`ClassicyDesktop` (it can only be turned off via the
`ClassicyDefaultAppsContext` `disableHyperCard` flag). Per the frontend
`CLAUDE.md`, this repo never re-implements a bundled system app — it only
supplies **configuration and content**. This folder is that content for
HyperCard: extension *parts* that embed items from Directus collections into
cards, and the built-in *stacks* that use them.

A HyperCard stack is portable JSON and cannot fetch. classicy's plugin API
(`registerHyperCardPart` / `registerHyperCardCommand` /
`registerHyperCardStack`) is the seam that lets a card render live data: a
registered part component does the fetching at render time and paints the
result into its authored `rect`.

## What's here

- `extensions/directusCollections.ts` — the shared Directus read seam. One
  anonymous REST GET per embedded item (same direct-Directus pattern as
  `README/useReadmeArticles.ts`, bypassing the streamer). `DIRECTUS_COLLECTIONS`
  is the registry of embeddable collections + the fields each needs.
- `extensions/DirectusAudioPart.tsx` — the `directusAudio` part: embeds one
  clip from the `mp3_items` collection (by `itemId`, or a direct `url`).
- `extensions/mp3AudioStack.ts` — the built-in **Audio Clips** stack that
  demonstrates the part.
- `extensions/registerHyperCardExtensions.ts` — registers the parts and stacks
  with classicy. Run once for its side effect via `index.ts`, imported from
  `Desktop.tsx` above the desktop.

## Authoring an audio embed in a stack

```jsonc
{
  "id": "clip",
  "type": "directusAudio",
  "rect": [16, 52, 388, 96],
  "options": { "itemId": 42 }        // a row in mp3_items
  // or: { "url": "https://files.911realtime.org/…/clip.mp3", "title": "…" }
}
```

`itemId` is passed through the stack expression engine, so it may reference a
variable/field (`"options": { "itemId": "clip" }` tracks the `clip` variable).

## Adding another collection (video, images, PDFs, …)

1. Add an entry to `DIRECTUS_COLLECTIONS` with the collection name and the
   fields the embed needs.
2. Write a `Directus<Kind>Part.tsx` following `DirectusAudioPart.tsx` — read
   `options`, fetch by id, render.
3. Register its `type` in `registerHyperCardExtensions.ts`, and (optionally) add
   a demo stack.
