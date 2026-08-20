"""Which commit is this executor actually running?

Issue #379: two machines serve `transcribe-item` — the cluster worker pod and the
Mac Studio's launchd workers — and they silently ran different code for five
weeks. Every layer inspected correctly in isolation, because the machine you
inspect is not the machine that ran the job. Nothing recorded which commit
produced a given transcript, so the divergence was invisible until two dispatches
of the same job wrote two different keys.

So each worker stamps its version onto the `transcribe_jobs` row it claims, and
the question becomes one query:

    SELECT code_version, count(*) FROM transcribe_jobs GROUP BY 1;

Resolution order, most trustworthy first:

1. `CODE_VERSION` — baked into the image at build time from the commit SHA
   (Dockerfile ARG, set by build-video-grabber.yml). The container has no git, so
   this is the only way it can know.
2. `git rev-parse HEAD` against this file's own directory — covers the Mac, whose
   tree is a real sparse checkout. Deliberately not the process's cwd: a worker
   started from anywhere would otherwise report whatever repo it happened to sit
   in.
3. `"unknown"` — never raises. A stamping mechanism that can crash a worker is
   worse than the drift it reports.
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

UNKNOWN = "unknown"


def _from_git() -> str | None:
    try:
        out = subprocess.run(
            ["git", "-C", str(Path(__file__).resolve().parent), "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=5, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    sha = out.stdout.strip()
    return sha or None


def code_version() -> str:
    """The commit this process is running, or 'unknown'."""
    env = (os.getenv("CODE_VERSION") or "").strip()
    if env:
        return env
    return _from_git() or UNKNOWN


def expected_version() -> str | None:
    """Operator-pinned commit, if any (`EXPECTED_CODE_VERSION`)."""
    want = (os.getenv("EXPECTED_CODE_VERSION") or "").strip()
    return want or None


def version_mismatch() -> str | None:
    """Message describing a pin violation, or None when free to run.

    Matching is by prefix so a pin can be a short SHA. An unresolvable version
    is treated as a mismatch when a pin is set: "I could not tell you what I am
    running" is exactly the state that caused #379, so it must not pass a check
    whose whole purpose is to catch it.
    """
    want = expected_version()
    if not want:
        return None
    have = code_version()
    if have != UNKNOWN and (have.startswith(want) or want.startswith(have)):
        return None
    return (
        f"EXPECTED_CODE_VERSION={want} but this executor is running {have}. "
        f"Refusing to claim work: an executor that cannot prove its version is "
        f"how issue #379 went unnoticed for five weeks. Update the checkout (or "
        f"the image tag), or clear EXPECTED_CODE_VERSION to run unpinned."
    )
