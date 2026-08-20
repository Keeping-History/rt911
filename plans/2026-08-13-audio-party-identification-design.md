# Audio transcript linkage + communication-party identification

**Date:** 2026-08-13
**Status:** design approved, implementation plan pending

## Problem

`mp3_items` rows carry no information about who is speaking in each recording. The
ask was "transcribe all the audio and identify who the traffic is between, then
store it on the item". Investigation showed the first half is already done and the
real gaps are elsewhere.

### Actual state of the corpus

| fact | value |
|---|---|
| MP3 objects under `audio/` | 789 (296.4 h, 11.75 GB) |
| already transcribed to `subtitles/audio/<stem>.srt` | 788 |
| `mp3_items` rows | 621 |
| rows with `subtitles` populated | **46** |
| bucket objects with no `mp3_items` row | 168 |

The single untranscribed file is
`audio/faa_atc/zbw/tmu/5 ZBW 179 TMU SVWX 1200-1324 UTC.mp3`.

The `.srt` files that sit *inside* `audio/faa_atc/` and friends are separate source
transcripts, not pipeline output. Pipeline output goes to the `subtitles/` prefix.
Spot-checked pipeline SRTs are byte-identical to a fresh `medium.en` run, so
**no re-transcription is required**.

### Root cause of the 46/621 linkage gap

The 46 populated rows are exactly wins1010 (24) + norad (21) + wcbs (1) — the only
three folders whose filenames contain no spaces.

`video_grabber/directus/writer.py:176` matches with `filter[url][_eq]=mp3_url`.
The caller in `transcribe/flows.py` builds `source_url` as `f"{_WASABI_BASE}/{key}"`
with a **raw** key, while `mp3_items.url` stores the key **percent-encoded**. Every
filename containing a space silently failed to match.

`patch_mp3_subtitles` returns `False` on no-match; `transcribe_item_flow` logs a
warning and still transitions the job to `done`. The pipeline therefore reported
success while writing 7% of its intended output, 575 times.

### Two further findings

- **`transcribe_jobs` is empty (0 rows).** `scan-transcribe` de-duplicates on
  `ON CONFLICT (source_key) DO NOTHING`, so the next run re-enqueues all 789 MP3s
  and every completed TV program, then re-transcribes ~296 h of audio. This is a
  live hazard that blocks every other step.
- **SRT keys are a flat stem**, so 93 basenames repeating across folders collide on
  one path. These 93 turned out to be genuine duplicates
  (`audio/AA11/X.mp3` and `audio/faa_atc/clips/aa11/X.mp3`, identical durations), so
  no SRT is currently wrong. The namespace is still a latent hazard.

## Decisions

| question | decision |
|---|---|
| Long continuous tapes | Two-tier: clips get a full party-pair, tapes get channel-level identification |
| Storage shape | Structured JSON `parties` field on `mp3_items` |
| Row scope | Backfill the 168 uncatalogued objects, then cover all 789 |
| Pipeline defects | Fix in video-grabber *and* backfill existing data |
| Broadcast content | **WINS and WCBS are excluded from speaker identification** |

### Tiering

The corpus is bimodal. 578 files are under five minutes and are discrete clips
where "who is this between" has one clean answer. 211 files are continuous
position tapes carrying 89% of the runtime, up to 6.75 h each
(`DRM1_DAT2_Channel_3_MCC_TK.mp3` is one NEADS position for a whole morning) — a
single party-pair for those is meaningless.

- **clip** — duration < 300 s → one call over the full transcript, full party-pair.
- **tape** — duration ≥ 300 s → fixed position/channel from the filename, confirmed
  against sampled transcript windows; `side_b` is `various` plus a list of
  recurring counterparties.

The threshold reads `mp3_items.calc_duration`. That column is populated for
existing rows but not for the 168 backfilled ones, so Piece 2 must ffprobe each new
object and write `calc_duration` before Piece 3 runs. A null `calc_duration` at
identification time is an error, not a default — silently treating it as a clip
would send a 6.75 h transcript through the clip prompt.

### Broadcast exclusion

WINS (24 files) and WCBS (1 file) are news-radio broadcasts, not two-party
communications. All 25 fall in the tape tier. They are excluded from identification
entirely; their `subtitles` linkage is unaffected.

The exclusion is implemented as an **affirmative allow-list, not a deny-list**: each
folder carries an explicit `media_kind` of `conversation` or `broadcast`, and
identification runs only where `media_kind == "conversation"`. An unrecognised
folder is skipped with a loud warning rather than defaulting to identification.

The map is a module-level constant in `parties/identify.py` keyed on the first path
segment under `audio/`, not an environment variable — it is a property of the
corpus, not of the deployment, and an env var is one more thing that can arrive
empty. Current classification: `broadcast` for `wins1010` and `wcbs`;
`conversation` for `AA11`, `AA77`, `UA93`, `UA175`, `DL1989`, `NEADS`, `norad`,
`Langley`, `QUIT`, `GOFER06`, `ATCSCC`, `FAA`, `ZBW`, `ZDC`, `ZNY`, `ZOB`,
`faa_atc`, `fdny_dispatch`, `rutgers_audiograph`.

