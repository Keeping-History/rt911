"""
Download Usenet newsgroup mbox archives from the Internet Archive.

Selects the ``.mbox.zip`` / ``.mbox.gz`` payload for a usenet_jobs item (skipping
the torrent, CSV index, and ``*_files.xml`` / ``*_meta.xml`` sidecars) and pulls it
into scratch with byte-range resume. Reuses ``get_ia_files`` from the video
downloader. mbox_parser decompresses ``.zip``/``.gz`` transparently, so the archive
is kept compressed on disk — no decompress step here.

Unlike the video downloader this has no Wasabi reuse path: newsgroup archives are
small (KB–MB) and processed-then-discarded, so an in-region cache earns little.
"""
from pathlib import Path

import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_random_exponential,
)

_IA_BASE = "https://archive.org"
_METADATA_TIMEOUT = 30.0  # small JSON payload, generous enough for IA blips
# read=None disables the per-chunk read timeout so a slow chunk doesn't kill the
# pull; connect stays bounded so an unreachable host still fails fast.
_DOWNLOAD_TIMEOUT = httpx.Timeout(connect=30.0, read=None, write=None, pool=None)

_TRANSIENT_HTTP_ERRORS = (
    httpx.TimeoutException,
    httpx.ConnectError,
    httpx.RemoteProtocolError,
    httpx.NetworkError,
)


# Full-jitter backoff so a batch of jobs timing out against an overloaded IA don't
# retry in lockstep. Kept local (not imported from the video downloader) so this
# module doesn't drag in that pipeline's boto/Wasabi dependencies.
@retry(
    stop=stop_after_attempt(5),
    wait=wait_random_exponential(multiplier=1, max=20),
    retry=retry_if_exception_type(_TRANSIENT_HTTP_ERRORS),
    reraise=True,
)
def get_ia_files(ia_identifier: str) -> list[dict]:
    url = f"{_IA_BASE}/metadata/{ia_identifier}/files"
    resp = httpx.get(url, follow_redirects=True, timeout=_METADATA_TIMEOUT)
    resp.raise_for_status()
    return resp.json().get("result", [])

# mbox payloads we can parse, best first. .zip and .gz are both handled by
# mbox_parser._resolve_paths; bare .mbox is a last resort.
_MBOX_SUFFIXES = (".mbox.zip", ".mbox.gz", ".mbox")


def select_mbox_file(files: list[dict]) -> dict:
    """Return the mbox payload file for an IA newsgroup item.

    Skips ``private`` files and every non-mbox sidecar (torrent, ``*_files.xml``,
    ``*_meta.xml``, the ``.csv.gz`` index giganews ships). Among mbox candidates,
    prefers the most parser-friendly suffix, then the larger file. Raises
    ValueError if the item exposes no mbox payload.
    """
    candidates = []
    for f in files:
        if str(f.get("private", "")).lower() == "true":
            continue
        name = f.get("name", "")
        lname = name.lower()
        if ".mbox" not in lname:
            continue
        rank = next((i for i, s in enumerate(_MBOX_SUFFIXES) if lname.endswith(s)), len(_MBOX_SUFFIXES))
        try:
            size = int(f.get("size") or 0)
        except (TypeError, ValueError):
            size = 0
        candidates.append((rank, -size, f))

    if not candidates:
        raise ValueError("no mbox payload found in IA item")
    candidates.sort(key=lambda c: (c[0], c[1]))
    return candidates[0][2]


def download_mbox(job, dest_dir: Path, *, logger=None) -> Path:
    """Fetch the mbox payload for the job into ``dest_dir/<id>/<name>``.

    Byte-range-resumable like the video downloader: a partial file on disk is
    continued, a complete one is short-circuited (avoids a spurious 416), and a
    larger-than-expected (corrupt) one is discarded and re-fetched. ``get_ia_files``
    already retries transient IA errors; a mid-stream failure propagates so the
    flow-level retry resumes from the on-disk offset.
    """
    files = get_ia_files(job.ia_identifier)
    best = select_mbox_file(files)
    dest = dest_dir / job.ia_identifier / best["name"]
    dest.parent.mkdir(parents=True, exist_ok=True)

    url = f"{_IA_BASE}/download/{job.ia_identifier}/{best['name']}"
    try:
        expected = int(best.get("size") or 0)
    except (TypeError, ValueError):
        expected = 0
    offset = dest.stat().st_size if dest.exists() else 0

    if expected and offset == expected:
        if logger:
            logger.info("usenet download: %s already complete on disk (%d bytes)", job.ia_identifier, offset)
        return dest
    if expected and offset > expected:
        dest.unlink()
        offset = 0

    headers = {"Range": f"bytes={offset}-"} if offset else {}
    with httpx.stream("GET", url, headers=headers, follow_redirects=True, timeout=_DOWNLOAD_TIMEOUT) as r:
        r.raise_for_status()
        mode = "ab" if offset else "wb"
        with dest.open(mode) as f:
            for chunk in r.iter_bytes(chunk_size=1024 * 1024):
                f.write(chunk)

    return dest
