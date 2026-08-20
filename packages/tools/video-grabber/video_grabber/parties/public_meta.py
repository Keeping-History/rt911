"""Project the private `parties` blob onto the public columns. Pure, no I/O.

`mp3_items.parties` is not readable by an anonymous Directus client and must
stay that way: it carries the QA signals that say how far to trust a row —
which values the containment gate threw out, and which model produced the rest.
Those are working notes about our own pipeline, not facts about the recording.

Everything the Radio Traffic card shows is nevertheless in that blob, so a
redacted copy of it is materialised into public columns, and this function is
the only place that copy is made. Nothing downstream re-checks it: the Go and
TypeScript types are built without fields for the redacted values, so a leak
here is published rather than caught.

**The projection is closed, not filtered.** A deny-list only knows about the
fields that existed when it was written, and this blob is written by two
producers — `validate_parties` returns the model's cleaned answer, and
`identify_parties_flow` then stamps `model`, `generated_at`, `commission` and
`gate_reasons` onto it. Anything either of them gains next would be published
by default under a copy-and-remove. So every field, including the two nested
blocks, is enumerated, and a key nobody has written yet is dropped for the same
reason as one we know about.

`REDACTED` is not used as a filter — a closed projection has nothing to filter.
It names what must never leave the pipeline, so the tests can assert it against
the whole serialised output.
"""
from __future__ import annotations

REDACTED = {"gate_reasons", "model"}   # internal QA signals — never leave the pipeline

# Copied straight across: the recording's own account of itself.
PUBLIC_FIELDS = ("subject", "link", "tier", "confidence", "evidence")

# A stored participant also carries `source`, the per-field provenance label the
# gate resolved it against. That is an internal working note, so the entry is
# rebuilt from these five rather than copied and trimmed.
PARTICIPANT_FIELDS = ("person", "facility", "position", "role", "confidence")

MENTION_KINDS = ("facilities", "aircraft", "people")

# `parties.sources` is keyed by field path and holds paths for fields the public
# columns do not carry (`aircraft`, and whatever a later schema adds). A
# provenance entry for a value nobody can see says where something came from
# without saying what it was, so only the paths that are actually published are.
PUBLIC_SOURCE_PATHS = (
    "subject", "evidence", "mentions.facilities", "mentions.aircraft", "mentions.people",
)

# `commission` also carries `slug_overlap`, the score of the filename match that
# found the clip. That is how confident the *matcher* was, which is a pipeline
# diagnostic and not a fact about the recording.
COMMISSION_FIELDS = ("title", "source", "stamp")


def _as_dict(value: object) -> dict:
    """`value` if it is a mapping, else an empty one.

    This runs unattended over the whole corpus off rows the database hands back,
    so a block of the wrong JSON type has to read as absent rather than end the
    pass. Same argument as `identify._member`.
    """
    return value if isinstance(value, dict) else {}


def build_public_meta(parties: dict | None) -> dict:
    """The public columns implied by one stored `parties` blob.

    Always the same set of keys. 59 of the 814 recordings have no `parties` at
    all — broadcasts, and rows the gate could not identify — and they still need
    every column written: the card has to be able to say "nothing is known"
    definitely, and a re-derivation has to be able to clear a projection the
    blob no longer supports.
    """
    parties = _as_dict(parties)
    mentions = _as_dict(parties.get("mentions"))

    return {
        **{field: parties.get(field) for field in PUBLIC_FIELDS},
        "participants": [
            {field: entry.get(field) for field in PARTICIPANT_FIELDS}
            for entry in parties.get("participants") or []
            if isinstance(entry, dict)
        ],
        "mentions": {
            kind: list(mentions.get(kind) or []) for kind in MENTION_KINDS
        },
        "provenance": _build_provenance(parties),
    }


def _build_provenance(parties: dict) -> dict:
    """Where the published values came from, enumerated path by path."""
    sources = _as_dict(parties.get("sources"))
    commission = _as_dict(parties.get("commission"))
    return {
        "generated_at": parties.get("generated_at"),
        "sources": {
            path: sources[path] for path in PUBLIC_SOURCE_PATHS if path in sources
        },
        # None rather than an empty object: the 9/11 Commission catalogued only
        # some of these recordings, and "they did not" is worth saying plainly.
        "commission": (
            {field: commission.get(field) for field in COMMISSION_FIELDS}
            if commission else None
        ),
    }