This direction is deliberate. A deny-list that fails to load, or a typo'd folder
name, silently re-admits WINS and WCBS; an allow-list that fails to load identifies
nothing and is immediately obvious. Tests must be mutation-checked — inverting or
deleting the filter has to turn a test red.

Identification targets: **764 files** = 578 clips + 186 tapes.

## Design

### Piece 0 — Prerequisite guard (blocking)

Seed `transcribe_jobs` with `stage='done'` and the existing `srt_key` for every
source whose SRT is already in the bucket, before any other step. Restores
`scan-transcribe` idempotency and prevents a 296 h re-transcription.

### Piece 1 — video-grabber pipeline fixes

1. **URL encoding.** One `wasabi_public_url(key)` helper that percent-encodes, used
   everywhere `_WASABI_BASE` is concatenated with a key (`transcribe/flows.py`,
   `directus/writer.py`). Test: a space-bearing key round-trips to the encoded URL.
2. **Make the miss loud.** A `False` from `patch_mp3_subtitles` fails the job with
   the unmatched URL in `error_message` instead of transitioning to `done`.
3. **SRT key mirrors the source path** — `subtitles/audio/AA77/<stem>.srt`. Migration
   is a server-side S3 copy of 1,390 objects; no re-transcription. Flat keys stay
   until `mp3_items.subtitles` is repointed.

### Piece 2 — Catalogue backfill

Create the 168 missing `mp3_items` rows, then link `subtitles` across all 789.

`start_date` derivation is per-folder: clip folders encode local ET in a leading
`HHMMSS`; faa_atc tapes encode a UTC window (`4 ZNY 132 TMU DC 1245-1316 UTC AP`).
This needs a per-folder parser with an explicit fallback, not one regex. Unparseable
names are left null rather than guessed — a single over-broad regex is what caused
the transcript-timeline contamination incident.

### Piece 3 — Party identification

New `video_grabber/parties/` module, following the split `transcript/summarize.py`
already establishes:

- `identify.py` — pure: prompt construction, response parsing, containment
  validation, folder→`media_kind` classification. Unit-testable with no API key.
- `flows.py` — Prefect flow: network calls, Directus writes.

**Containment gate.** The model knows how September 11 turned out. Asked who is
speaking, it will supply "Colin Scoggins" or "NEADS" from background knowledge
rather than from the audio — the same hindsight leak `summarize.py` exists to
prevent. Therefore:

- the response must include an `evidence` quote that is a **verbatim substring** of
  the transcript;
- every facility or person named must appear in the transcript text (normalised).

Failing either check drops the name and forces `confidence` to `low`. Identification
is a reading task, not a recall task.

Model `claude-sonnet-5`, reusing `ANTHROPIC_API_KEY`. The existing
`claude-haiku-4-5` summarize default is too light for this judgment. Estimated
$15–40 for the corpus.

Idempotency: `parties IS NOT NULL` is the completion marker, making the flow
resumable without a new jobs table; a `force` parameter allows re-runs.

### Piece 4 — Directus schema

Add `parties` (json, **cast-json** special — without it the field 400s opaquely) to
`mp3_items`. Check `pg_stat_activity` for a running `pg_dump` before the op; restart
`rt911-api` if introspection wedges.

```json
{
  "tier": "clip",
  "side_a": {"facility": "Indianapolis Center", "position": "Henderson sector", "person": null, "role": "atc"},
  "side_b": {"facility": "American Airlines", "position": "dispatch", "person": "Jim McDonald", "role": "airline"},
  "link": "landline",
  "aircraft": ["AAL77"],
  "confidence": "high",
  "evidence": "This is Indianapolis Center, trying to get a hold of American 77",
  "model": "claude-sonnet-5",
  "generated_at": "2026-08-13T00:00:00Z"
}
```

## Verification

The 39 AA77 clips hand-classified on 2026-08-13 are the regression fixture
(23 tier-A both-ends-identified, 13 tier-B one-end, 3 undeterminable).

- The pipeline must reproduce `side_a`/`side_b` on the 23 tier-A clips.
- It must **not** report high confidence on the 3 undeterminable ones. This is the
  real test of the containment gate.
- A mutation test must confirm that inverting or removing the `media_kind` filter
  turns a test red, and that WINS/WCBS are never identified.

## Out of scope

- Segment-level identification within long tapes.
- Frontend display of `parties`.
- Any re-transcription (the one missing faa_atc SRT is a separate one-file job).

## Order

0. Seed `transcribe_jobs` (blocking guard)
1. Directus `parties` field
2. video-grabber PR: URL encoding, loud failure, SRT path, tests
3. Backfill: 168 rows + link `subtitles` on 789
4. `parties` module validated against the AA77 fixture
5. Corpus run over 764 files
