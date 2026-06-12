# Channel stitching (continuous per-channel streams)

This feature turns a channel's pile of independently-encoded program HLS
packages into **one continuous, seekable stream** spanning an arbitrary UTC
window (the product timeline is Sep 9 → Sep 18, 2001). Dead air between
programs is filled with a blue "[No Signal]" package so the media timeline is
**isochronous** with wall-clock — one real second is one media second — which
is what lets the TV app seek to any instant with a single subtraction.

It is the assembly tier of video-grabber. The acquisition tier (scan → download
→ encode → upload → Directus, see [pipeline.md](./pipeline.md)) produces the
per-program segment packages on Wasabi; this tier stitches them.

## Why continuous, and why isochronous

The TV app (`packages/frontend/src/Applications/TV/TV.tsx`) lets a viewer set
any moment in the Sep 9–18 window and expects every channel to jump to what was
airing then. That only works cleanly if, for a given channel, there is a single
playlist whose position maps linearly to wall-clock:

```
currentTime = (wallClock − window_start) / 1000     # exact, no per-program math
```

That equation holds **only if gaps are filled**. A real 2-hour gap that
collapses to zero media seconds shifts everything after it earlier by the
cumulative gap duration, so a seek lands in the wrong program. Filling gaps with
real, codec-matched segments keeps media-time == wall-clock-time, making the
subtraction exact across the whole window and every program splice.

> The pre-existing per-program model (one Directus `media_items` row per
> program, seeked by `wallClock − program.start_date`) is what produces the
> "skips around" bug when scrubbing the timeline: any given program is in-bounds
> for only a sliver of the window. Continuous stitching replaces that model.

## The three components

```
programs (PG) ──► scheduler ──► schedule_slots (PG) ──► assembler ──► 4 playlists ─┐
                  (overlap                              (stitch +     + epg_channel │
                   policy)                               PROGRAM-DATE-TIME)         ▼
   gap_filler ──────────────────────────────► hls/<slug>/_gap/  (blue filler)   Wasabi
                                                              playlists/<slug>/*.m3u8 │
                                                              epg/<slug>.json ────────┤
                                                              epg/guide.json          │
                                                            build-channel flow ─────┘──► Directus
                                                                                         (1 row/channel)
```

### 1. Scheduler — `epg/scheduler.py`

`build_schedule(channel_id, window_start, window_end, db) -> int` lays a
channel's `programs` rows onto a clean `schedule_slots` timeline and returns the
count written. It is **idempotent**: it deletes the channel's existing in-window
slots and re-inserts the resolved set, so re-running after more programs
complete just folds them in.

The real decision lives in `resolve_slots(programs, window_start, window_end)`,
which converts raw, possibly-overlapping programs into the contract the
assembler depends on:

- sorted ascending by `starts_at`,
- **non-overlapping** (every `starts_at >= previous ends_at`),
- clamped to `[window_start, window_end)`.

**Overlap policy: first-wins (clip).** Programs are processed in `air_date`
order; whoever claims the air first keeps it, and a later overlapping program
has its start clipped to the running cursor. A clipped remnant shorter than one
segment (`_MIN_SLOT_SECONDS = 6`) is dropped (it becomes gap). Rationale:
`air_date` is *heuristically derived* (see [resolve.py](../video_grabber/pipeline/resolve.py)),
so small overlaps are usually timing error, not a real contest — clipping keeps
as much footage as fits rather than dropping a whole program. Other policies
(longest-wins, skip-on-conflict) are valid; the contract test
(`tests/test_scheduler.py`) verifies the invariants regardless of which is used.

Gaps are **not** materialized as slot rows — the assembler synthesizes them from
the spaces between slots, so the scheduler only writes real program slots.

### 2. Assembler — `epg/assembler.py`

`assemble_range(channel, window_start, window_end, db, *, slots=None) ->
(playlists, epg_channel)` is the core. `assemble_day(channel, day, db)` is a thin
24-hour wrapper kept for the EPG grid.

Returns:

```python
playlists = {"master": "...", "full": "...", "mid": "...", "thumb": "..."}
epg_channel = {"name", "number", "callSign", "location", "icon", "grid": [...]}
```

