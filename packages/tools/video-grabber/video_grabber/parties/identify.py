"""Decide who a recording's traffic is between, and what it is about. Pure logic.

The network call is injected, so every rule here is unit-testable without a key —
same split as transcript/summarize.py, and for the same reason: the judgments that
matter must be testable in isolation.

The containment gate is the point of this module. The model knows how September 11
turned out. Asked who is speaking on a garbled tape it will confidently supply
"NEADS" or "Colin Scoggins" from background knowledge rather than from the audio.
Identification has to be a reading task, not a recall task, so every name the model
returns must already be in a document it was shown, and its evidence quote must be
verbatim.

Schema 2 widens what a recording can say about itself without widening what the
model is allowed to invent:

- **`participants` replaces `side_a`/`side_b`.** Two sides could not describe a
  conference call or a position tape, and 179 tapes were reduced to the
  placeholder `side_b.facility = "various"` for exactly that reason.
- **`mentions` separates who is talked about from who is talking**, which was
  previously discarded entirely.
- **`subject` and `topics`** say what the call is about. `topics` comes from a
  closed vocabulary (`vocab.TOPICS`) because free text does not survive contact
  with a search box.
- **Confidence is per participant**, not per blob. Under schema 1 a single
  rejected field dragged the whole answer to "low", which made 189 partly-good
  rows indistinguishable from ones the model genuinely could not read.

Provenance is carried two ways for one reason: participants are objects, so their
`source` and `confidence` live inline where they cannot be knocked out of
alignment by a dropped entry, while the flat fields use a path-keyed `sources`
map. Array indices in a path map would shift whenever the gate drops a
participant, silently re-labelling the survivors.
"""
from __future__ import annotations

import json
import re

from video_grabber.parties.vocab import LINKS, ROLES, TOPICS
from video_grabber.transcript.summarize import unsupported_words

CONVERSATION = "conversation"
BROADCAST = "broadcast"

TIER_CLIP = "clip"
TIER_TAPE = "tape"
CLIP_MAX_SECONDS = 300

SCHEMA_VERSION = 2

SOURCE_TRANSCRIPT = "transcript"
SOURCE_COMMISSION = "commission_monograph"

CONFIDENCE_ORDER = {"low": 0, "medium": 1, "high": 2}

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
You identify who is speaking in a recording of September 11, 2001 air traffic \
control, military, and emergency audio, and say what the recording is about.

Rules you must follow:
- Every value you return must come from a document you were given. Do not use \
anything you know about September 11 from any other source.
- If the documents do not tell you, return null or an empty list. That is a \
correct answer, not a failure.
- `evidence` must be an exact quote copied character-for-character from a \
document.
- `subject` must be written using words that appear in the documents.

`participants` lists everyone taking part in the communication — one entry per \
party, however many there are. Do not force a conversation into two sides. Each \
participant carries its own `confidence`, because you will often be sure of one \
party and unsure of another.

`mentions` is for facilities, aircraft and people that are TALKED ABOUT but are \
not taking part. Keep them out of `participants`.

`topics` must be chosen from this list, and nothing else:
%s

Return ONLY a JSON object:
{"tier":"clip"|"tape",
 "participants":[{"facility":str|null,"position":str|null,"person":str|null,
                  "role":"atc"|"military"|"airline"|"emergency"|"aircraft"|"unknown",
                  "confidence":"high"|"medium"|"low"}],
 "link":"air-ground"|"landline"|"internal"|"conference"|"unknown",
 "aircraft":[str],
 "mentions":{"facilities":[str],"aircraft":[str],"people":[str]},
 "subject":str|null,
 "topics":[str],
 "confidence":"high"|"medium"|"low",
 "evidence":str}"""


_TAPE_NOTE = """

This is a long continuous recording of ONE position, and you are seeing sampled \
excerpts rather than the whole thing. List that position as the first \
participant. Add the counterparties you can actually identify in the excerpts as \
further participants — do not invent a placeholder for the ones you cannot."""

_TWO_DOC_NOTE = """

