# Party identification and tagging

Populates `mp3_items.parties` (who a recording's traffic is between, and what it
is about) and `mp3_items.tags` (a flat, namespaced index for searching).

One Prefect flow, `identify-parties`, manual-only and `dry_run=True` by default.

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

## Operating it

```sh
# dry run over a handful, printing what would be written
identify-parties  limit=5  dry_run=true

# apply, refreshing anything not already on the current schema
identify-parties  dry_run=false

# rebuild everything from scratch
identify-parties  dry_run=false  force=true
```

WINS and WCBS are excluded by an **affirmative allow-list** (`MEDIA_KIND`), never
a deny-list: a deny-list that fails to load silently re-admits news radio and
produces confident nonsense about a broadcast that has no counterparty.

`PARTIES_MAX_TOKENS` is 5000 and the headroom is deliberate — `max_tokens` caps
thinking and text together, and a budget consumed entirely by thinking returns an
empty string with no error. See the comment on the constant.
