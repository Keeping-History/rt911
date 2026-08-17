# Party identification and tagging

Populates `mp3_items.parties` (who a recording's traffic is between, and what it
is about) and the `mp3_tags` / `mp3_items_tags` many-to-many (a namespaced index
for searching).

Two Prefect flows, both manual-only and `dry_run=True` by default:
`identify-parties` (calls the model) and `rebuild-tags` (re-derives tags from
stored `parties`, no inference).

## The containment gate is the whole design

The model knows how September 11 turned out. Asked who is speaking on a garbled
tape, it will supply "NEADS" or "Colin Scoggins" from background knowledge rather
than from the audio. So identification is built as a **reading** task, not a
recall task:

- every name the model returns must already appear in a document it was shown;
- `evidence` must be a verbatim quote;
- `subject` must be written in words that appear in the source (the same rule
  `transcript/summarize.py` applies to minute summaries);
- anything unsupported is **removed**, and the removal is recorded in
  `gate_reasons`.

This is why so many blobs are sparse, and that is correct behaviour rather than a
bug. A clip whose entire transcript is *"American 77, climb and maintain, flight
level 3-5-0."* never says Indianapolis, so `facility: null` is the right answer.

### Two admissible documents

Where the 9/11 Commission catalogued the same recording (see
[`parties/commission.py`](../video_grabber/parties/commission.py)), their title and
Team 8 monograph narrative go into the prompt alongside the transcript. The gate
is **parameterised, not relaxed**: each value declares which document it came
from and is validated against that one. Two rules stop provenance becoming
decorative —

- an **undeclared** source is held to the transcript, so silence cannot reach the
  looser document;
- an **unrecognised** source name is rejected outright rather than trusted.

The stored `sources` map is rebuilt from what survived, so it always describes
the values that are actually there.

## Schema 2

`parties.schema_version` is the idempotency marker; a re-run refreshes rows on an
older shape and skips current ones.

| Field | Notes |
|---|---|
| `participants[]` | One entry per party, however many. Each carries its own `role`, `confidence` and `source`. |
| `mentions` | Facilities/aircraft/people **talked about** but not taking part. |
| `aircraft[]` | Callsigns of aircraft on the call. |
| `subject` | One line, in the source's own words. |
| `topics[]` | From the closed list in [`vocab.py`](../video_grabber/parties/vocab.py). |
| `link` | `air-ground`, `landline`, `internal`, `conference`, `unknown`. |
| `evidence` | Verbatim quote. |
| `sources` | Path → document, for the flat fields. Participants carry theirs inline. |
| `confidence` | Overall; capped at `medium` if the gate rejected anything. |
| `commission` | Present when a Commission clip was matched. |

Two things schema 2 fixed, both measured on the schema-1 corpus:

- **`side_a`/`side_b` could not describe the material.** 179 of 755 rows were
  position tapes reduced to the placeholder `side_b.facility = "various"`, and
  conference calls (ATCSCC, the NEADS floor, FAA HQ) are inherently n-party.
  `"various"` is now rejected rather than stored.
- **A single rejection crushed the whole answer to `low`.** 546 rows read `low`,
  but only 189 had been downgraded by the gate — the other 357 were the model's
  own verdict. Per-participant confidence keeps those distinguishable.

## Tags

`build_tags()` is a pure function of the parties block. Tags are **derived, never
separately generated** — asking the model for both would produce two accounts of
one recording that quietly disagree. Only `topic:` has no equivalent in the block.

Namespaced (`facility:zob`, not `zob`) because a bare list cannot be filtered by
kind and names collide across kinds — Boston is a facility and also a surname.

```
tier:clip  link:landline  role:atc  agency:faa  agency:norad
facility:indianapolis-center  facility:neads
person:jim-mcdonald  aircraft:aal77  topic:loss-of-contact
```

Participating and merely-mentioned entities both get tagged: someone searching
for Cleveland Center wants the calls that discuss it, not only the ones it spoke
on. The parties block keeps the distinction.

