"""
Process a downloaded newsgroup mbox into Directus-ready message records.

Combines the two tools: mbox_parser (dates, body, cutoff — the parser of record)
and usenetarchive via threader (the connectivity oracle). Each parsed message is
joined to its restored thread links by message_id, then grouped by newsgroup for
the writer. See plans/usenet-archive-ingestion.md Stage 4.
"""
import json
import os
import re
import subprocess
from pathlib import Path

from video_grabber.usenet import threader

# mbox_parser is the standalone tool in packages/tools/mbox_parser; the image
# copies it in. Override the path with MBOX_PARSER.
_MBOX_PARSER = os.getenv("MBOX_PARSER", "mbox_parser.py")
_TAG_RE = re.compile(r"<[^>]+>")

# Above this message count, the memory-heavy usenetarchive build (repack-zstd
# dictionary training) OOM-kills the worker, so we fall back to header-based
# threading. Tunable without a rebuild.
_MAX_THREADIFY_MESSAGES = int(os.getenv("USENET_MAX_THREADIFY_MESSAGES", "100000"))

# A valid newsgroup name is dot-separated components, each starting and ending
# alphanumeric (interior +, _, - allowed). Malformed Newsgroups: headers (seen in
# bundled archives) yield junk like "-h", "!.!", ".blur", "1", "0000000001" — this
# pattern + the "must contain a letter" check below reject those.
_NEWSGROUP_RE = re.compile(
    r"[A-Za-z0-9](?:[A-Za-z0-9+_-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9+_-]*[A-Za-z0-9])?)*"
)


def run_mbox_parser(mbox_path, before: str, out_path, *, python: str = "python3", logger=None) -> str:
    """Run mbox_parser over one archive, emitting JSONL (one message per line)."""
    args = [python, _MBOX_PARSER, "--before", before, "--format", "jsonl", "-o", str(out_path), str(mbox_path)]
    if logger:
        logger.info("usenet process: %s", " ".join(args))
    subprocess.run(args, check=True)
    return str(out_path)


def _first(value):
    """A header may be a string or a list (duplicated header) — take the first."""
    if isinstance(value, list):
        return value[0] if value else None
    return value


def valid_newsgroup(name) -> bool:
    """True if name is a well-formed newsgroup (dotted, alphanumeric-bounded
    components, contains at least one letter)."""
    if not name:
        return False
    name = name.strip()
    return bool(_NEWSGROUP_RE.fullmatch(name)) and any(c.isalpha() for c in name)


def _newsgroup_of(headers: dict, fallback: str):
    """The group a message belongs to: the first *valid* group in the Newsgroups
    header (crossposts are comma-separated), else the mbox's own group if valid,
    else None — which the caller drops, so junk group names never reach Directus."""
    raw = _first(headers.get("newsgroups"))
    if raw:
        for cand in raw.split(","):
            cand = cand.strip()
            if valid_newsgroup(cand):
                return cand
    return fallback if valid_newsgroup(fallback) else None


def _body_of(body: dict) -> str | None:
    """Prefer the plain-text parts; fall back to HTML with tags stripped."""
    plain = body.get("text_plain") or []
    if plain:
        return "\n".join(plain).strip() or None
    html = body.get("text_html") or []
    if html:
        return _TAG_RE.sub("", "\n".join(html)).strip() or None
    return None


def parser_record_to_message(rec: dict, thread_index: dict, fallback_group: str) -> dict:
    """Map one mbox_parser JSONL record + thread index → a writer message dict."""
    h = rec.get("headers", {})
    # Normalise the Message-ID (drop <>) so it joins the thread index and stays
    # consistent with the thread_id/parent_id the index supplies.
    mid = threader.normalize_msgid(_first(h.get("message-id")))
    ti = thread_index.get(mid) if mid else None
    return {
        "newsgroup": _newsgroup_of(h, fallback_group),
        "start_date": rec.get("date_iso"),
        "date_source": rec.get("date_source"),
        "subject": _first(h.get("subject")),
        "author": _first(h.get("from")),
        "message_id": mid or None,
        "references": _first(h.get("references")),
        "in_reply_to": _first(h.get("in-reply-to")),
        # thread_id falls back to the message's own id (a singleton thread) when the
        # oracle has no entry; parent_id is None for roots.
        "thread_id": (ti or {}).get("thread") or (mid or None),
        "parent_id": (ti or {}).get("parent"),
        "body": _body_of(rec.get("body", {})),
    }


def header_thread_index(records: list[dict]) -> dict[str, dict]:
    """Thread purely from References/In-Reply-To headers (jwz-style), no usenetarchive.

    Fallback for groups too large to run the memory-heavy full archive build. Loses
    only the quote-restored links; header-based parent/child threading is kept. The
    parent is the last id in References (the immediate ancestor), else In-Reply-To.
    """
    parents: dict[str, str] = {}
    for rec in records:
        h = rec.get("headers", {})
        mid = _first(h.get("message-id"))
        if not mid:
            continue
        refs = (_first(h.get("references")) or "").split()
        parents[mid] = refs[-1] if refs else (_first(h.get("in-reply-to")) or "")
    return threader.build_thread_index(parents)


def process_archive(mbox_path, before: str, workdir, fallback_group: str, *, logger=None) -> dict[str, list[dict]]:
    """Parse + thread one mbox, returning {newsgroup: [message dicts]}.

    Messages with no valid newsgroup are dropped; oversized archives use header-based
    threading instead of the OOM-prone usenetarchive build.
    """
    work = Path(workdir)
    work.mkdir(parents=True, exist_ok=True)
    jsonl = work / "messages.jsonl"
    run_mbox_parser(mbox_path, before, jsonl, logger=logger)

    records: list[dict] = []
    with open(jsonl, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                records.append(json.loads(line))

    if len(records) > _MAX_THREADIFY_MESSAGES:
        if logger:
            logger.warning("usenet process: %d messages > %d — header-based threading (skipping usenetarchive)",
                           len(records), _MAX_THREADIFY_MESSAGES)
        thread_index = header_thread_index(records)
    else:
        thread_index = threader.thread_mbox(str(mbox_path), str(work / "uat"), logger=logger)

    groups: dict[str, list[dict]] = {}
    skipped = 0
    for rec in records:
        msg = parser_record_to_message(rec, thread_index, fallback_group)
        if msg["newsgroup"] is None:
            skipped += 1
            continue
        groups.setdefault(msg["newsgroup"], []).append(msg)
    if skipped and logger:
        logger.info("usenet process: skipped %d messages with no valid newsgroup", skipped)
    return groups
