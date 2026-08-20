"""Detect whether this process is running under macOS background QoS.

A launchd agent declared `<key>ProcessType</key><string>Background</string>` is
throttled by macOS across CPU, I/O and GPU. The transcribe workers shipped that
way, which was survivable until whisper gained `--vad` — VAD loads a second model
and takes an ANE/CoreML path that stalls outright under throttling. The result was
not a slowdown but a hang: worker alive, heartbeat firing, main thread parked in
kevent, no whisper or ffmpeg child, 25+ minutes on a 30-second clip. Changing the
one word to `Standard` took throughput from 6 files/hour to 108.

Nothing in the pipeline could see this. Every component timed fast in isolation and
the only way to find it was to run the same worker outside launchd and notice it
finished in seconds. That is too subtle to rediscover, so the worker asserts it at
startup instead.

The signal is `getpriority(PRIO_DARWIN_PROCESS, 0)`: 0 for a normal process, 1 for
one in background state. Note that the ordinary nice value stays 0 in both cases,
so `os.getpriority(os.PRIO_PROCESS, …)` cannot be used for this.
"""
from __future__ import annotations

import ctypes
import sys

# <sys/resource.h>. Not exposed by Python's os module, which only wraps
# PRIO_PROCESS / PRIO_PGRP / PRIO_USER.
_PRIO_DARWIN_PROCESS = 4


def darwin_background_qos(*, platform: str | None = None, libc=None) -> bool | None:
    """True if throttled, False if not, None if the question does not apply.

    None is returned off macOS (the cluster runs Linux, where this policy does not
    exist) and whenever libc cannot be loaded or the call fails — an unanswerable
    check must not be read as "throttled" and take a healthy worker down.
    """
    if (platform or sys.platform) != "darwin":
        return None
    try:
        libc = libc or ctypes.CDLL("libc.dylib", use_errno=True)
        ctypes.set_errno(0)
        value = libc.getpriority(_PRIO_DARWIN_PROCESS, 0)
        if ctypes.get_errno() != 0:
            return None
    except (OSError, AttributeError):
        return None
    return value == 1


THROTTLED_MESSAGE = (
    "refusing to start: this process is under macOS background QoS "
    "(getpriority(PRIO_DARWIN_PROCESS) == 1), which throttles CPU, I/O and GPU. "
    "whisper --vad stalls indefinitely under it — the worker stays alive and "
    "heartbeats while never finishing a job, so it holds claims instead of "
    "failing them. Set <key>ProcessType</key><string>Standard</string> in the "
    "LaunchAgent plist and reload it. Override with ALLOW_THROTTLED_WORKER=1."
)
