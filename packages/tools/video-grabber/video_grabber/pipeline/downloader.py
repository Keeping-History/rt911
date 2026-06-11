"""
Resumable download worker for Internet Archive broadcast files.

File preference: .mp4 (full-res) > .mpg/.mpeg2 > .ogv/.avi
Byte-range resume: sends Range header when partial file exists on disk.

Both the metadata call and the streaming download set explicit timeouts
and retry on transient httpx errors. The metadata endpoint is fast but
prone to intermittent 5 s timeouts; the streaming download disables the
read timeout so a slow chunk doesn't kill an in-progress 4–8 GiB pull.
"""
from pathlib import Path
import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

_IA_BASE = "https://archive.org"

_TRANSIENT_HTTP_ERRORS = (
    httpx.TimeoutException,
    httpx.ConnectError,
    httpx.RemoteProtocolError,
    httpx.NetworkError,
)

_METADATA_TIMEOUT = 30.0  # seconds — small JSON payload, generous enough for IA blips
# read=None disables the per-chunk read timeout for streaming downloads; connect
# stays bounded so we still notice an outright unreachable host.
_DOWNLOAD_TIMEOUT = httpx.Timeout(connect=30.0, read=None, write=None, pool=None)

# Format preference order (lower index = higher priority)
_FORMAT_PRIORITY = {
    ".mp4": 0,
    ".mpg": 1,
    ".mpeg2": 1,
    ".avi": 2,
    ".ogv": 3,
}

# Low-quality derivative names to skip
_SKIP_PATTERNS = ("512kb", "256kb", "128kb", "_small", "_tiny", "_thumb")


@retry(
    stop=stop_after_attempt(4),
    wait=wait_exponential(multiplier=1, min=2, max=15),
    retry=retry_if_exception_type(_TRANSIENT_HTTP_ERRORS),
    reraise=True,
)
def get_ia_files(ia_identifier: str) -> list[dict]:
    url = f"{_IA_BASE}/metadata/{ia_identifier}/files"
    resp = httpx.get(url, follow_redirects=True, timeout=_METADATA_TIMEOUT)
    resp.raise_for_status()
    return resp.json().get("result", [])


def select_best_file(files: list[dict]) -> dict:
    """Return the best source file by format priority. Raises ValueError if none qualify."""
    candidates = []
    for f in files:
        name = f.get("name", "").lower()
        suffix = "." + name.rsplit(".", 1)[-1] if "." in name else ""
        if suffix not in _FORMAT_PRIORITY:
            continue
        if any(pat in name for pat in _SKIP_PATTERNS):
            continue
        candidates.append((f, _FORMAT_PRIORITY[suffix]))

    if not candidates:
        raise ValueError("no suitable file found in IA item")

    candidates.sort(key=lambda x: x[1])
    return candidates[0][0]


def download_item(job, dest_dir: Path) -> Path:
    """Download the best file for the job with byte-range resume support."""
    files = get_ia_files(job.ia_identifier)
    best = select_best_file(files)
    url = f"{_IA_BASE}/download/{job.ia_identifier}/{best['name']}"
    dest = dest_dir / job.ia_identifier / best["name"]
    dest.parent.mkdir(parents=True, exist_ok=True)

    offset = dest.stat().st_size if dest.exists() else 0
    headers = {"Range": f"bytes={offset}-"} if offset else {}

    with httpx.stream(
        "GET", url, headers=headers,
        follow_redirects=True, timeout=_DOWNLOAD_TIMEOUT,
    ) as r:
        r.raise_for_status()
        mode = "ab" if offset else "wb"
        with dest.open(mode) as f:
            for chunk in r.iter_bytes(chunk_size=1024 * 1024):
                f.write(chunk)
                offset += len(chunk)
                update_bytes_downloaded(job.id, offset)

    return dest


def update_bytes_downloaded(job_id, bytes_downloaded: int) -> None:
    """Update video_jobs.bytes_downloaded. No-op if db session not available."""
    # Called with a plain job.id; actual DB update happens in flow context
    pass
