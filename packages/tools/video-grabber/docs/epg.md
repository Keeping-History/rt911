# EPG assembler

The EPG (Electronic Program Guide) assembler builds the artifacts that the frontend consumes: a 24-hour HLS master playlist per channel per day, three rendition playlists, and a JSON document describing the schedule grid. Implementation: [`video_grabber/epg/assembler.py`](../video_grabber/epg/assembler.py).

## What it produces

For one call to `assemble_day(channel, day, db)`:

```python
playlists, epg_channel = assemble_day(channel, day, db)
# playlists = {
#   "master": "#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-STREAM-INF:...\n...",
#   "full":   "#EXTM3U\n#EXT-X-VERSION:7\n...",
#   "mid":    "...",
#   "thumb":  "...",
# }
# epg_channel = {
#   "name": "CNN",
#   "number": "",
#   "callSign": "CNN",
#   "location": "",
#   "icon": "cnn",
#   "grid": [{"title": "...", "start": "...", "end": "..."}, ...],
# }
```

The `epg_channel` shape matches the `EPGChannel[]` contract that `EPG.tsx` in the frontend expects. The `playlists` map is keyed by the names the upload step writes as `<key>.m3u8` files in `epg/<channel-slug>/<YYYYMMDD>/`.

## The 24-hour stitch

For each programmed slot in `schedule_slots` for the day:

1. If there's time between the previous cursor and `slot.starts_at` → emit a gap (see below).
2. Emit a `#EXT-X-DISCONTINUITY` plus a new `#EXT-X-MAP:URI=…/init.mp4` for the slot's rendition.
3. Reference each 6-second segment of the slot's HLS package by absolute URL on Wasabi: `https://files.911realtime.org/hls/<slug>/<yyyymmdd>/<ia_id>/<rend>/seg0000.m4s`.
4. If `slot.duration % 6 != 0`, emit one shorter trailing segment to absorb the remainder.

After the last slot, if `cursor < window_end`, a trailing gap fills to midnight UTC. Finally, `#EXT-X-ENDLIST` closes each rendition.

## Gap playlists

Gaps use the same fMP4/CMAF format as content (see [`gap_filler.py`](../video_grabber/video/gap_filler.py)). Each rendition references its own gap init segment:

```
#EXT-X-DISCONTINUITY
#EXT-X-MAP:URI="https://files.911realtime.org/hls/cnn/20010911/_gap/full/init.mp4"
#EXTINF:6,
https://files.911realtime.org/hls/cnn/20010911/_gap/full/seg_gap_6s.m4s
…
```

`_append_gap()` ([`assembler.py:113-123`](../video_grabber/epg/assembler.py)) cuts the gap into N × 6s segments and one trailing remainder segment (`seg_gap_<remainder>s.m4s`). The set of gap segment durations the assembler can produce is bounded — typically `seg_gap_6s.m4s`, `seg_gap_1s.m4s` through `seg_gap_5s.m4s`, etc. The gap-filler step needs to have generated each of these once and uploaded them to `_gap/<rend>/`. Otherwise the playlist references a 404 and hls.js stalls.

## Why every slot boundary has `#EXT-X-DISCONTINUITY`

The slots come from different IA items, each encoded independently with its own CMAF init segment, frame numbering, and timestamps. Without a discontinuity tag, hls.js tries to splice them with continuous timestamps and the player drifts / freezes at every boundary. The tag tells the player to reset its timeline at the next segment, and the fresh `#EXT-X-MAP` gives it the right init for the new content.

## Master playlist

Trivial — three `EXT-X-STREAM-INF` entries referencing the three per-rendition playlists by absolute URL. Bandwidth and resolution values match `RENDITIONS` in the encoder ([`video/encoder.py:12-37`](../video_grabber/video/encoder.py)) and are duplicated as `REND_BANDWIDTHS`/`REND_RESOLUTIONS` constants in `assembler.py`. **If you change a rendition's bitrate in the encoder, update these constants too** — there is no shared source of truth.

## EPG JSON grid

Real content slot:

```json
{
  "title": "ABC News Coverage of 9/11",
  "description": "Continuous coverage…",
  "fullTitle": "abc-news-9-11-2001-am",
  "start": "2001-09-11T12:30:00+00:00",
  "end":   "2001-09-11T14:00:00+00:00"
}
```

Gap slot:

```json
{
  "title": "[No Signal]",
  "start": "...",
  "end":   "..."
}
```

`fullTitle` is the IA identifier — the frontend uses it as a stable key for clicking through to source metadata. `description` is only present on content slots; the frontend renders an empty description block for gaps.

## What the assembler does **not** do

- It does not upload the playlists. The caller is expected to write `playlists[*]` to `epg/<slug>/<yyyymmdd>/<*>.m3u8` on Wasabi.
- It does not generate gap segments. Those come from `gap_filler.py` and must be uploaded to `_gap/<rend>/` before any day-playlist that references them is served.
- It does not re-fetch from IA or re-validate URLs. It trusts the URL convention.
- It does not write to `schedule_slots`. Slot insertion is a manual step today (or done by a future scheduler flow that does not yet exist).

## Testing

`tests/test_epg.py` and `tests/test_epg_json.py` exercise the assembler with mock slot lists. The unit tests pass an explicit `slots=[...]` so the DB query path is bypassed; integration coverage of `_fetch_slots()` is light.