You are given TWO documents. TRANSCRIPT is an automatic transcript of the \
recording, and is imperfect: callsigns and names are often garbled or missing. \
COMMISSION is how the 9/11 Commission catalogued this same recording — their \
title for it, and where available the passage of the Team 8 audio monograph that \
discusses it.

For every value you fill in, record which document it came from: on a \
participant use its `source` field, and for the flat fields use the `sources` \
map keyed by field name ("subject", "evidence", "aircraft", "mentions.people", \
"mentions.facilities", "mentions.aircraft"). Use "transcript" or \
"commission_monograph".

Prefer the transcript where both support a value. Use the Commission to fill in \
what the transcript leaves unknown or garbled. The Commission passage also gives \
narrative about the wider morning — do not pull in people or facilities it does \
not connect to THIS recording."""


def build_messages(
    transcript: str, tier: str, commission_text: str = ""
) -> tuple[str, str]:
    """The one prompt builder: clip or tape, with or without a second document.

    Schema 1 had three near-identical builders that drifted apart. The tier and
    the presence of Commission text are just two flags on one task.
    """
    system = _SYSTEM % "\n".join(f"  {t}" for t in sorted(TOPICS))
    if tier == TIER_TAPE:
        system += _TAPE_NOTE
    if commission_text:
        system += _TWO_DOC_NOTE
        user = f"COMMISSION:\n\n{commission_text}\n\n=====\n\nTRANSCRIPT:\n\n{transcript}"
    else:
        user = f"Transcript:\n\n{transcript}"
    return system, user


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


def evidence_is_verbatim(evidence: str, source: str) -> bool:
    if not (evidence or "").strip():
        return False
    return _normalise(evidence) in _normalise(source)


def _callsign_supported(callsign: str, source: str) -> bool:
    """A callsign is supported when its flight number appears in the source.

    'AAL77' is a normalisation of the spoken 'American 77', not a quotation, so
    requiring the literal token would reject every correct answer. The flight
    number is the part that cannot be invented without inventing an aircraft.
    """
    digits = _DIGITS.findall(callsign or "")
    if not digits:
        return False
    return all(d in source for d in digits)


def validate_parties(
    parsed: dict, transcript: str, commission_text: str = ""
) -> tuple[dict, list[str]]:
    """Drop everything the cited document does not support; return (cleaned, reasons).

    The gate asks one question of every value: is it in the document it claims to
    have come from? With no Commission text this reduces to the original rule —
    everything is held to the transcript — so a single-document run is the
    degenerate case rather than a separate code path.

    Two rules keep provenance from becoming decorative: an **undeclared** source
    is held to the transcript, so silence cannot reach the looser document, and an
    **unrecognised** source name is rejected outright rather than trusted.

    Unlike schema 1 this no longer crushes the whole answer to "low" on any
    rejection. Fields carry their own confidence, and a blanket downgrade made
    partly-good rows indistinguishable from unreadable ones. A gate hit caps the
    overall figure at "medium" instead — something was wrong, so it may not claim
    certainty, but what survived is still worth grading.
    """
    texts = {SOURCE_TRANSCRIPT: transcript, SOURCE_COMMISSION: commission_text}
    cleaned = json.loads(json.dumps(parsed))
    declared = cleaned.get("sources")
    if not isinstance(declared, dict):
        declared = {}
    reasons: list[str] = []
    kept_sources: dict[str, str] = {}

    def resolve(path: str, claimed: str | None = None) -> str | None:
        if claimed is None:
            claimed = declared.get(path)
        if claimed is None:
            return SOURCE_TRANSCRIPT
        if claimed not in texts:
            reasons.append(f"{path} claims unknown source {claimed!r}")
            return None
        return claimed

    def check_name(value: str, source: str, path: str) -> bool:
        missing = unsupported_words(value, texts[source])
        if missing:
            reasons.append(
                f"{path}={value!r} names {missing} which the {source} never contains"
            )
            return False
        return True

    # --- participants ---------------------------------------------------
    participants = []
    for i, raw in enumerate(cleaned.get("participants") or []):
        if not isinstance(raw, dict):
            continue
        source = resolve(f"participants[{i}]", raw.get("source"))
        if source is None:
            continue
        entry = {}
        for field in ("facility", "position", "person"):
            value = raw.get(field)
            # 'various' was schema 1's placeholder for "many counterparties".
            # Schema 2 has participants, so it is no longer a legitimate answer.
            if not value or str(value).lower() == "various":
                entry[field] = None
                continue
            entry[field] = value if check_name(
                str(value), source, f"participants[{i}].{field}"
            ) else None
        role = raw.get("role")
        entry["role"] = role if role in ROLES else "unknown"
        confidence = raw.get("confidence")
        entry["confidence"] = confidence if confidence in CONFIDENCE_ORDER else "low"
        entry["source"] = source
        # An entry naming nobody says only "somebody with this role spoke", which
        # every recording already implies. Drop it rather than pad the list.
        if any(entry[f] for f in ("facility", "position", "person")):
            participants.append(entry)
    cleaned["participants"] = participants

    # --- evidence ---------------------------------------------------------
    evidence_source = resolve("evidence")
    if evidence_source is None or not evidence_is_verbatim(
        cleaned.get("evidence", ""), texts[evidence_source]
    ):
        if evidence_source is not None:
            reasons.append(f"evidence is not a verbatim quote from the {evidence_source}")
        cleaned["evidence"] = None
    else:
        kept_sources["evidence"] = evidence_source

    # --- subject ----------------------------------------------------------
    subject = (cleaned.get("subject") or "").strip()
    subject_source = resolve("subject")
    if not subject or subject_source is None:
        cleaned["subject"] = None
    else:
        missing = unsupported_words(subject, texts[subject_source])
        if missing:
            reasons.append(
                f"subject introduced words absent from the {subject_source}: "
                f"{', '.join(missing[:6])}"
            )
            cleaned["subject"] = None
        else:
            cleaned["subject"] = subject
            kept_sources["subject"] = subject_source

    # --- aircraft ---------------------------------------------------------
    aircraft_source = resolve("aircraft")
    kept_aircraft = []
    for name in cleaned.get("aircraft") or []:
        if aircraft_source and _callsign_supported(str(name), texts[aircraft_source]):
            kept_aircraft.append(name)
        else:
            reasons.append(f"aircraft {name!r} not present in the {aircraft_source}")
    cleaned["aircraft"] = kept_aircraft
    if kept_aircraft and aircraft_source:
        kept_sources["aircraft"] = aircraft_source

    # --- mentions ---------------------------------------------------------
    mentions_in = cleaned.get("mentions") or {}
    mentions_out: dict[str, list] = {"facilities": [], "aircraft": [], "people": []}
    for kind in ("facilities", "people"):
        path = f"mentions.{kind}"
        source = resolve(path)
        if source is None:
            continue
        for value in mentions_in.get(kind) or []:
            if check_name(str(value), source, path):
                mentions_out[kind].append(value)
        if mentions_out[kind]:
            kept_sources[path] = source
    source = resolve("mentions.aircraft")
    if source:
        for value in mentions_in.get("aircraft") or []:
            if _callsign_supported(str(value), texts[source]):
                mentions_out["aircraft"].append(value)
            else:
                reasons.append(f"mentioned aircraft {value!r} not present in the {source}")
        if mentions_out["aircraft"]:
            kept_sources["mentions.aircraft"] = source
    cleaned["mentions"] = mentions_out

    # --- closed vocabularies ----------------------------------------------
    topics = []
    for topic in cleaned.get("topics") or []:
        if topic in TOPICS:
            topics.append(topic)
        else:
            reasons.append(f"topic {topic!r} is not in the controlled vocabulary")
    cleaned["topics"] = sorted(set(topics))

    if cleaned.get("link") not in LINKS:
        cleaned["link"] = "unknown"

    # --- overall confidence -------------------------------------------------
    overall = cleaned.get("confidence")
    if overall not in CONFIDENCE_ORDER:
        overall = "low"
    if reasons and CONFIDENCE_ORDER[overall] > CONFIDENCE_ORDER["medium"]:
        overall = "medium"
    cleaned["confidence"] = overall

    cleaned["sources"] = kept_sources
    cleaned["schema_version"] = SCHEMA_VERSION
    return cleaned, reasons
