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
- `extensions/DirectusVideoPart.tsx` — the `directusVideo` part: embeds one or
  more TV channel streams from `tv_channels` (a grid when `channelId` holds
  more than one id), each optionally limited to a start/end segment, using
  classicy's `QuickTimeVideoEmbed` (HLS) for controls/autoplay/captions.
  Exports the reusable `DirectusVideo` body.
- `extensions/DirectusMultiviewPart.tsx` — the `directusMultiview` part: a grid
  ("video wall") of `DirectusVideo` tiles with solo/mute/all audio modes.
- `extensions/DirectusNewsPart.tsx` — the `directusNews` part: one or more
  articles from `news_items` (headline, dateline, image, HTML body), stacked
  vertically when `itemId` holds more than one id.
- `extensions/DirectusPagerPart.tsx` — the `directusPager` part: one or more
  instant messages from `pager_items`, styled as pager readouts, stacked
  vertically when `itemId` holds more than one id.
- `extensions/useDirectusItem.ts` — shared id-resolution + fetch/load-state hook
  used by the news/pager parts; `resolveItemIds` is the array-aware id
  resolution the video/weather/flight-map parts also use.
- `extensions/DirectusWeatherPart.tsx` — the `directusWeatherStation` part: one
  or more stations' live conditions/forecast/almanac (a grid when `station`
  holds more than one id), reusing the Weather app's `WeatherStationPanel`
  (extracted from `Weather.tsx`).
- `extensions/DirectusFlightMapPart.tsx` — the `directusFlightMap` part: one or
  more live plane maps reusing the Flight Tracker's `FlightMap`
  (maplibre/WebGL) — a grid, one map per focused callsign, when `flight` holds
  more than one.
- `extensions/HyperCardPartGrid.tsx` — the shared "video wall" grid layout the
  video/weather/flight-map parts above lay their multiple tiles out in;
  generalizes `DirectusMultiviewPart.tsx`'s own grid, which predates it.
- `extensions/editorMetadata.ts` — registers each part's `optionsSchema` (what
  the stack editor's inspector shows) and, for every id/array field, a
  `picker`-kind field bound to a concrete `registerHyperCardOptionPicker`
  component.
- `extensions/HyperCardItemPicker.tsx` — the shared searchable/filterable,
  checkbox-multi-select picker window every concrete picker
  (`TVClipPicker.tsx`, `TVMultiviewPicker.tsx`, `NewsItemPicker.tsx`,
  `PagerMessagePicker.tsx`, `WeatherStationPicker.tsx`, `FlightMapPicker.tsx`,
  and audio's pre-existing `RadioTrafficClipPicker.tsx`) opens from its
  inspector field, plus the `HyperCardOptionPickerField` shell those six share.
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
    "channelId": [3],        // row(s) in tv_channels (or a direct HLS "url");
                             // the inspector's TV Channels picker always
                             // writes an array — two or more ids lay out as a
                             // grid, sharing every other option below
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

Each tile takes the full `directusVideo` option set. The inspector's Videos
picker (`TVMultiviewPicker.tsx`) manages each tile's `channelId`, preserving
whatever other settings (`start`/`autoPlay`/…) are already on a kept tile
rather than resetting them.

## Authoring news / pager embeds

```jsonc
{ "id": "story", "type": "directusNews",  "rect": [12, 12, 396, 232], "options": { "itemId": [42] } }
{ "id": "page",  "type": "directusPager", "rect": [12, 40, 396, 150], "options": { "itemId": [128] } }
```

Both take an `itemId` array (each entry a `news_items` / `pager_items` row,
resolved through the stack expression engine) — the inspector's News
Items/Pager Messages pickers always write an array, and two or more ids
render as a scrollable vertical list rather than a single article/readout.
News accepts `showImage`/`showDate`; pager accepts `showMeta`.

## Authoring weather / flight embeds

```jsonc
{ "id": "wx",  "type": "directusWeatherStation", "rect": [12, 40, 396, 210], "options": { "station": ["KJFK"] } }
{ "id": "map", "type": "directusFlightMap",      "rect": [12, 44, 396, 206], "options": { "notablesOnly": true, "flight": ["AA11"], "mapStyle": "radar" } }
```

Both read the shared virtual clock and the streamed flight/weather channels via
`MediaStreamContext` (ref-counted `subscribe*`), so they stay in lockstep with
the desktop. The weather station reuses `Weather/WeatherStationPanel`; the flight
map reuses `FlightTracker/FlightMap` and **requires WebGL + a sized card**.
`station`/`flight` are arrays (the inspector's Weather Stations/Flights pickers
always write one, filtered to whatever's *currently* live on the shared
channel rather than the full historical list) whose entries resolve through
the stack expression engine (variable-driven selection); two or more ids lay
out as a grid, one panel/map per id. Flight options: `notablesOnly`, `flight`
(focus callsign(s), one map per focused flight when there's more than one),
`mapStyle`/`darkMap`/`radarSweep`/`trailMultiplier`, pin-color overrides.

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
