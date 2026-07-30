"""LLM condensation of a channel-minute of broadcast transcript.

Two tiers, both of which exist to solve the same measured problem: the purely
mechanical condenser in minutes.py achieves ~90% reduction, but 82 of those
points are blind truncation to the first N characters. Deduplication only
removes ~5% because a minute of broadcast TV is genuinely ~2,000 characters of
*content*, not repetition. Anything that reaches a small budget is therefore
lossy selection — the only question is whether the selection is intelligent.

    TIER_EXTRACT   the model chooses which source sentences to keep, and returns
                   their INDICES. The line is rebuilt from the source text, so
                   the output is verbatim by construction and fabrication is not
                   merely unlikely, it is unrepresentable.

    TIER_ABSTRACT  the model rewrites the minute, and every content word it uses
                   must already appear in the source or the summary is rejected.
                   Compresses harder; the gate is what makes it safe.

Why a gate is needed at all: tier 2 of the chat prompt answers "what could this
person have heard on the air just now?", and the whole three-tier design exists
to keep hindsight out of a buddy's mouth. A model summarising 8:52 coverage
cannot leak *later* events — it is shown only that minute's transcript — but it
does know how September 11 turned out, and left unconstrained it will quietly
resolve the confusion of the moment into the correctness of the afternoon:
"a small plane" becomes "a hijacked airliner". That single substitution would
make a buddy omniscient. Containment turns an unverifiable worry into a
mechanical check.

Pure logic only — prompt construction, parsing and validation. The network call
is injected, so every rule below is unit-testable without an API key.
"""

import json
import re
from dataclasses import dataclass

from video_grabber.transcript.minutes import clean

TIER_EXTRACT = "llm-extract"
TIER_ABSTRACT = "llm-abstract"
TIER_MECHANICAL = "extractive"

# Sentence-ish split. Broadcast ASR punctuates unreliably, so a unit is often a
# clause rather than a sentence; that is fine, units only need to be small
# enough to choose between.
_UNIT = re.compile(r"(?<=[.!?])\s+")

# Function words that carry no claim, so a rewrite may introduce them freely.
#
# Two categories are DELIBERATELY ABSENT, because a model adding either invents a
# fact the broadcast never carried:
#   * quantities — many, much, few, several, two, hundred. "many people were
#     killed" where the station said nothing about numbers is fabrication.
#   * hedges — possibly, potentially, apparently, reportedly. These set how
#     certain the claim is, and certainty is exactly what tier 2 must preserve.
#
# Everything below is syntax: connectives, modals, pronouns and contractions.
_STOPWORDS = frozenset("""
a an and are as at be been being but by for from had has have he her his i if in
into is it its me my no nor not of on or our so than that the their them then
there these they this those to too up us was we were what when where which who
whom why will with you your would could should do does did done just very can
about after again also although always another any back because before both during
each else even ever every here how however himself herself itself myself once only
other out over own same since some such themselves though through under until
while without well may might must don't won't can't isn't wasn't doesn't didn't
haven't hasn't couldn't shouldn't wouldn't i'm we're they're it's that's there's
""".split())

_WORD = re.compile(r"[a-z0-9']+")


@dataclass(frozen=True)
class SummaryResult:
    text: str
    method: str
    rejected: str | None = None  # why the LLM output was refused, if it was


def units_of(texts: list[str]) -> list[str]:
    """Split a minute's segments into indexable units, cleaned and de-duplicated.

    Deduplication here is exact-match only and does little on real ASR (measured:
    ~5%), but it costs nothing and keeps obviously identical repeats out of the
    list the model has to choose between.
    """
    seen: set[str] = set()
    out: list[str] = []
    for text in texts:
        cleaned = clean(text)
        if not cleaned:
            continue
        for unit in _UNIT.split(cleaned):
            unit = unit.strip()
            key = " ".join(_WORD.findall(unit.lower()))
            if not unit or not key or key in seen:
                continue
            seen.add(key)
            out.append(unit)
    return out


