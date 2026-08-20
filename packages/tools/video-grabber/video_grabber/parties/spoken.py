"""Read numbers the way the radio says them.

Nobody on this audio says "seventy-five". They say "seven five", or "niner seven
five", or — for a flight number — "eighty nine". Whisper transcribes what it
hears, so the corpus is full of numbers written as words, and any check that
looks for the digit form silently fails on them. `Quit 2-5` and
`Delta Eighty Nine` were both in the audio plainly and both scored as absent.

Two readings are in play and both are legitimate:

- **concatenated** — each word is one digit: "niner seven five" is 975.
- **natural** — the run is an ordinary English number: "eighty nine" is 89.

Which one a speaker meant is not recoverable from the words alone, so for
matching we generate both and accept either. For the single canonical form a tag
needs, the presence of a tens or teens word decides it: "eighty nine" cannot be
a digit-by-digit reading, while "seven five" cannot be anything else.

Aviation pronunciations are included ("niner", "fife", "tree") because
controllers use them and the transcriber writes them down verbatim.
"""
from __future__ import annotations

import re

UNITS: dict[str, int] = {
    "zero": 0, "oh": 0, "naught": 0,
    "one": 1, "two": 2, "three": 3, "tree": 3, "four": 4, "fower": 4,
    "five": 5, "fife": 5, "six": 6, "seven": 7, "eight": 8,
    "nine": 9, "niner": 9,
}
TEENS: dict[str, int] = {
    "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
    "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
}
TENS: dict[str, int] = {
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
    "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
}
SCALES: dict[str, int] = {"hundred": 100, "thousand": 1000}

NUMBER_WORDS = frozenset(UNITS) | frozenset(TEENS) | frozenset(TENS) | frozenset(SCALES)

_TOKEN = re.compile(r"[A-Za-z]+|\d+")


def _concatenated(run: list[str]) -> str:
    """Digit-by-digit: 'niner seven five' -> '975'."""
    out = []
    for word in run:
        if word in UNITS:
            out.append(str(UNITS[word]))
        elif word in TEENS:
            out.append(str(TEENS[word]))
        elif word in TENS:
            out.append(str(TENS[word]))
        else:
            return ""  # a scale word has no digit-by-digit reading
    return "".join(out)


def _natural(run: list[str]) -> str:
    """Ordinary English: 'eighty nine' -> '89', 'one thousand two hundred' -> '1200'."""
    total = current = 0
    for word in run:
        if word in UNITS:
            current += UNITS[word]
        elif word in TEENS:
            current += TEENS[word]
        elif word in TENS:
            current += TENS[word]
        elif word == "hundred":
            current = (current or 1) * 100
        elif word == "thousand":
            total += (current or 1) * 1000
            current = 0
        else:
            return ""
    return str(total + current)


def _runs(text: str) -> list[list[str]]:
    """Maximal consecutive runs of number words, lower-cased."""
    runs, current = [], []
    for token in _TOKEN.findall(text or ""):
        word = token.lower()
        if word in NUMBER_WORDS:
            current.append(word)
        elif current:
            runs.append(current)
            current = []
    if current:
        runs.append(current)
    return runs


def digit_candidates(text: str) -> str:
    """Every digit string the spoken numbers in `text` could be written as.

    Space-separated so a substring search cannot match across two candidates —
    "89 975" must not satisfy a search for "897".
    """
    found: list[str] = []
    for run in _runs(text):
        for reading in (_concatenated(run), _natural(run)):
            if reading and reading not in found:
                found.append(reading)
    return " ".join(found)


def spoken_to_digits(text: str) -> str:
    """Rewrite spoken numbers in `text` as digits, picking one reading.

    A tens or teens word settles it — "eighty nine" cannot be read digit by
    digit, and "seven five" cannot be read any other way.
    """
    tokens = _TOKEN.findall(text or "")
    out: list[str] = []
    run: list[str] = []

    def flush():
        if not run:
            return
        compound = any(w in TENS or w in TEENS or w in SCALES for w in run)
        reading = _natural(run) if compound else _concatenated(run)
        out.append(reading or " ".join(run))
        run.clear()

    for token in tokens:
        word = token.lower()
        if word in NUMBER_WORDS:
            run.append(word)
        else:
            flush()
            out.append(token)
    flush()
    return " ".join(out)
