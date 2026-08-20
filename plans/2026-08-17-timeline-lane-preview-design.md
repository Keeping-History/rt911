# Playlist Editor: sticky lane labels and click-to-preview

Design for two related changes to the Playlist Editor timeline:

1. A media item's text label stays visible at the left of the **viewport** while
   the timeline is scrolled or zoomed, instead of scrolling away with its bar.
2. Clicking a lane expands it to preview the item — a thumbnail strip for TV
   channels, a waveform for radio.

## Why these are one change, not two

`PlaylistTimeline` renders lanes inside a track whose width is `zoom * 100%`
within a horizontally scrolling container. At 16× the track is sixteen viewports
wide, and a lane spans all of it.

Both features therefore need the same thing: content pinned to the *visible*
left edge rather than the track's left edge. That is `position: sticky; left: 0`,
applied to the label and to the preview body. Treating them separately would
produce two mechanisms for one problem.

It also settles what "only as many thumbnails as can fit in the window" means:
the window is the **scroll viewport**, not the lane, because the lane is far
wider than anything visible.

## Current behaviour

The label is rendered inside the bar button, positioned by the bar's
`left`/`width` percentages (`PlaylistTimeline.tsx`, the `bars.map` block). When
the bar's start scrolls out of view, the label goes with it, so a long entry
becomes an unlabelled stripe — worse the further you zoom, which is exactly when
labels matter most.

Selection already exists: bars call `onSelect(b.uid)` and the component tracks
`selectedUid`. The preview hangs off that rather than introducing a second
notion of "the current item".

## Type discrimination

`MEDIA_SECTIONS` in `PlaylistEditorMain.tsx` already classifies entries:

| `key` | Predicate | Preview |
|---|---|---|
| `tv` | `entry.app === "tv"` | thumbnail strip |
| `radio` | `app === "radio"` and in `BROADCAST_STATIONS` | waveform |
| `radio-traffic` | `app === "radio"` and not a broadcast station | waveform |
| `news`, `flights`, non-media | — | no preview; lane does not expand |

Both radio sections get waveforms; the split exists for the media palette, not
for previewing. These predicates move to a shared `mediaSections.ts` so the
timeline and the palette cannot drift into disagreeing about what a TV entry is.

## Data sources

### TV thumbnails — no new work

Thumbnails are addressable by convention, already relied on by
`TV/ThumbnailTile.tsx`:

```
https://files.911realtime.org/thumbnails/<channel-slug>/<30s-bucket-ts>.jpg
```

`thumbnailBuckets.ts` derives the strip as pure arithmetic:

- count = floor(visible viewport width / tile width)
- interval = entry's visible span / count, **snapped to the 30 s bucket grid**
- capped at the number of distinct buckets the span actually contains

The cap is load-bearing. Thumbnails exist only every 30 seconds, so a 2-minute
entry has four distinct images however much room there is. Requesting more would
return duplicates or 404s — `ThumbnailTile` falls back to `offline.jpg`, and a
row of grey placeholders reads as broken rather than as "this is all there is".

"More images as you zoom" is emergent: zooming widens the visible span, so more
distinct buckets become addressable. No separate zoom code path.

### Radio waveforms — new pipeline

`RadioScanner/WaveformVisualizer.tsx` looks like the component for this and is
not: it takes an `HTMLAudioElement` and captures live audio through Web Audio,
rendering what is *playing*. A timeline entry is not playing.

A static waveform needs amplitude peaks from the file. The corpus rules out
computing them in the browser: 576 clips are under 5 minutes, but 179 position
tapes run up to 8h18m, and decoding one of those client-side would download
hundreds of megabytes and freeze the tab.

**A radio entry names a station, not a file.** `MediaEntry.itemId` is a station
slug (`Providers/Playlist/playlistTypes.ts`), so an entry is a station plus a
window, and that window may contain several recordings or none. The preview is
therefore assembled from whatever aired in the window, each recording drawn at
its own time position — the same time-positioned shape as the thumbnail strip.