def _stem(word: str) -> str:
    """Crude suffix strip so plurals and tenses match across the gate.

    Deliberately not a real stemmer: this only has to make "towers"/"tower" and
    "coming"/"come" compare equal. Over-stemming loosens the gate slightly;
    under-stemming rejects honest summaries. Erring loose is the safe direction,
    because the words still have to come from the source either way.

    The ORDER is load-bearing, and two orderings that look fine both fail:

      strip "es" as a unit -> "planes" becomes "plan" while "plane" stays
      "plane", so the pair stops matching.

      strip verb endings first -> "building" becomes "build" but "buildings"
      only loses its "s" and stays "building", so that pair stops matching too.

    Plural first, then the verb ending, then a trailing "e", so every pair
    converges: buildings -> building -> build, building -> build;
    planes -> plane -> plan, plane -> plan; comes -> come -> com, coming -> com.
    """
    if len(word) > 3 and word.endswith("s"):
        word = word[:-1]
    for suffix in ("ing", "ed"):
        if len(word) > len(suffix) + 2 and word.endswith(suffix):
            word = word[: -len(suffix)]
            break
    if len(word) > 3 and word.endswith("e"):
        word = word[:-1]
    return word


def _variants(word: str) -> set[str]:
    """Every form a word might legitimately match, as a set.

    A single stem cannot express this. Stripping "-ing" leaves a doubled
    consonant ("hitting" -> "hitt"), and collapsing it unconditionally breaks the
    words that genuinely end doubled ("falling" -> "fall" -> "fal", but "fall"
    itself never gets stripped, so the pair stops matching). Emitting BOTH forms
    and asking for any overlap covers "hitting"/"hit" and "falling"/"fall" at
    once. Possessives are stripped first, or "city's" never matches "city" --
    which was 1 of the 19 false rejections in the first sample run.
    """
    if word.endswith("'s"):
        word = word[:-2]
    word = word.strip("'")
    if not word:
        return set()
    stem = _stem(word)
    out = {word, stem}
    if len(stem) > 2 and stem[-1] == stem[-2]:
        out.add(stem[:-1])
    return out


def content_words(text: str) -> set[str]:
    """Union of every variant of every content word — the form to test against."""
    out: set[str] = set()
    for w in _WORD.findall(text.lower()):
        if w not in _STOPWORDS:
            out |= _variants(w)
    return out


def validate_abstract(summary: str, source: str) -> str | None:
    """Return a rejection reason, or None if the summary is contained by the source.

    The rule: every content word the model used must already appear in the
    minute it was given. That does not make the summary *true* — the model can
    still combine source words into a claim nobody made — but it removes the
    failure that actually matters here, which is the model reaching outside the
    minute for what it knows about the day.
    """
    if not summary.strip():
        return "empty"
    allowed = content_words(source)
    # Any overlap between a word's variants and the source's counts as present.
    invented = sorted(
        w for w in _WORD.findall(summary.lower())
        if w not in _STOPWORDS and not (_variants(w) & allowed)
    )
    if invented:
        return f"introduced words absent from source: {', '.join(invented[:6])}"
    if len(summary) > len(source):
        return "longer than the source it summarises"
    return None


def build_extract_messages(units: list[str], *, max_units: int) -> tuple[str, str]:
    system = (
        "You select which lines of a live television or radio transcript to keep. "
        "The transcript is one minute of broadcast audio from September 11 2001, "
        "automatically transcribed, so it is fragmentary, out of order and contains "
        "cross-talk.\n\n"
        "Return the indices of the lines that best convey what this station was "
        "saying this minute. Prefer lines carrying reported information, eyewitness "
        "description or anchor narration. Skip advertising, station identification, "
        "weather and sport unless nothing else is present, and skip lines that "
        "merely repeat one you already chose.\n\n"
        f"Choose at most {max_units} indices. If nothing of substance was said, "
        "return an empty list. Never invent an index."
    )
    listing = "\n".join(f"{i}: {u}" for i, u in enumerate(units))
    user = (
        f"{listing}\n\n"
        'Reply with JSON only, of the form {"keep": [0, 3]}.'
    )
    return system, user


