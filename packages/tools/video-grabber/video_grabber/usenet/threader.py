"""
Thread a newsgroup mbox with usenetarchive and return a message-id → parent map.

usenetarchive (C++/AGPL) is used purely as a *connectivity oracle*: mbox_parser
stays the parser of record (dates, body, cutoff), and this wrapper supplies the
restored thread links — including the quote-matched ones threadify recovers for
messages whose headers lost them. The two join on message_id downstream.

Pipeline per archive (see plans/usenet-archive-ingestion.md, Stage 3). threadify
opens the archive via libuat Archive::Open, which needs the *full* derived data
set, so the build runs the complete usenetarchive sequence — not just connectivity:

    (decompress .zip/.gz → plain .mbox)
    import-source-mbox <mbox> <raw>
    kill-duplicates    <raw>  <arch>
    extract-msgid      <arch>   # mid* table
    connectivity       <arch>   # conn* graph + toplevel + Date parse  [needs msgid]
    extract-msgmeta    <arch>   # str* (From/Subject)
    repack-zstd        <arch>   # zstd message store (zmeta/zdata/zdict)
    lexicon            <arch>   # lex* word index  [needs connectivity]
    lexsort            <arch>   # sort lex*
    threadify          <arch>   # restore missing links  [needs lexsort]
    uat-thread-export  <arch>  > TSV     # our libuat tool: msgid \t parent_msgid

The binaries are resolved from USENETARCHIVE_BIN (a directory) if set, else PATH.
"""
import gzip
import logging
import os
import shutil
import subprocess
import zipfile
from pathlib import Path

_default_log = logging.getLogger(__name__)

# Our custom libuat tool (uat_thread_export.cpp), built into the image alongside
# the stock usenetarchive binaries.
_THREAD_EXPORT_BIN = "uat-thread-export"

# repack-zstd needs ~10× the dictionary size in RAM; the default sizing OOM-kills
# the worker on large groups. -s caps the dict at 2^power bytes (here 16 MiB),
# which bounds memory at a small compression-ratio cost.
_ZSTD_DICT_POWER = "24"

# threadify requires a *complete* archive (it opens it via libuat Archive::Open,
# which needs the zstd store + lexicon + string + connectivity + msgid files), so
# the build must run the full usenetarchive pipeline in dependency order, not just
# connectivity. Each step operates in place on the archive dir.
#   extract-msgid → mid*; connectivity → conn*/toplevel; extract-msgmeta → str*;
#   repack-zstd → zstd; lexicon → lex* (needs conn); lexsort → sorted lex
#   (threadify requires lexsort); then threadify restores connectivity.
#
# Each entry is (extra-args, accepted-exit-codes). threadify returns 1 when it
# matched messages (a "re-run sort/lexsort" signal) and 0 only when it changed
# nothing — both are success, so 1 must not be treated as an error.
_INPLACE_STEPS = (
    ("extract-msgid", [], (0,)),
    ("connectivity", [], (0,)),
    ("extract-msgmeta", [], (0,)),
    ("repack-zstd", ["-s", _ZSTD_DICT_POWER], (0,)),
    ("lexicon", [], (0,)),
    ("lexsort", [], (0,)),
    ("threadify", [], (0, 1)),
)


def _bin(name: str) -> str:
    """Resolve a usenetarchive binary by name, honouring USENETARCHIVE_BIN."""
    bindir = os.getenv("USENETARCHIVE_BIN", "").strip()
    return os.path.join(bindir, name) if bindir else name


def _run(args: list[str], logger: logging.Logger, ok_codes: tuple[int, ...] = (0,)) -> None:
    """Run a usenetarchive step; raise with the tool's captured stderr on failure.

    ok_codes lists the exit codes that count as success (some tools, e.g. threadify,
    use a non-zero code to signal "work done"). Including stderr in the raised
    message is what makes a real failure diagnosable from the Prefect job's
    error_message (the bare CalledProcessError repr does not carry it).
    """
    logger.info("usenet threader: %s", " ".join(args))
    proc = subprocess.run(args, capture_output=True, text=True, check=False)
    if proc.returncode not in ok_codes:
        tail = (proc.stderr or proc.stdout or "").strip()[-500:]
        raise RuntimeError(f"{Path(args[0]).name} failed (rc={proc.returncode}): {tail}")


