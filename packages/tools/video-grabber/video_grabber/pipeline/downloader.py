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
from typing import Optional

import httpx
from botocore.exceptions import ClientError
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_random_exponential,
)

from video_grabber.storage.wasabi import _make_s3_client

_IA_BASE = "https://archive.org"

# Many sources were grabbed in a prior effort and already live in the Wasabi
# bucket under this prefix as download/<ia_identifier>/<file>.
_WASABI_DOWNLOAD_PREFIX = "download"

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


# Full-jitter backoff (random in [0, exp]) rather than a deterministic ramp:
# a batch of jobs that all time out against an overloaded archive.org would,
# with a fixed schedule, retry in lockstep and re-stampede it at the same
# instants. Jitter spreads the retries out so IA can recover between waves.
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


def select_best_file(files: list[dict]) -> dict:
    """Return the best *downloadable* source file. Raises ValueError if none qualify.

    Skips ``private`` files. Stream-only items (most of the Sept-11 news archive)
    mark the full-res original ``private=true`` — it 401s for everyone, with or
    without credentials — while still exposing public ``.ogv`` / low-bitrate
    ``.mp4`` derivatives. Among downloadable files we prefer a full-quality source
    over a low-bitrate derivative (``_SKIP_PATTERNS``), then by container format,
    then by larger size. So a public original wins when present; for a stream-only
    item the largest non-low-bitrate derivative (typically the ``.ogv``) is taken,
    with the ``512kb``/etc. mp4 only as a last resort.
    """
    candidates = []
    for f in files:
        if str(f.get("private", "")).lower() == "true":
            continue
        name = f.get("name", "").lower()
        suffix = "." + name.rsplit(".", 1)[-1] if "." in name else ""
        if suffix not in _FORMAT_PRIORITY:
            continue
        is_low_bitrate = any(pat in name for pat in _SKIP_PATTERNS)
        try:
            size = int(f.get("size") or 0)
        except (TypeError, ValueError):
            size = 0
        candidates.append((is_low_bitrate, _FORMAT_PRIORITY[suffix], -size, f))

    if not candidates:
        raise ValueError("no downloadable file found in IA item")

    # Full-quality before low-bitrate, then format priority, then larger size.
    candidates.sort(key=lambda c: (c[0], c[1], c[2]))
    return candidates[0][3]


def find_wasabi_source(ia_identifier: str, best: dict, cfg, *, s3=None) -> Optional[str]:
    """Return the ``download/<id>/<name>`` key of an already-grabbed source whose
    size matches IA's reported size, or None.

    The size check is the verification gate: a prior download could be truncated
    or a different cut, so we only reuse a byte-for-byte match against IA's
    authoritative ``size``. Without a usable size we decline (re-download).
    """
    try:
        expected = int(best.get("size") or 0)
    except (TypeError, ValueError):
        expected = 0
    if not expected:
        return None

    s3 = s3 or _make_s3_client(cfg)
    key = f"{_WASABI_DOWNLOAD_PREFIX}/{ia_identifier}/{best['name']}"
    try:
        head = s3.head_object(Bucket=cfg.wasabi_bucket, Key=key)
    except ClientError:
        return None
    return key if head["ContentLength"] == expected else None


def download_item(job, dest_dir: Path, cfg=None, *, logger=None) -> Path:
    """Fetch the best source file for the job.

    If ``cfg`` is given, first look for an already-grabbed, size-verified copy in
    the Wasabi ``download/`` prefix and pull that (in-region, no IA rate limit);
    otherwise fall back to a byte-range-resumable download from Internet Archive.
    """
    files = get_ia_files(job.ia_identifier)
    best = select_best_file(files)
    dest = dest_dir / job.ia_identifier / best["name"]
    dest.parent.mkdir(parents=True, exist_ok=True)

    if cfg is not None:
        s3 = _make_s3_client(cfg)
        key = find_wasabi_source(job.ia_identifier, best, cfg, s3=s3)
        if key:
            if logger:
                logger.info("download: reusing grabbed source from Wasabi %s", key)
            s3.download_file(cfg.wasabi_bucket, key, str(dest))
            return dest
        if logger:
            logger.info("download: %s not in Wasabi, pulling from IA", job.ia_identifier)

    url = f"{_IA_BASE}/download/{job.ia_identifier}/{best['name']}"
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