One consequence for the sticky rule above: the radio preview is **not** sticky.
A thumbnail strip is a summary, so it should stay in view; a waveform laid out
by time is a positioned overlay, and pinning it would slide it out of alignment
with the timeline it describes.

So peaks are precomputed offline and stored on the row:

- **`video_grabber/peaks/extract.py`** — pure. ffprobe for duration, ffmpeg to
  raw PCM, reduce to a **fixed 480 buckets** of min/max amplitude.
- **`mp3_items.peaks`** — new `json` field, declared in
  `apps/rt911/schema/snapshot.json` and applied by the PreSync hook.
- **`compute-peaks`** — Prefect flow, manual-only, `dry_run=True` by default,
  idempotent on `peaks IS NOT NULL`.

A fixed bucket count is deliberate: the stored blob is ~4.1 KB (4 110 bytes of
compact JSON, measured) whether the file is two seconds or 8h18m, and the
renderer always draws 480 values across whatever width it has. Per-file
resolution would make both sides variable for no benefit at preview size.

## Components

```
PlaylistTimeline.tsx      existing — renders <LanePreview> for the selected bar
  LanePreview.tsx         new — dispatches on the bar's `group`
    (TV branch)           sticky thumbnail strip, derived bucket list
    RadioLanePreview      time-positioned waveform slots (NOT sticky)
      PeaksWaveform.tsx   new — draws 480 peaks to a canvas
      usePeaksForSpan.ts  new — recordings overlapping the entry's window
  thumbnailBuckets.ts     new — pure: (span, width, tileWidth) → timestamps[]
  timelineLayout.ts       existing — gains fractionToMs, the inverse of
                          timeToFraction, so a bar's fracs become a time span
```

Type discrimination needs no new module: the bar object already carries
`group: "tv" | "radio" | "flights"`, derived in `timelineLayout.ts` from
`entry.app` — the same source `MEDIA_SECTIONS` reads. Extracting shared
predicates would buy no anti-drift guarantee the bar does not already have.

`PeaksWaveform` deliberately does not extend `WaveformVisualizer`. That
component's substance is Web Audio capture and animation-frame scheduling, none
of which applies to drawing a static array; sharing it would drag an
`AudioContext` into a component that needs none.

`thumbnailBuckets.ts` keeps the arithmetic out of the render path so the
"how many fit, at what interval" rule is testable without mounting anything —
the same split `timelineLayout.ts` already uses for zoom levels.

## Error handling

| Condition | Behaviour |
|---|---|
| Entry has no peaks yet | No waveform; lane does not expand |
| Thumbnail 404s | Existing `offline.jpg` fallback in `ThumbnailTile` |
| Entry is not TV or radio | Lane does not expand at all |
| Span shorter than one bucket | Single thumbnail, not zero |

Nothing here surfaces an error dialog: a preview is an affordance, and a missing
one should be quiet.

## Testing

- `thumbnailBuckets` — pure tests, including the cap (a 2-minute entry yields 4
  buckets regardless of available width) and the sub-bucket span
- `extract.py` — pure tests over synthetic PCM; a silent file yields flat peaks
  rather than raising
- Sticky positioning — asserted on computed style; jsdom does not reproduce real
  scrolling, so a scroll-and-screenshot test would be theatre
- `mediaSections` — the predicates keep classifying the same entries after being
  moved

## Out of scope

Playback from the preview, scrubbing, and waveform interaction. The request is
to *see* the item, not operate it.

## Sequencing

Three PRs, in this order, so the cheap wins land while the expensive one runs:

1. **Sticky labels** — CSS plus a small render change
2. **TV thumbnail strips** — needs no backend work
3. **Peaks pipeline and waveforms** — schema change, new flow, a pass over 814
   files

Steps 1 and 2 are independently useful; step 3 is the only one that touches
another repo.
