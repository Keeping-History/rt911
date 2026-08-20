"""Condense transcript segments into one line per channel per minute.

Pure logic, no I/O and no Prefect, exactly like segments.py — the condensation
rules are the whole point of this module, so they are unit-testable in isolation.

Why this exists: tier 2 of the chat prompt ("what you have just heard on TV") is
by far the largest thing in a buddy's prompt. A ten-minute lookback across the
national and international sources is hundreds of raw ASR segments — half
sentences, anchor cross-talk, and the same phrase transcribed three times as the
stitched audio overlaps — which forced the composer to spend most of its budget
there and then trim whole minutes of coverage to fit. One condensed line per
channel per minute says the same thing in a fraction of the tokens.

The condensation is deliberately **extractive**: it selects, dedupes and truncates
the words that were actually broadcast, and never rewrites them. An abstractive
summary (an LLM pass) would read better and compress harder, but tier 2's entire
job is to be what a person could actually have heard on the air that minute. A
model paraphrasing 9/11 coverage will smooth early confusion into later
correctness — "a small plane" becomes "a hijacked airliner" — which is precisely
the hindsight the three-tier design exists to keep out of a buddy's mouth. It also
cannot hallucinate a detail nobody said, because it only ever deletes.
"""

import re
from dataclasses import dataclass
from datetime import datetime, timedelta

from video_grabber.transcript.segments import Segment

# Non-speech annotations whisper emits. These carry no information for a buddy
# and are pure prompt overhead.
_ANNOTATION = re.compile(r"[\[(](?:[^\])]{0,40})[\])]")

# Teleprompter/caption speaker markers common in broadcast captioning.
_SPEAKER_MARK = re.compile(r"(?:^|\s)>>+\s*")

# Standalone filler. Only ever dropped as a whole token, never inside a word.
_FILLER = frozenset({"uh", "um", "uhh", "umm", "er", "erm", "hmm", "mm", "mhm"})

# Sentence-ish split. Broadcast ASR punctuates unreliably, so this also breaks on
# a run of whitespace after a comma — enough to make deduplication work on
# repeated fragments that never got a full stop.
_SENTENCE = re.compile(r"(?<=[.!?])\s+")


@dataclass(frozen=True)
class MinuteSummary:
    minute: datetime
    text: str
    segment_count: int


def clean(text: str) -> str:
    """Strip annotations, speaker marks and standalone filler from one segment."""
    text = _ANNOTATION.sub(" ", text)
    text = _SPEAKER_MARK.sub(" ", text)
    words = [w for w in text.split() if w.strip(".,!?-").lower() not in _FILLER]
    return " ".join(words).strip()


def _key(unit: str) -> str:
    """Normalized form used only for equality when deduplicating."""
    return re.sub(r"[^a-z0-9 ]+", "", unit.lower()).strip()


def condense(texts: list[str], *, max_chars: int = 240) -> str:
    """Join a minute's segments into one line, dropping repeats, then truncate.

    Deduplication is per sentence-ish unit rather than per segment. The stitched
    channel audio overlaps, so consecutive segments routinely share a clause
    while differing overall — deduping whole segments would keep every repeat,
    and deduping words would shred the sentences. Order of first appearance is
    preserved, which keeps the minute reading forward the way it aired.
    """
    seen: set[str] = set()
    kept: list[str] = []
    for text in texts:
        cleaned = clean(text)
        if not cleaned:
            continue
        for unit in _SENTENCE.split(cleaned):
            unit = unit.strip()
            if not unit:
                continue
            k = _key(unit)
            # Drop empties after normalization (a unit of pure punctuation) as
            # well as ones already said this minute.
            if not k or k in seen:
                continue
            seen.add(k)
            kept.append(unit)

    line = " ".join(kept)
    if len(line) <= max_chars:
        return line
    # Cut at the last word boundary inside the cap so the line never ends
    # mid-word, which reads as a transcription error rather than a truncation.
    cut = line[:max_chars]
    if " " in cut:
        cut = cut[: cut.rindex(" ")]
    return cut.rstrip(" ,;:-") + "…"


def build_minutes(
    segments: list[Segment],
    anchor: datetime,
    *,
    max_chars: int = 240,
) -> list[MinuteSummary]:
    """Group segments into whole virtual minutes and condense each one.

    A segment is filed under the minute it *starts* in. Segments run to about
    thirty seconds and can straddle a boundary, and attributing one to both
    minutes would let a buddy hear the same sentence twice — once as "just now"
    and again a minute later.
    """
    if anchor.tzinfo is not None:
        raise ValueError(f"anchor must be a naive UTC datetime, got {anchor!r}")

    buckets: dict[datetime, list[str]] = {}
    for seg in segments:
        at = anchor + timedelta(seconds=seg.start)
        minute = at.replace(second=0, microsecond=0)
        buckets.setdefault(minute, []).append(seg.text)

    out: list[MinuteSummary] = []
    for minute in sorted(buckets):
        texts = buckets[minute]
        text = condense(texts, max_chars=max_chars)
        # A minute whose every segment condensed away to nothing (all annotation
        # or filler) is dropped rather than written empty: an empty row would
        # read to the composer as "this station was on air saying nothing",
        # which is a different claim from "nothing was captured".
        if not text:
            continue
        out.append(MinuteSummary(minute=minute, text=text, segment_count=len(texts)))
    return out


def to_minute_rows(
    summaries: list[MinuteSummary],
    *,
    channel: int | None,
    channel_slug: str | None,
    medium: str,
) -> list[dict]:
    """Shape summaries for Directus.

    channel/channel_slug/medium are carried per row for the same reason
    chat_transcript_segments carries them: the streamer filters tier 2 by the
    stations that reached a buddy's market, and a summary row that lost its
    provenance could not be filtered — every buddy would hear every station.
    """
    return [
        {
            "channel": channel,
            "channel_slug": channel_slug,
            "medium": medium,
            "minute": s.minute.isoformat(),
            "summary": s.text,
            "segment_count": s.segment_count,
        }
        for s in summaries
    ]
