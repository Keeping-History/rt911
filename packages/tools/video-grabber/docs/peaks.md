# Amplitude envelopes (`compute-peaks`)

Populates `mp3_items.peaks`: a fixed-size amplitude envelope for every audio
recording, so the Playlist Editor's timeline can draw a static waveform for a
radio entry without downloading the audio.

One Prefect flow, `compute-peaks`, manual-only and `dry_run=True` by default —
like `identify-parties`, it writes to the live catalogue, so nothing schedules
it.

Code lives in [`video_grabber/peaks/`](../video_grabber/peaks/): `extract.py`
(pure, no I/O) and `flows.py` (download, decode, guard, write). There is **no
state table** — `peaks IS NOT NULL` is the idempotency marker, which is why a
row that fails is left NULL and picked up by the next run. For the product
rationale (why offline, why not sticky, why a station window can hold several
recordings) see
[`plans/2026-08-17-timeline-lane-preview-design.md`](../../../../plans/2026-08-17-timeline-lane-preview-design.md).

---

## The shape: 480 buckets, always

`peaks_from_pcm` reduces the whole recording to **480 `[min, max]` pairs**,
each scaled to `-128..127`, whatever its duration.

- **Fixed count, not fixed resolution.** The corpus runs from 2-second clips to
  an 8h18m (29 880 s) position tape. Per-file resolution would make both the
  stored blob and the renderer variable for no visible benefit at preview size,
  where the slot is a few pixels to a few hundred wide. At 480 pairs the blob is
  ~4.1 KB of compact JSON (4 110 bytes measured) regardless.
- **Byte-range scaling.** `>>` 8 in Python floors toward negative infinity, so
  `-32768 >> 8 == -128` and `32767 >> 8 == 127` — the full signed-16-bit range
  maps onto `-128..127` with no branch for negatives.
- **8 kHz mono decode.** Plenty for a preview envelope, and it holds the largest
  tape's PCM buffer to ~478 MB rather than ~5.3 GB at 44.1 kHz stereo.
- **`array("h")`, not `struct.unpack`.** Unpacking would box ~239M samples as
  Python ints. `array` keeps them as packed machine shorts and still slices.
  Built from a `memoryview` slice so the source `bytes` is not copied twice.
  Honest peak RSS on the largest tape is ~956 MB (source buffer + array), well
  inside the worker's 8Gi limit.

## A partial decode is a failure, not an envelope

**This is the non-obvious part of the flow.** `check=True` on the ffmpeg call
only catches a non-zero exit, and ffmpeg routinely **exits 0 on a truncated or
damaged MP3** after emitting a short PCM prefix. Nothing downstream would
notice: `peaks_from_pcm` stretches that prefix across all 480 buckets, and the
frontend draws those 480 buckets across the row's full `calc_duration` extent —
a waveform misaligned from the audio it claims to depict, stored as a success.
A zero-length decode is worse still: 480 `[0, 0]` pairs are indistinguishable
from a genuinely silent recording.

Because `should_compute` treats any non-null `peaks` as done, neither is ever
repaired by a normal re-run — only a `force=True` pass over the whole corpus
would. So the check happens **before** the write:

| Case | Outcome |
|---|---|
| Decoded length within tolerance of `calc_duration` | Written. |
| Decoded length diverges beyond tolerance | `PartialDecodeError` → counted **failed**, `peaks` left NULL, next run retries. |
| Zero-length decode | `PartialDecodeError`, regardless of `calc_duration`. |
| `calc_duration` absent or non-positive | Accepted **unverified** (the zero-length rule still applies). |

Tolerance is `max(1.5 s, 1 % of calc_duration)`. The floor covers
`calc_duration` being whole seconds — `catalogue/flows.py:probe_duration` is
`int(float(...))`, a truncation, so the stored value sits up to 1 s low before
codec padding adds tens of ms. The 1 % term covers ffprobe estimating a
duration from bitrate rather than a frame count, the one error that scales with
length (~5 minutes of slack on the 8h18m tape). The bias is deliberate: a false
rejection costs one recomputed row on the next run, a false acceptance is
permanent.

One blind spot worth knowing: if a file was already truncated when
`probe_duration` ran, `calc_duration` describes the truncated file and matches
the short decode. The guard catches damage that postdates the catalogue entry
and headers whose frame count outlives the payload — not a file that has been
short since ingest.

`timeout=_FFMPEG_TIMEOUT_S` (20 minutes) covers the other direction: a stalled
decode would otherwise sit forever with nothing raised. `TimeoutExpired` is an
`Exception`, so the per-row handler counts it failed and the run continues.

## Operating it

```bash
# dry run over a handful, printing bucket counts and writing nothing
prefect deployment run compute-peaks/compute-peaks -p limit=5

# apply, filling in every row whose peaks are still NULL
prefect deployment run compute-peaks/compute-peaks -p dry_run=false

# recompute everything (only needed if the bucket count or scaling changes)
prefect deployment run compute-peaks/compute-peaks -p dry_run=false -p force=true
```

The run logs `N computed, N skipped, N failed`. **`failed` is the number to
watch** — those rows have no envelope and will be retried next run; grep the
logs for `compute-peaks: <key> failed:` to see whether it was a download, a
decode, or a `PartialDecodeError`.

Row order comes from `_page_mp3_items`, which sorts by `id` for the reason
documented there: this flow updates the rows it walks, and LIMIT/OFFSET without
an ORDER BY reshuffles the pages underneath it.

## The consumer

`packages/frontend/src/Applications/PlaylistEditor/usePeaksForSpan.ts` reads
`peaks` anonymously alongside `id`, `start_date` and `calc_duration`, and
`PeaksWaveform.tsx` draws the 480 pairs to a canvas. Two constraints that
travel back to this pipeline:

- **`peaks` is a Directus `json` field**, which in Directus 12 accepts only
  `_null` / `_nnull` filters. The frontend cannot filter on envelope contents,
  so a row with no envelope is simply dropped client-side.
- **`(source, start_date)` is not unique** — 20 collision groups in the corpus,
  17 with differing durations. The row `id` is the only unique identity a
  recording has, which is why the frontend keys its slots on it.
