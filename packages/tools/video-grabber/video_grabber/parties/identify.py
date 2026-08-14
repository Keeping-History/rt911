"""Decide who a recording's traffic is between. Pure logic only.

The network call is injected, so every rule here is unit-testable without a key —
same split as transcript/summarize.py, and for the same reason: the judgments that
matter must be testable in isolation.

The containment gate is the point of this module. The model knows how September 11
turned out. Asked who is speaking on a garbled tape it will confidently supply
"NEADS" or "Colin Scoggins" from background knowledge rather than from the audio.
Identification has to be a reading task, not a recall task, so every name the model
returns must already be in the transcript and its evidence quote must be verbatim.
"""
from __future__ import annotations

import json
import re

from video_grabber.transcript.summarize import unsupported_words

CONVERSATION = "conversation"
BROADCAST = "broadcast"

TIER_CLIP = "clip"
TIER_TAPE = "tape"
CLIP_MAX_SECONDS = 300

# Keyed on the first path segment under audio/. A module constant rather than an
# env var: this is a property of the corpus, not the deployment, and an env var is
# one more thing that can arrive empty.
MEDIA_KIND: dict[str, str] = {
    "AA11": CONVERSATION, "AA77": CONVERSATION, "UA93": CONVERSATION,
    "UA175": CONVERSATION, "DL1989": CONVERSATION, "NEADS": CONVERSATION,
    "norad": CONVERSATION, "Langley": CONVERSATION, "QUIT": CONVERSATION,
    "GOFER06": CONVERSATION, "ATCSCC": CONVERSATION, "FAA": CONVERSATION,
    "ZBW": CONVERSATION, "ZDC": CONVERSATION, "ZNY": CONVERSATION,
    "ZOB": CONVERSATION, "faa_atc": CONVERSATION, "fdny_dispatch": CONVERSATION,
    "rutgers_audiograph": CONVERSATION,
    # News radio: a broadcast has no counterparty. Excluded by decision.
    "wins1010": BROADCAST, "wcbs": BROADCAST,
}


def media_kind(key: str) -> str | None:
    """'conversation', 'broadcast', or None for a folder nobody has classified."""
    parts = key.split("/")
    if len(parts) < 3 or parts[0] != "audio":
        return None
    return MEDIA_KIND.get(parts[1])


def should_identify(key: str) -> bool:
    """Affirmative allow-list.

    Deliberately not `!= BROADCAST`. A deny-list that fails to load, or a typo in a
    folder name, silently re-admits WINS and WCBS and produces confident nonsense;
    an allow-list that fails to load identifies nothing, which is immediately
    obvious. An unclassified folder is skipped, not identified.
    """
    return media_kind(key) == CONVERSATION


def tier_for(duration_seconds: int | None) -> str:
    if duration_seconds is None:
        raise ValueError(
            "duration is required to tier a recording; refusing to guess "
            "(defaulting to clip would send a 6.75h transcript through the clip prompt)"
        )
    return TIER_CLIP if duration_seconds < CLIP_MAX_SECONDS else TIER_TAPE


_SYSTEM = """\
You identify who is speaking in a transcript of September 11, 2001 air traffic \
control, military, and emergency audio.

Rules you must follow:
- Use ONLY what the transcript says. Do not use anything you know about the events \
of September 11 from any other source.
- If the transcript does not name a facility, position, or person, return null for \
that field. Do not infer it.
- The `evidence` field must be an exact quote copied character-for-character from \
the transcript.
- If you cannot tell who is speaking, say so with confidence "low" and null sides. \
That is a correct answer, not a failure.

Return ONLY a JSON object:
{"tier":"clip",
 "side_a":{"facility":str|null,"position":str|null,"person":str|null,"role":str|null},
 "side_b":{"facility":str|null,"position":str|null,"person":str|null,"role":str|null},
 "link":"air-ground"|"landline"|"internal"|"unknown",
 "aircraft":[str],
 "confidence":"high"|"medium"|"low",
 "evidence":str}

`role` is one of: atc, military, airline, emergency, aircraft, unknown."""


