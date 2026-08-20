# Transcript segment ingest

Populates `chat_transcript_segments` — **tier 2** of the IM Buddies knowledge
stack — by parsing the already-generated channel-level and per-MP3 `.srt`
files into ~30-second segments stamped with absolute 2001 wall-clock times.

Code lives in [`video_grabber/transcript/`](../video_grabber/transcript/):
pure segmenting logic in `segments.py`, Directus I/O in `writer.py`, and the
Prefect flow in `flows.py`. There is no state table and no schedule — this is
a manually-triggered, idempotent backfill over artifacts two other pipelines
already produced.

---

## What it produces, and why

`chat_transcript_segments` is the retrieval corpus the IM Buddies chatbot
grounds its answers in. A single SRT cue is too small a unit to retrieve
against — a search hit lands on a fragment with no surrounding context — and
a whole program transcript is far too large to fit in a prompt. `build_segments()`
(Task 1) groups cues into ~30-second windows, breaking early on a long silence
so two unrelated utterances never get merged under one misleading time range.

This flow (`build-transcript-segments`) is the layer that turns those windows
into rows: it reads the SRT that `build-channel-subtitles` (TV) or
`transcribe-item` (radio) already wrote, segments it, and stamps each segment
with the absolute 2001 timestamp the segment covers. It **regenerates
nothing upstream** — if a channel's SRT is stale or missing, re-run the
subtitle pipeline first; this flow only ever reads `tv_channels.subtitles` /
`mp3_items.subtitles`.

---

## The anchor arithmetic, and how it differs from `build-channel-subtitles`

`build-channel-subtitles` computes an offset *into a channel's stitched
stream*, because that's what HLS playback needs — a program that airs partway
through a channel's assembled window has to land at the right point in that
window's timeline:

```
cue_stream_time = cue_program_time + (air_date − tv_channels.start_date)
```

This flow needs the opposite: not a position in a stream, but an absolute
2001 wall-clock instant. Because it reads the SRT **after** `build-channel-subtitles`
has already stitched it onto the channel timeline, the per-program offset and
the channel-window anchor have already cancelled out — a cue's offset in the
channel SRT is already relative to `tv_channels.start_date`. So the absolute
time is simply:

```
absolute_time = tv_channels.start_date + cue_offset
```

For radio there's no channel stitching step at all — `transcribe-item`
transcribes each MP3 1:1 — so the anchor is just that `mp3_items` row's own
`start_date`:

```
absolute_time = mp3_items.start_date + cue_offset
```

`to_rows()` (Task 1) implements this addition; `flows.py` only ever picks
which anchor to pass it. Radio also has no `tv_channels` row to key off, so
it's identified in `chat_transcript_segments` by a synthetic slug
(`f"mp3:{source['id']}"`) with `channel=None`, rather than a channel id.

**Load-bearing invariant:** the `channel`/`channel_slug` values passed to
`to_rows()` (what gets written) and to `replace_segments()` (what the delete
is scoped by) must be the same values, computed once. If they diverge, the
delete matches nothing and every re-run doubles the data instead of
replacing it — this is why `_ingest_one()` computes `channel`/`slug` a single
time at the top and threads the same variables through both calls.

---

## Delete-then-insert re-run behaviour

Like `build-channel-subtitles` and the usenet group rebuild, this is
regenerate-and-replace, not per-row upsert: `replace_segments()` (Task 2)
deletes every existing row scoped to this source's `medium` + `channel` (or
`channel_slug`), then bulk-inserts the freshly segmented set. The delete runs
even when there are zero rows to insert, so a source whose transcript became
empty doesn't keep stale segments behind.

This makes the flow trivially safe to re-run: re-transcribing a channel and
re-running `build-transcript-segments` for it fully replaces that channel's
segments, never appends to them.

**Per-source failures don't abort the run.** `_ingest_one()` runs inside a
per-source `try/except` in the flow body — a fetch failure, parse failure, or
Directus error for one channel or MP3 is logged and counted in `result["failed"]`,
and the loop moves on to the next source. One unreachable SRT should not cost
re-ingesting the other 22 channels.

