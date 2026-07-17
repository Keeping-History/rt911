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
- `extensions/DirectusVideoPart.tsx` — the `directusVideo` part: embeds one TV
  channel stream from `tv_channels`, optionally limited to a start/end segment,
  using classicy's `QuickTimeVideoEmbed` (HLS) for controls/autoplay/captions.
  Exports the reusable `DirectusVideo` body.
- `extensions/DirectusMultiviewPart.tsx` — the `directusMultiview` part: a grid
  ("video wall") of `DirectusVideo` tiles with solo/mute/all audio modes.
- `extensions/DirectusNewsPart.tsx` — the `directusNews` part: one article from
  `news_items` (headline, dateline, image, HTML body).
- `extensions/DirectusPagerPart.tsx` — the `directusPager` part: one instant
  message from `pager_items`, styled as a pager readout.
- `extensions/useDirectusItem.ts` — shared id-resolution + fetch/load-state hook
  used by the news/pager parts.
- `extensions/HyperCardClockBridge.tsx` + `extensions/dateRange.ts` — the
  `setDateTime` *action*: a command queues an effect, the mounted bridge applies
  it through the sanctioned `setDateTimeFromUtc` seam, clamped to the canonical
  date range (`dateRange.ts`).
- `extensions/videoOptions.ts` / `extensions/videoSegment.ts` — the video option
  shape, and the pure start/end bound resolver (offset seconds, `M:SS`, or a
  date-bearing wall-clock mapped via the channel `start_date`).
- `extensions/mp3AudioStack.ts` / `extensions/tvChannelStack.ts` — the built-in
  **Audio Clips** and **TV Channels** stacks that demonstrate the parts.
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

## Authoring a TV video embed

```jsonc
{
  "id": "tv",
  "type": "directusVideo",
  "rect": [12, 40, 416, 232],
  "options": {
    "channelId": 3,          // a row in tv_channels (or a direct HLS "url")
    "start": 60, "end": 180, // stream-offset seconds, "M:SS", or a
                             // date-bearing wall-clock ("2001-09-11T12:46:00")
    "controls": true,        // native transport (default true); false = chromeless
    "autoPlay": true,        // muted defaults to true when autoplaying
    "loop": true,            // loop the [start, end] segment
    "captions": true,        // captions on by default; the CC control still toggles
    "muted": false, "volume": 0.8,
    "poster": "https://…/frame.jpg",
    "overlay": true          // channel-name + running-time bug
  }
}
```

Segment bounds resolve to a stream offset in seconds: a number or `M:SS` is an
offset; a value carrying a calendar date is a 9/11 wall-clock instant mapped via
the channel's `start_date`. A non-looping segment that reaches its `end` fires
the part's own `script` (e.g. `go next`), so clips can chain.

### Multiview (video wall)

```jsonc
{
  "id": "wall",
  "type": "directusMultiview",
  "rect": [12, 40, 416, 232],
  "options": {
    "audio": "solo",         // "solo" (tap a tile to hear it) | "mute" | "all"
    "columns": 2,            // omit for an automatic grid
    "videos": [
      { "channelId": 1, "autoPlay": true },
      { "channelId": 2, "autoPlay": true },
      { "channelId": 3, "start": "2001-09-11T12:46:00", "autoPlay": true }
    ]
  }
}
```

Each tile takes the full `directusVideo` option set.

## Authoring news / pager embeds

```jsonc
{ "id": "story", "type": "directusNews",  "rect": [12, 12, 396, 232], "options": { "itemId": 42 } }
{ "id": "page",  "type": "directusPager", "rect": [12, 40, 396, 150], "options": { "itemId": 128 } }
```

Both take an `itemId` (a `news_items` / `pager_items` row, resolved through the
stack expression engine). News accepts `showImage`/`showDate`; pager accepts
`showMeta`.

## The `setDateTime` action

Seeks the desktop's virtual clock — every app follows.

```jsonc
{ "do": "setDateTime", "to": "2001-09-11T12:46:00" }   // a UTC datetime literal
{ "do": "setDateTime", "toVar": "moment" }              // read it from a variable
```

The requested instant is clamped into the canonical range (`dateRange.ts`,
`2001-09-09`…`2001-09-12` today) and applied through the sanctioned
`setDateTimeFromUtc` seam; a stack cannot fight the streamer's forced clock
(`dateTimeLocked`). The action is a *command* that queues an effect; the effect
is applied by `HyperCardClockBridge`, mounted once in `Desktop.tsx`. Because the
`do` name isn't in classicy's typed `HCAction` union (plugin commands are
untyped-JSON by design), a typed stack literal casts it — see `newsPagerStack.ts`.

## Adding another collection (images, PDFs, …)

1. Add an entry to `DIRECTUS_COLLECTIONS` with the collection name and the
   fields the embed needs.
2. Write a `Directus<Kind>Part.tsx` following `DirectusAudioPart.tsx` — read
   `options`, fetch by id, render.
3. Register its `type` in `registerHyperCardExtensions.ts`, and (optionally) add
   a demo stack.