def build_clip_messages(transcript: str) -> tuple[str, str]:
    return _SYSTEM, f"Transcript:\n\n{transcript}"


def build_tape_messages(filename: str, samples: list[str]) -> tuple[str, str]:
    system = _SYSTEM.replace('"tier":"clip"', '"tier":"tape"') + (
        "\n\nThis is a long continuous recording of ONE position. side_a is that "
        "position. side_b represents the many counterparties, so set its facility "
        'to "various". Identify the position from the filename and the samples.'
    )
    joined = "\n\n---\n\n".join(samples)
    return system, f"Filename: {filename}\n\nSampled excerpts:\n\n{joined}"


_FENCE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.S)
_DIGITS = re.compile(r"\d+")


def parse_parties(raw: str) -> dict:
    """Parse the model's reply, tolerating a markdown fence."""
    text = (raw or "").strip()
    if not text:
        # An empty reply is not malformed JSON, and saying "did not return JSON"
        # sent us looking at the prompt for an hour. The cause is a max_tokens
        # budget consumed entirely by adaptive thinking, so the response carries a
        # thinking block and no text block. Name that, so the next reader checks
        # the budget first. See PARTIES_MAX_TOKENS in parties/flows.py.
        raise ValueError(
            "model returned no text. The usual cause is max_tokens being consumed "
            "by adaptive thinking (stop_reason=max_tokens, content=['thinking']); "
            "raise the token budget rather than changing the prompt."
        )
    m = _FENCE.search(text)
    if m:
        text = m.group(1)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"model did not return JSON: {raw[:200]!r}") from exc
    if not isinstance(parsed, dict):
        raise ValueError(f"model returned {type(parsed).__name__}, not an object")
    return parsed


def _normalise(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip().lower()


def evidence_is_verbatim(evidence: str, transcript: str) -> bool:
    if not (evidence or "").strip():
        return False
    return _normalise(evidence) in _normalise(transcript)


def _callsign_supported(callsign: str, transcript: str) -> bool:
    """A callsign is supported when its flight number appears in the transcript.

    'AAL77' is a normalisation of the spoken 'American 77', not a quotation, so
    requiring the literal token would reject every correct answer. The flight
    number is the part that cannot be invented without inventing an aircraft.
    """
    digits = _DIGITS.findall(callsign or "")
    if not digits:
        return False
    return all(d in transcript for d in digits)


def validate_parties(parsed: dict, transcript: str) -> tuple[dict, list[str]]:
    """Drop every name the transcript does not support; return (cleaned, reasons).

    Any rejection forces confidence to 'low' rather than discarding the whole
    answer: a partly-supported identification is still worth keeping, but it must
    not claim to be certain.
    """
    cleaned = json.loads(json.dumps(parsed))
    reasons: list[str] = []

    if not evidence_is_verbatim(cleaned.get("evidence", ""), transcript):
        reasons.append("evidence is not a verbatim quote from the transcript")
        cleaned["evidence"] = None

    for side in ("side_a", "side_b"):
        block = cleaned.get(side) or {}
        for field in ("facility", "position", "person"):
            value = block.get(field)
            # 'various' is the tape tier's deliberate placeholder for "many
            # counterparties", not a claim about the transcript.
            if not value or value == "various":
                continue
            missing = unsupported_words(value, transcript)
            if missing:
                reasons.append(
                    f"{side}.{field}={value!r} names {missing} which the transcript "
                    f"never contains"
                )
                block[field] = None
        cleaned[side] = block

    aircraft = cleaned.get("aircraft") or []
    kept = []
    for name in aircraft:
        if _callsign_supported(str(name), transcript):
            kept.append(name)
        else:
            reasons.append(f"aircraft {name!r} not present in transcript")
    cleaned["aircraft"] = kept

    if reasons:
        cleaned["confidence"] = "low"
    return cleaned, reasons
