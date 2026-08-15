"""The 9/11 Commission's own index of these recordings, as a lookup table.

Our audio corpus came from three Internet Archive collections
(`NARA_FOIA_36411_FAA_RECORDS_Aug_19_2011`, `NARA_911_Commission_RG148_Audio_Monograph`,
`RDOD_NEADS_AUDIO`) whose filenames are a six-digit timestamp and a terse slug —
`093800 Gofer 06 Aircraft is Down`. The Commission staff who catalogued the same
tapes wrote fuller titles, and Team 8's audio monograph (`team 8a audio monograph
28.doc`) walks 76 of them in narrative prose naming the controllers, positions and
facilities on each call. That is authority our transcripts do not carry, and it is
what `commission_clips.json` holds.

`commission_clips.json` was built from two IA items and is checked in rather than
fetched, because the sources are a 3.6 MB Word 97 binary and a plain-text master
file that need bespoke parsing (Word piece tables) to read at all:

  - `NARA_911_Commission_RG148_Audio_Monograph/Master File 051704.txt`  — 111 clips,
    titles stamped in **UTC**.
  - `NARA_911_Commission_RG148_Audio_Monograph/team 8a audio monograph 28.doc` —
    76 clips hyperlinked from Master File 061604, titles stamped in **ET**, each
    with the surrounding monograph narrative.

The two stampings are why our corpus contains the same recording twice under
`08xxxx` and `12xxxx` names — see the timezone correction in issue #379.

Matching is deliberately conservative. A six-digit timestamp is not unique (two
unrelated calls share `093800`), so a candidate must agree on the slug as well:
`MIN_SLUG_OVERLAP` of our filename's words must appear in the Commission title.
The rejects are the point — `093800 d1989 turn right 31` and `093800 Gofer 06
Aircraft is Down` are the same second of the same morning and different tapes.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

INDEX_PATH = Path(__file__).with_name("commission_clips.json")

# Below this, the timestamp is doing all the work and the slug is contradicting it.
MIN_SLUG_OVERLAP = 0.5

_LEADING_STAMP = re.compile(r"^(\d{6})\b")
_WORD = re.compile(r"[a-z0-9]+")

# Flight numbers appear in every other title and match everything; "(canonical)" is
# our own rename marker from the timezone fix, not part of anyone's title.
_STOPWORDS = frozenset({"aa11", "aa77", "ua175", "ua93", "wav", "mp3", "canonical"})


@dataclass(frozen=True)
class CommissionClip:
    """One catalogued recording, as the Commission described it."""

    stamp: str
    title: str
    source: str
    context: str | None
    overlap: float

    @property
    def text(self) -> str:
        """Everything the Commission says about this clip, as one blob.

        This is what a monograph-sourced field is validated against, so it must
        contain the title too: the title is where the callsigns and facility names
        usually live, and the narrative is where the people do.
        """
        return self.title if not self.context else f"{self.title}\n\n{self.context}"


@lru_cache(maxsize=1)
def load_clip_index() -> dict[str, dict]:
    """The shipped index, keyed by six-digit stamp. Cached — it never changes."""
    return json.loads(INDEX_PATH.read_text())


def _tokens(text: str) -> set[str]:
    return {w for w in _WORD.findall(text.lower())} - _STOPWORDS


def slug_overlap(our_stem: str, their_title: str) -> float:
    """Fraction of our filename's words that the Commission title also uses.

    Asymmetric on purpose: their titles are longer and more descriptive, so
    scoring against theirs would penalise exactly the good matches. What we need
    to know is whether *our* name is accounted for.
    """
    ours = _tokens(our_stem)
    theirs = _tokens(their_title)
    if not ours or not theirs:
        return 0.0
    return len(ours & theirs) / len(ours)


def match_commission_clip(key: str) -> CommissionClip | None:
    """Find the Commission's entry for one of our object keys, or None.

    Returns None for a file with no leading timestamp, no catalogued clip at that
    timestamp, or a clip whose title disagrees with ours.
    """
    stem = Path(key).stem
    m = _LEADING_STAMP.match(stem)
    if not m:
        return None
    stamp = m.group(1)
    entry = load_clip_index().get(stamp)
    if not entry:
        return None
    # Compare the slug only — the stamp already matched, and leaving it in would
    # award every candidate a free point.
    overlap = slug_overlap(stem[len(stamp):], entry["title"][len(stamp):])
    if overlap < MIN_SLUG_OVERLAP:
        return None
    return CommissionClip(
        stamp=stamp,
        title=entry["title"],
        source=entry["source"],
        context=entry.get("context"),
        overlap=round(overlap, 2),
    )