`epg_channel` matches the `EPGChannel` contract `EPG.tsx` consumes (see
[The EPG guide JSON](#the-epg-guide-json)). The `playlists` map is published as
`playlists/<slug>/<key>.m3u8`.

For each scheduled slot, walking a forward-only `cursor`:

1. If `slot.starts_at > cursor`, emit a gap for the difference.
2. Emit `#EXT-X-DISCONTINUITY` + `#EXT-X-MAP:URI=".../init.mp4"` (fresh init for
   the new content — each program was encoded independently, so PTS/numbering
   reset).
3. Emit `#EXT-X-PROGRAM-DATE-TIME:<slot.starts_at ISO>` — the absolute
   wall-clock anchor (see below).
4. Reference each 6s segment by absolute Wasabi URL, plus a trailing
   `seg{n}.m4s` remainder if `duration % 6 != 0`.

A trailing gap fills from the last slot to `window_end`, then `#EXT-X-ENDLIST`
closes each rendition (`PLAYLIST-TYPE:VOD` — the window is finite and fully
known).

**`#EXT-X-PROGRAM-DATE-TIME` is the linchpin.** Per RFC 8216 §4.3.2.6 it applies
to the first media segment following it and re-anchors the wall-clock mapping.
Because a discontinuity resets PTS, every slot *and* every gap gets its own PDT
stamped with its absolute UTC start. This lets hls.js (and the seek math) map
any instant in the window to an exact offset, even across dozens of splices.

**Segment URL date is per-slot.** Each program's segments live on Wasabi under
*its own* air date (`hls/<slug>/<air_date YYYYMMDD>/<ia_id>/...`, set by the
uploader), so the assembler derives the date prefix from `slot.starts_at`, not
from the window — correct across a multi-day range.

**Published paths are channel-level.** The stitched playlists go to
`playlists/<slug>/{master,full,mid,thumb}.m3u8` (one canonical stream per
channel, regenerated in place), and the gap package is `hls/<slug>/_gap/` (date-
independent — the blue filler is identical regardless of date). The `epg/`
prefix is reserved for the JSON guide, not playlists.

### 3. Gap filler — `video/gap_filler.py`

`generate_gap_fmp4(output_dir, *, remainder_seconds=(1,2,3,4,5)) -> Path`
produces, per rendition (`full`/`mid`/`thumb`) under `output_dir/<rend>/`:

- `init.mp4` — one shared fMP4 init (moov) for the rendition,
- `seg_gap_6s.m4s` — the canonical full-length filler segment,
- `seg_gap_<n>s.m4s` — one remainder segment per `n` in `REMAINDER_SECONDS`.

**The remainder set is small and bounded.** A gap of `G` seconds is composed by
the assembler as `⌊G/6⌋` copies of `seg_gap_6s` plus one `seg_gap_<G%6>s`
remainder. Since `G % 6 ∈ {1,2,3,4,5}`, this handful of segments (~6 KB per
rendition) fills a gap of *any* length.

Encoding details that matter:

- Color `#0000f5`, `libx264 main@3.1`, 29.97 fps, silent stereo AAC — **codec-
  matched to real content** so hls.js level-switches seamlessly across the
  splice. Audio is retained in every rendition (including `thumb`) because
  hls.js refuses to level-switch if any rendition lacks audio.
- Each segment is encoded standalone with `-force_key_frames expr:eq(n,0)` so it
  starts on an IDR and decodes independently — a hard HLS requirement that the
  encoder's `-g 60` default would otherwise violate for sub-2-second segments.
- Segments run ~0.03s long (frame rounding); the playlist declares exact
  `#EXTINF` values and players position by those, so the timeline stays
  isochronous.

### 4. Orchestration — `build-channel` flow

`build_channel_flow(channel_id, window_start, window_end)` in
[`pipeline/flows.py`](../video_grabber/pipeline/flows.py) wires it together
(`window_*` are ISO-8601 UTC strings):

1. `build_schedule(...)` → populate `schedule_slots`.
2. `assemble_range(...)` → build the 4 playlists + the `epg_channel` grid.
3. `generate_gap_fmp4(...)` → `upload_tree(..., "hls/<slug>/_gap")`.
4. `upload_text(...)` each playlist → `playlists/<slug>/<name>.m3u8`.
5. `upload_text(...)` the grid → `epg/<slug>.json`, then `_rebuild_epg_guide(...)`
   re-assembles `epg/guide.json` (see [The EPG guide JSON](#the-epg-guide-json)).
6. `upsert_channel_media_item(...)` → one Directus row per channel.

Every step is idempotent, so the flow is safe to re-run any time more programs
complete. Registered in [`serve.py`](../video_grabber/serve.py) as the
`build-channel` deployment (`_BUILD_CHANNEL_LIMIT = 2`).

Run it (Prefect):

```bash
prefect deployment run 'build-channel/build-channel' \
  -p channel_id=<uuid> \
  -p window_start=2001-09-09T00:00:00+00:00 \
  -p window_end=2001-09-18T00:00:00+00:00
```

## Directus output

`upsert_channel_media_item` ([`directus/writer.py`](../video_grabber/directus/writer.py))
writes/patches exactly **one** `media_items` row per channel, keyed (for
idempotency) on the playlist **`url`** — `https://files.911realtime.org/playlists/<slug>/master.m3u8`,
fixed and unique per channel. It does *not* key on a `content` subfield:
`content` is stored as an opaque JSON string, so `filter[content][channel_stream]`
traverses a non-existent field and Directus returns **403** (only a whole-blob
`filter[content][_eq]` works, as `write_media_item` uses). Fields:
`title`/`full_title` = channel display name, `source` = resolved `sources.id`
for the slug, `start_date` = window start, `format` = `m3u8`, `approved` = 1,
and `content` = `{"channel_stream": <slug>}` (written as a marker, not queried).
Re-runs PATCH the existing row in place.

> This was caught by the first live `build-channel` run — unit tests had mocked
> Directus, and the real instance's permission/schema rejected the subfield
> filter. The same run also caught that `_fetch_slots` must JOIN `programs`
> (the assembler dereferences `slot.program.*`).

## Data model

`schedule_slots` (migration `001`, see [data-model.md](./data-model.md)) is the
interface between scheduler and assembler:

| Column | Notes |
| --- | --- |
| `channel_id` | FK → `channels`. |
| `program_id` | FK → `programs` (the slot's content). |
| `starts_at` / `ends_at` | UTC; the scheduler guarantees non-overlap. |
| `is_gap` | Always `false` here — gaps are synthesized by the assembler, not stored. |
| `segment_url` | Unused by this feature. |

The scheduler reads `programs.air_date` + `programs.duration_seconds` (the
latter is the ffprobe'd true length set at [resolve](../video_grabber/pipeline/resolve.py) time).

## Wasabi layout

```
hls/<slug>/<YYYYMMDD>/<ia_id>/<rend>/{init.mp4,seg0000.m4s,…}   # per-program segments (uploader)
hls/<slug>/_gap/<rend>/{init.mp4,seg_gap_6s.m4s,seg_gap_1s.m4s…} # gap package (build-channel)
playlists/<slug>/{master,full,mid,thumb}.m3u8                   # stitched HLS stream (build-channel)
epg/<slug>.json                                                 # per-channel EPGChannel (build-channel)
epg/guide.json                                                  # combined EPGChannel[] the frontend reads
```

> **Naming:** `playlists/` holds the HLS m3u8s; `epg/` holds the JSON program
> guide. (Earlier the m3u8s lived under `epg/` — confusing, since EPG means the
> *guide*, not the video.)

## The EPG guide JSON

`assemble_range` returns an `epg_channel` dict alongside the playlists; the
`build-channel` flow publishes it so the [EPG frontend](../../../frontend/src/Applications/EPG/EPG.tsx)
can render the TV Guide grid. Two artifacts:

- **`epg/<slug>.json`** — one channel's `EPGChannel`, the source of truth per
  channel, rewritten on every `build-channel` run.
- **`epg/guide.json`** — the combined **`EPGChannel[]`** array the frontend
  consumes. `_rebuild_epg_guide()` lists every `epg/<slug>.json`, parses them,
  sorts by `name`, and writes the array. Rebuilt on every channel build so the
  guide reflects all channels published so far.

The shape matches the `EPGChannel` / `EPGProgram` TypeScript contract in
`EPG.tsx`:

```jsonc
// epg/guide.json — EPGChannel[]
[
  {
    "name": "WETA", "callSign": "WETA", "number": "", "location": "", "icon": "weta",
    "grid": [
      { "title": "Sesame Street", "description": "…", "fullTitle": "WETA_20010911_120000_Sesame_Street",
        "start": "2001-09-11T12:00:00+00:00", "end": "2001-09-11T12:59:54+00:00" },
      { "title": "[No Signal]", "start": "…", "end": "…" }   // gap entries carry only title/start/end
    ]
  }
]
```

Program entries carry `title`, `description`, `fullTitle` (the IA identifier, a
stable click-through key), `start`, `end`; gap entries carry only `title`
(`[No Signal]`), `start`, `end`. `start`/`end` are ISO-8601 UTC; `EPG.tsx`
parses both `Z` and `+00:00` via `Date.parse`.

> **Frontend wiring is the remaining step.** `EPG.tsx` currently *static-imports*
> a baked-in `testdata.json` at build time. To consume the live guide it must
> `fetch` `https://files.911realtime.org/epg/guide.json` at runtime (with a
> loading state) instead — the analogue of the `TV.tsx` cutover. The backend now
> produces the file; the frontend swap is not yet done.

> **Concurrency note:** `_rebuild_epg_guide` is a list-then-write; with the
> `build-channel` concurrency limit of 2, two simultaneous builds could race and
> one guide write could momentarily miss the other's just-written channel. It
> self-heals on the next build. If that ever matters, move the rebuild to a
> dedicated single-concurrency step.

## What's verified vs. open

**Verified:** gap package generates with real ffmpeg and every segment is an
independently-decodable fMP4 with video+audio (ffprobe). 156 unit tests pass
(isochronicity across a 9-day window, PDT-per-discontinuity, per-air-date
prefixes, scheduler contract, gap layout, flow wiring, `_fetch_slots` JOIN,
url-keyed idempotency, EPG guide rebuild). **Live end-to-end run done for WETA**
(Sep 9–18 window, 32 Sep-11 programs seeded from the pre-video-grabber backup):
33 `schedule_slots` written, 4 playlists under `playlists/weta/` + 21 gap objects
uploaded to Wasabi, `epg/weta.json` + `epg/guide.json` (33-program grid) written,
one Directus row upserted. That run surfaced the `_fetch_slots` JOIN and the
Directus url-idempotency fixes.

**Open / not yet done:**

- **Segment-reuse playback is unverified in a real browser.** The assembler
  references one `seg_gap_6s.m4s` repeated N times; individually valid, but
  contiguous reuse in hls.js needs a playback check. If it glitches, the fix is
  localized to the gap layout (e.g. discontinuity-delimited loop).
- **Program segments are not encoded for backup-seeded content.** The WETA test
  used pre-video-grabber backup data, so the playlists reference
  `hls/weta/<date>/<ia>/…` program segments that don't exist on Wasabi (404).
  The playlist structure and gap fill are real; actual program playback needs
  content run through the new download→encode→upload pipeline.
- **Content-gated.** Real (playable) streams wait on the ~5,600-item acquisition
  queue being processed.
- **Frontend cutover pending.** `TV.tsx` still consumes per-program items and
  seeks per-program. To use these continuous streams, `calcSeekSeconds` →
  `(clock − window_start)/1000` and `items` become one-per-channel (drop the
  `jump`/`trim` fudge fields). This is the change that finally removes the
  skipping.

## Testing

| Test file | Exercises |
| --- | --- |
| `tests/test_epg_range.py` | `assemble_range` isochronicity, PDT anchoring, per-air-date prefixes, channel-level paths. |
| `tests/test_epg.py`, `tests/test_epg_json.py` | The `assemble_day` 24h wrapper + EPG grid contract. |
| `tests/test_scheduler.py` | `resolve_slots` invariants (sorted, non-overlapping, clamped). |
| `tests/test_gap_filler.py` | Gap package layout + ffmpeg flags (blue, fmp4, forced keyframe, thumb audio). |
| `tests/test_build_channel.py` | `build_channel_flow` wiring: playlists → `playlists/<slug>/`, EPG JSON → `epg/<slug>.json` + `epg/guide.json` rebuild, Directus upsert. |

Run: `pip install -e ".[dev]" && pytest` from the package root.
