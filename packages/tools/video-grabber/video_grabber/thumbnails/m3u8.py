"""Parse HLS thumb playlists to find the segment URL for a given virtual time.

Playlists emit ``#EXT-X-PROGRAM-DATE-TIME`` at every slot boundary
(program or gap splice). Between boundaries, segment start times are
computed by accumulating ``#EXTINF`` durations. All 6-second segments.
"""
from datetime import datetime, timedelta, timezone

import httpx


def _find_segment_in_playlist(playlist_text: str, virtual_time: datetime) -> str | None:
    """Return the segment URL whose time window contains ``virtual_time``, or None.

    Handles multiple ``#EXT-X-PROGRAM-DATE-TIME`` anchors separated by
    ``#EXT-X-DISCONTINUITY`` tags by resetting elapsed time at each anchor.
    Segment URLs may be absolute or relative (caller resolves relative ones).
    """
    vt = virtual_time.astimezone(timezone.utc)
    current_dt: datetime | None = None
    elapsed = 0.0
    pending_extinf: float | None = None

    for raw in playlist_text.splitlines():
        line = raw.strip()
        if line.startswith("#EXT-X-PROGRAM-DATE-TIME:"):
            ts = line.split(":", 1)[1]
            current_dt = datetime.fromisoformat(ts).astimezone(timezone.utc)
            elapsed = 0.0
            pending_extinf = None
        elif line.startswith("#EXTINF:"):
            duration = float(line[8:].split(",")[0])
            if current_dt is not None:
                seg_start = current_dt + timedelta(seconds=elapsed)
                if seg_start <= vt < seg_start + timedelta(seconds=duration):
                    pending_extinf = duration
            if current_dt is not None:
                elapsed += duration
        elif line and not line.startswith("#"):
            if pending_extinf is not None:
                return line  # absolute or relative URL
            pending_extinf = None  # reset for next segment

    return None


def find_thumb_segment(
    master_url: str,
    virtual_time: datetime,
    *,
    client=httpx,
) -> str | None:
    """Download the thumb variant playlist and return the segment URL for ``virtual_time``.

    Derives the thumb playlist URL from the master URL by replacing
    ``master.m3u8`` with ``thumb/playlist.m3u8``. Returns None if the
    request fails or no segment covers the given time.
    """
    thumb_url = master_url.replace("master.m3u8", "thumb/playlist.m3u8")
    try:
        resp = client.get(thumb_url, timeout=10)
        resp.raise_for_status()
    except Exception:
        return None
    return _find_segment_in_playlist(resp.text, virtual_time)