**Finding zero sources at all is different from one source failing, and is a
hard failure.** If both `list_subtitled_channels()` and `list_subtitled_mp3_items()`
come back empty for the requested `medium`, the flow raises `RuntimeError`
rather than returning a green, empty result — a stale `subtitles` marker once
produced a fully-transcribed channel with silently missing subtitles while the
run reported success, and this flow refuses to repeat that failure mode.

---

## Manual trigger recipe

There is no schedule and none should be added — the source SRTs are
immutable historical artifacts (already-completed transcriptions of 9/11
broadcasts), so there is nothing to poll for. Trigger a run on demand, from
inside the worker pod or anywhere with `PREFECT_API_URL` set:

```python
from prefect.deployments import run_deployment
run_deployment(name="build-transcript-segments/build-transcript-segments",
               parameters={"medium": "all"})
```

`medium` is `"tv"`, `"radio"`, or `"all"` (default). Run it after any
subtitle backfill — a fresh `build-channel-subtitles` pass, or new radio
transcriptions — to bring `chat_transcript_segments` back in sync.

### Verify

```bash
curl -s -H "Authorization: Bearer $DIRECTUS_API_TOKEN" \
  "$DIRECTUS_URL/items/chat_transcript_segments?aggregate[count]=*&groupBy[]=medium" \
  | python3 -m json.tool
```

---

## Known schema mismatch: `start_date`/`end_date` are `timestamp`, not `dateTime`

**For the next plan, not fixed here — this branch does not own the schema.**

`chat_transcript_segments.start_date` and `.end_date` were created in Directus
as type **`timestamp`**. Every other 2001-time column this package writes —
`tv_channels`, `media_items`, `mp3_items`, `usenet_items` — is type
**`dateTime`**. The two types read back differently:

- `dateTime` columns round-trip as **naive** strings (no offset, no `Z`).
- `timestamp` columns are normalized to UTC and round-trip as **aware**
  strings (`...Z` / `+00:00`).

This module writes `start_date`/`end_date` as naive local-2001-time strings
(`_stamp()` in `segments.py` calls `.isoformat()` on a naive `datetime`)
**deliberately** — that's consistent with every other historical-time column
in this codebase and with `_naive_utc()` in `writer.py`, which exists
specifically to normalize *incoming* Directus timestamps to naive UTC so they
can be subtracted against other naive values without raising
(`TypeError: can't subtract offset-naive and offset-aware datetimes` is a
tested bug class here — see `test_naive_utc_*` in `tests/test_transcript_writer.py`).

The mismatch bites on **read**, not write: because the column is `timestamp`,
Directus will hand back `chat_transcript_segments.start_date`/`end_date` as
**aware** UTC strings even though this code wrote naive ones, while a query
against `news_items` (or any `dateTime` column) in the same composer comes
back **naive**. A consumer that reads both — e.g. the IM Buddies chat
composer this table feeds, which is explicitly a "next plan" concern per this
doc — and mixes them (sorts, subtracts, or compares across sources without
normalizing) will hit exactly the naive/aware `TypeError` this package has
scar tissue for.

**Any future consumer of `chat_transcript_segments` must normalize on read**
(e.g. via something like `writer._naive_utc()`) before comparing against
`dateTime`-typed timestamps from other tables. This doc entry exists so that
normalization isn't rediscovered the hard way.

---

## What this deliberately leaves out

- **No jobs table.** This is a regenerate-from-source backfill, not a
  per-item pipeline needing retry bookkeeping. If per-source failures ever
  need retries, `transcribe_jobs` (`db/migrations/versions/003_transcribe_jobs.py`)
  is the template.
- **No new Directus collection.** `chat_transcript_segments` was applied to
  Directus in Plan A.
- **No schedule.** Nothing here changes on its own; the source SRTs are fixed.
- **No retrieval.** Querying these segments for the chatbot is a separate
  (Plan C) concern.