Callsigns are normalised so `American 11`, `AAL11` and `AA 11` collapse to
`aircraft:aal11`. Military callsigns keep their own prefix (`gofer6`) — the goal
is collapsing spellings, not forcing everything into an airline scheme.
Facilities resolve the same way through `vocab.FACILITY_ALIASES`, so `Boston`,
`Boston Center` and `ZBW` are one tag.

### How tags are stored

A many-to-many, the same three-part shape `readme_articles` uses:

| Collection | Rows | What it holds |
|---|---|---|
| `mp3_tags` | ~1,100 | The vocabulary: `tag`, `namespace`, `value`, `color`, `sort`. `tag` is unique. |
| `mp3_items_tags` | ~8,200 | The junction: `mp3_items_id`, `mp3_tags_id`. |
| `mp3_items.tags` | — | An **alias** (`list-m2m`) over the junction. |

`mp3_items.tags` was previously a json array of strings, and before that the
junction itself carried the tag text on every row — 8,192 rows repeating 1,131
distinct tags, with the parent's `start_date` copied onto each. The text is now
stored once and referenced.

Two consequences worth knowing before touching the writer:

- **You cannot set tags by PATCHing the item.** `tags` is an alias, not a
  column; `PATCH /items/mp3_items/{id} {"tags": [...]}` does not do what it did
  when `tags` was json. Persistence goes through `tag_store.py`.
- **Time filtering goes through `mp3_items.start_date`.** The junction no longer
  carries a copy, because it was identical to the parent's value on all 8,192
  rows and the index belongs on the item.

Vocabulary rows are created but never deleted. A retracted tag loses its
junction rows and vanishes from every search, but the row is cheap and may be
referenced again — and deleting it would discard any `color`/`sort` a curator
set on it.

### Curated tags

Derived tags are **rebuilt from scratch on every run**. Hand-added tags go in
**`tags_curated`**, a json column on the item that the flow reads and never
writes, and merges into the derived set.

Two places rather than one, because the obvious single-store merge is wrong:
folding each new derived set into whatever was already there would let derived
tags only ever accumulate. A facility the model stops identifying — or one the
gate starts rejecting — would linger in the index forever with nothing able to
retract it, so re-running would entrench old mistakes instead of correcting them.
Rebuilding wholesale keeps derivation authoritative for itself; keeping human
input in its own column keeps it safe from that rebuild.

Curated values are stored verbatim — not slugged, not namespaced — since a
curator may need vocabulary this module has never heard of. `split_tag()`
therefore has to cope with an un-namespaced tag, and records it as
`namespace = NULL`.

### Re-deriving without inference

Tags are a pure function of `parties` plus `tags_curated`, so changing
`tags.py` or `vocab.py` — a new facility alias, a topic added to the
vocabulary, a callsign that normalises differently — makes every stored tag
stale without making a single `parties` block wrong.

The **`rebuild-tags`** flow re-derives the whole corpus from stored `parties`.
It reads no transcripts and calls no model, so correcting derivation costs
nothing but the writes. `identify-parties` is only needed when the *parties*
themselves must change.

## Operating it

```sh
# dry run over a handful, printing what would be written
identify-parties  limit=5  dry_run=true

# apply, refreshing anything not already on the current schema
identify-parties  dry_run=false

# rebuild everything from scratch
identify-parties  dry_run=false  force=true
```

Radio broadcasts are excluded by an **affirmative allow-list** (`MEDIA_KIND`),
never a deny-list: a deny-list that fails to load silently re-admits news radio
and produces confident nonsense about a broadcast that has no counterparty.
That covers `wins1010`, `wcbs`, and `radio` — the last standing for every AM/FM
station under `audio/radio/`, since `media_kind` keys on the first segment below
`audio/` rather than the station.

**List a folder even when the answer is "skip it."** An unlisted folder is also
skipped, so a deliberate exclusion and an unexamined one behave identically and
report nothing. 31 station recordings sat outside the pipeline unnoticed for
exactly that reason — they never appeared in a failure count because they were
never counted at all.

`PARTIES_MAX_TOKENS` is 5000 and the headroom is deliberate — `max_tokens` caps
thinking and text together, and a budget consumed entirely by thinking returns an
empty string with no error. See the comment on the constant.
