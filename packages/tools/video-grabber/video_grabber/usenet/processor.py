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


def _newsgroup_of(headers: dict, fallback: str) -> str:
    """The group a message belongs to: first of the Newsgroups header, else the
    mbox's own group (the per-group archive already scopes it)."""
    ng = _first(headers.get("newsgroups"))
    if ng:
        return ng.split(",")[0].strip()
    return fallback


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


def process_archive(mbox_path, before: str, workdir, fallback_group: str, *, logger=None) -> dict[str, list[dict]]:
    """Parse + thread one mbox, returning {newsgroup: [message dicts]}."""
    work = Path(workdir)
    work.mkdir(parents=True, exist_ok=True)
    jsonl = work / "messages.jsonl"

    run_mbox_parser(mbox_path, before, jsonl, logger=logger)
    thread_index = threader.thread_mbox(str(mbox_path), str(work / "uat"), logger=logger)

    groups: dict[str, list[dict]] = {}
    with open(jsonl, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            msg = parser_record_to_message(json.loads(line), thread_index, fallback_group)
            groups.setdefault(msg["newsgroup"], []).append(msg)
    return groups