def parse_extract(raw: str, units: list[str], *, max_units: int) -> list[int]:
    """Pull indices out of the reply, discarding anything unusable.

    Every index is bounds-checked against the units actually sent. An
    out-of-range or non-integer index is dropped rather than raising: the caller
    falls back to the mechanical condenser only when nothing survives, so one
    malformed element should not cost the whole minute.
    """
    try:
        blob = raw[raw.index("{"): raw.rindex("}") + 1]
        keep = json.loads(blob).get("keep", [])
    except (ValueError, AttributeError, json.JSONDecodeError):
        return []

    out: list[int] = []
    for item in keep if isinstance(keep, list) else []:
        if isinstance(item, bool) or not isinstance(item, int):
            continue
        if 0 <= item < len(units) and item not in out:
            out.append(item)
    return sorted(out)[:max_units]


def build_abstract_messages(source: str) -> tuple[str, str]:
    system = (
        "You compress one minute of September 11 2001 broadcast transcript into a "
        "single short line describing what this station was saying.\n\n"
        "Absolute constraint: use ONLY words that appear in the transcript you are "
        "given. Do not add context, do not identify or name anything the transcript "
        "does not name, do not resolve confusion or correct errors, and do not draw "
        "on anything you know about that day. If the broadcast is uncertain or "
        "wrong, your line must be equally uncertain or wrong.\n\n"
        "Write plain text, one or two sentences, no preamble. If nothing of "
        "substance was said, reply with nothing at all."
    )
    return system, source


def summarize_minute(
    texts: list[str],
    *,
    tier: str,
    complete,
    max_units: int = 3,
    fallback,
) -> SummaryResult:
    """Condense one channel-minute, falling back to the mechanical condenser.

    `complete(system, user) -> str` is injected so this is testable without a
    network. Any failure -- a transport error, an unparseable reply, a rejected
    abstraction -- degrades to `fallback(texts)` rather than losing the minute:
    a summarised minute that is missing entirely reads to the composer as a
    station that was off the air, which is a different and worse claim than a
    crudely truncated one.
    """
    units = units_of(texts)
    if not units:
        return SummaryResult(text="", method=tier, rejected="no speech in minute")

    source = " ".join(units)

    if tier == TIER_EXTRACT:
        system, user = build_extract_messages(units, max_units=max_units)
        try:
            keep = parse_extract(complete(system, user), units, max_units=max_units)
        except Exception as exc:  # noqa: BLE001 - one bad minute must not stop a run
            return SummaryResult(fallback(texts), TIER_MECHANICAL, f"call failed: {exc}")
        if not keep:
            return SummaryResult(fallback(texts), TIER_MECHANICAL, "no usable indices")
        # Rebuilt from the source list, never from the model's text: this is what
        # makes verbatim output structural rather than something to verify.
        return SummaryResult(" ".join(units[i] for i in keep), TIER_EXTRACT)

    if tier == TIER_ABSTRACT:
        system, user = build_abstract_messages(source)
        try:
            summary = complete(system, user).strip()
        except Exception as exc:  # noqa: BLE001
            reason = f"call failed: {exc}"
        else:
            reason = validate_abstract(summary, source)
            if not reason:
                return SummaryResult(summary, TIER_ABSTRACT)
        # Degrade to tier 1, not straight to the mechanical condenser. A rejected
        # abstraction says nothing about the model's ability to *choose* good
        # lines, and extraction is both safer and measurably better than
        # truncating to the first N characters. Only if that also fails do we
        # fall back to the mechanical line.
        stepped = summarize_minute(
            texts, tier=TIER_EXTRACT, complete=complete, max_units=max_units, fallback=fallback
        )
        return SummaryResult(stepped.text, stepped.method, reason)

    raise ValueError(f"unknown tier {tier!r}")
