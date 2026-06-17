"""
Thread a newsgroup mbox with usenetarchive and return a message-id → parent map.

usenetarchive (C++/AGPL) is used purely as a *connectivity oracle*: mbox_parser
stays the parser of record (dates, body, cutoff), and this wrapper supplies the
restored thread links — including the quote-matched ones threadify recovers for
messages whose headers lost them. The two join on message_id downstream.

Pipeline per archive (see plans/usenet-archive-ingestion.md, Stage 3):

    import-source-mbox <mbox> <raw>
    kill-duplicates    <raw>  <arch>
    extract-msgid      <arch>            # msgid table (in place)
    connectivity       <arch>            # dependency graph + Date parse (in place)
    threadify          <arch>            # restore missing links (in place)
    uat-thread-export  <arch>  > TSV     # our libuat tool: msgid \t parent_msgid

The binaries are resolved from USENETARCHIVE_BIN (a directory) if set, else PATH.
"""
import logging
import os
import subprocess
from pathlib import Path

_default_log = logging.getLogger(__name__)

# Our custom libuat tool (uat_thread_export.cpp), built into the image alongside
# the stock usenetarchive binaries.
_THREAD_EXPORT_BIN = "uat-thread-export"


def _bin(name: str) -> str:
    """Resolve a usenetarchive binary by name, honouring USENETARCHIVE_BIN."""
    bindir = os.getenv("USENETARCHIVE_BIN", "").strip()
    return os.path.join(bindir, name) if bindir else name


def _run(args: list[str], logger: logging.Logger) -> None:
    """Run a usenetarchive step, raising CalledProcessError with captured stderr."""
    logger.info("usenet threader: %s", " ".join(args))
    proc = subprocess.run(args, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise subprocess.CalledProcessError(proc.returncode, args, proc.stdout, proc.stderr)


def build_threaded_archive(mbox_path: str, workdir: str, logger: logging.Logger | None = None) -> str:
    """Run the import → dedup → connectivity → threadify pipeline.

    Returns the path of the threaded LZ4 archive directory (ready for export).
    workdir must not already contain the `raw`/`arch` outputs (the tools refuse to
    overwrite an existing destination).
    """
    log = logger or _default_log
    work = Path(workdir)
    raw = work / "raw"
    arch = work / "arch"

    _run([_bin("import-source-mbox"), str(mbox_path), str(raw)], log)
    _run([_bin("kill-duplicates"), str(raw), str(arch)], log)
    _run([_bin("extract-msgid"), str(arch)], log)
    _run([_bin("connectivity"), str(arch)], log)
    _run([_bin("threadify"), str(arch)], log)
    return str(arch)


def extract_parent_map(archive_dir: str, logger: logging.Logger | None = None) -> dict[str, str]:
    """Run uat-thread-export and parse its TSV into {message_id: parent_message_id}.

    Every message has a row; the root of a thread maps to "" (no parent).
    """
    log = logger or _default_log
    args = [_bin(_THREAD_EXPORT_BIN), str(archive_dir)]
    log.info("usenet threader: %s", " ".join(args))
    out = subprocess.run(args, capture_output=True, text=True, check=True).stdout
    return parse_parent_tsv(out)


def parse_parent_tsv(tsv: str) -> dict[str, str]:
    """Parse `msgid\\tparent_msgid` lines into a dict. A missing/empty parent → ""."""
    parents: dict[str, str] = {}
    for line in tsv.splitlines():
        if not line:
            continue
        msgid, _, parent = line.partition("\t")
        msgid = msgid.strip()
        if msgid:
            parents[msgid] = parent.strip()
    return parents


def thread_root(msgid: str, parents: dict[str, str]) -> str:
    """Walk parent links to the thread root, guarding against cycles and danglers."""
    seen = {msgid}
    cur = msgid
    while True:
        parent = parents.get(cur)
        if not parent or parent == cur:
            return cur               # cur is a real root
        if parent in seen:
            return cur               # cycle guard — treat cur as root
        if parent not in parents:
            return parent            # parent referenced but not itself a message:
                                     # use it as the shared thread id so siblings group
        seen.add(cur)
        cur = parent


def build_thread_index(parents: dict[str, str]) -> dict[str, dict]:
    """Turn a parent map into {message_id: {"parent": <msgid|None>, "thread": <root msgid>}}.

    This is what the writer joins onto mbox_parser records by message_id to fill
    usenet_items.parent_id and thread_id.
    """
    index: dict[str, dict] = {}
    for msgid in parents:
        parent = parents.get(msgid) or None
        index[msgid] = {"parent": parent, "thread": thread_root(msgid, parents)}
    return index


def thread_mbox(mbox_path: str, workdir: str, logger: logging.Logger | None = None) -> dict[str, dict]:
    """End to end: thread an mbox and return the message_id → {parent, thread} index."""
    archive = build_threaded_archive(mbox_path, workdir, logger)
    parents = extract_parent_map(archive, logger)
    return build_thread_index(parents)