def _ensure_plain_mbox(mbox_path: str, workdir: Path, logger: logging.Logger) -> str:
    """Decompress a .mbox.zip / .mbox.gz to a plain mbox file.

    import-source-mbox does NOT decompress — handed a zip/gz it reads the compressed
    bytes as an empty mbox ("0 files processed"), producing an empty archive that
    every later step then fails on. usenethistorical ships .mbox.zip, giganews .gz.
    """
    low = str(mbox_path).lower()
    if low.endswith(".zip"):
        dest = workdir / "extracted"
        dest.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(mbox_path) as z:
            z.extractall(dest)
        files = [f for f in dest.rglob("*") if f.is_file()]
        if not files:
            raise RuntimeError(f"empty zip archive: {mbox_path}")
        # Prefer a .mbox member, else the largest file.
        mbox = next((f for f in files if f.suffix.lower() == ".mbox"),
                    max(files, key=lambda f: f.stat().st_size))
        logger.info("usenet threader: unzipped %s → %s", mbox_path, mbox)
        return str(mbox)
    if low.endswith(".gz"):
        out = workdir / "archive.mbox"
        out.parent.mkdir(parents=True, exist_ok=True)
        with gzip.open(mbox_path, "rb") as fin, open(out, "wb") as fout:
            shutil.copyfileobj(fin, fout)
        logger.info("usenet threader: gunzipped %s → %s", mbox_path, out)
        return str(out)
    return str(mbox_path)


def build_threaded_archive(mbox_path: str, workdir: str, logger: logging.Logger | None = None) -> str:
    """Build a fully-processed, threaded usenetarchive and return its directory.

    Decompresses the input, imports it, then runs the full derived-data pipeline so
    threadify (and uat-thread-export) can open it. workdir must not already contain
    the raw/arch outputs (the tools refuse to overwrite an existing destination).
    """
    log = logger or _default_log
    work = Path(workdir)
    work.mkdir(parents=True, exist_ok=True)
    plain = _ensure_plain_mbox(mbox_path, work / "src", log)

    raw = work / "raw"
    arch = work / "arch"
    _run([_bin("import-source-mbox"), plain, str(raw)], log)
    _run([_bin("kill-duplicates"), str(raw), str(arch)], log)
    for name, extra, ok in _INPLACE_STEPS:
        _run([_bin(name), *extra, str(arch)], log, ok_codes=ok)
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


def normalize_msgid(msgid: str | None) -> str:
    """Strip surrounding angle brackets + whitespace from a Message-ID.

    usenetarchive's extract-msgid stores the id *between* the `<` and `>`, while
    mbox_parser keeps the raw header form (`<...>`). Normalising both ends lets the
    thread index join the parser records (otherwise every message looks like a
    singleton). Applied to message_id/thread_id/parent_id so they stay consistent.
    """
    if not msgid:
        return ""
    return msgid.strip().lstrip("<").rstrip(">").strip()


def build_thread_index(parents: dict[str, str]) -> dict[str, dict]:
    """Turn a parent map into {message_id: {"parent": <msgid|None>, "thread": <root msgid>}}.

    Keys and values are bracket-normalised so the writer can join them onto
    mbox_parser records (whose ids keep the <>) to fill parent_id and thread_id.
    """
    index: dict[str, dict] = {}
    for msgid in parents:
        index[normalize_msgid(msgid)] = {
            "parent": normalize_msgid(parents.get(msgid)) or None,
            "thread": normalize_msgid(thread_root(msgid, parents)),
        }
    return index


def thread_mbox(mbox_path: str, workdir: str, logger: logging.Logger | None = None) -> dict[str, dict]:
    """End to end: thread an mbox and return the message_id → {parent, thread} index."""
    archive = build_threaded_archive(mbox_path, workdir, logger)
    parents = extract_parent_map(archive, logger)
    return build_thread_index(parents)
