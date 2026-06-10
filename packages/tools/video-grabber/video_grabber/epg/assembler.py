"""
EPG assembler — builds 24-hour per-channel HLS playlists and EPG JSON.

Each call to assemble_day() returns:
  - playlists: dict with keys 'master', 'full', 'mid', 'thumb'
  - epg_channel: dict matching EPGChannel[] contract from EPG.tsx

Gap logic ported from packages/backend/gen-epg.mjs:65-101.
Every slot boundary gets #EXT-X-DISCONTINUITY + absolute #EXT-X-MAP URL.
"""
from datetime import datetime, date, timedelta, timezone
from typing import Optional

WASABI_BASE = "https://files.911realtime.org"
REND_NAMES = ["full", "mid", "thumb"]
REND_BANDWIDTHS = {"full": 2628000, "mid": 396000, "thumb": 136000}
REND_RESOLUTIONS = {"full": "854x480", "mid": "320x240", "thumb": "160x120"}

_SEGMENT_DURATION = 6  # seconds per fMP4 segment


def assemble_day(
    channel,
    day: date,
    db,
    *,
    slots: Optional[list] = None,
) -> tuple[dict[str, str], dict]:
    """
    Build 24-hour HLS playlists and EPG JSON for channel on day.

    slots: pre-fetched list (for testing); if None, fetched from db.
    Returns (playlists, epg_channel_dict).
    """
    if slots is None:
        slots = _fetch_slots(db, channel.id, day)

    window_start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    window_end = window_start + timedelta(days=1)
    yyyymmdd = day.strftime("%Y%m%d")
    gap_prefix = f"{WASABI_BASE}/hls/{channel.slug}/{yyyymmdd}/_gap"

    rend_lines: dict[str, list[str]] = {
        r: [
            "#EXTM3U",
            "#EXT-X-VERSION:7",
            "#EXT-X-TARGETDURATION:6",
            "#EXT-X-PLAYLIST-TYPE:VOD",
            "#EXT-X-INDEPENDENT-SEGMENTS",
        ]
        for r in REND_NAMES
    }
    epg_grid: list[dict] = []
    cursor = window_start

    for slot in slots:
        if slot.starts_at > cursor:
            gap_secs = int((slot.starts_at - cursor).total_seconds())
            _append_gap(rend_lines, gap_secs, gap_prefix)
            epg_grid.append({
                "title": "[No Signal]",
                "start": cursor.isoformat(),
                "end": slot.starts_at.isoformat(),
            })

        slot_prefix = (
            f"{WASABI_BASE}/hls/{channel.slug}/{yyyymmdd}/{slot.program.ia_identifier}"
        )
        _append_slot(rend_lines, slot, slot_prefix)
        epg_grid.append({
            "title": slot.program.title,
            "description": slot.program.description,
            "fullTitle": slot.program.ia_identifier,
            "start": slot.starts_at.isoformat(),
            "end": slot.ends_at.isoformat(),
        })
        cursor = slot.ends_at

    if cursor < window_end:
        gap_secs = int((window_end - cursor).total_seconds())
        _append_gap(rend_lines, gap_secs, gap_prefix)
        epg_grid.append({
            "title": "[No Signal]",
            "start": cursor.isoformat(),
            "end": window_end.isoformat(),
        })

    for r in REND_NAMES:
        rend_lines[r].append("#EXT-X-ENDLIST")

    day_prefix = f"{WASABI_BASE}/epg/{channel.slug}/{yyyymmdd}"
    master_lines = ["#EXTM3U", "#EXT-X-INDEPENDENT-SEGMENTS"]
    for r in REND_NAMES:
        master_lines += [
            f"#EXT-X-STREAM-INF:BANDWIDTH={REND_BANDWIDTHS[r]},RESOLUTION={REND_RESOLUTIONS[r]}",
            f"{day_prefix}/{r}.m3u8",
        ]

    epg_channel = {
        "name": channel.display_name,
        "number": "",
        "callSign": channel.slug.upper(),
        "location": "",
        "icon": channel.slug,
        "grid": epg_grid,
    }

    playlists = {"master": "\n".join(master_lines) + "\n"}
    playlists.update({r: "\n".join(rend_lines[r]) + "\n" for r in REND_NAMES})
    return playlists, epg_channel


def _append_gap(rend_lines: dict, gap_secs: int, gap_prefix: str) -> None:
    n_segs, remainder = divmod(gap_secs, _SEGMENT_DURATION)
    for r in REND_NAMES:
        rend_lines[r].append("#EXT-X-DISCONTINUITY")
        rend_lines[r].append(f'#EXT-X-MAP:URI="{gap_prefix}/{r}/init.mp4"')
        for _ in range(n_segs):
            rend_lines[r].append(f"#EXTINF:{_SEGMENT_DURATION},")
            rend_lines[r].append(f"{gap_prefix}/{r}/seg_gap_{_SEGMENT_DURATION}s.m4s")
        if remainder:
            rend_lines[r].append(f"#EXTINF:{remainder},")
            rend_lines[r].append(f"{gap_prefix}/{r}/seg_gap_{remainder}s.m4s")


def _append_slot(rend_lines: dict, slot, slot_prefix: str) -> None:
    slot_secs = int((slot.ends_at - slot.starts_at).total_seconds())
    n_segs, remainder = divmod(slot_secs, _SEGMENT_DURATION)
    for r in REND_NAMES:
        rend_lines[r].append("#EXT-X-DISCONTINUITY")
        rend_lines[r].append(f'#EXT-X-MAP:URI="{slot_prefix}/{r}/init.mp4"')
        for i in range(n_segs):
            rend_lines[r].append(f"#EXTINF:{_SEGMENT_DURATION},")
            rend_lines[r].append(f"{slot_prefix}/{r}/seg{i:04d}.m4s")
        if remainder:
            rend_lines[r].append(f"#EXTINF:{remainder},")
            rend_lines[r].append(f"{slot_prefix}/{r}/seg{n_segs:04d}.m4s")


def _fetch_slots(db, channel_id: str, day: date) -> list:
    window_start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    window_end = window_start + timedelta(days=1)
    from sqlalchemy import text
    result = db.execute(
        text(
            "SELECT * FROM schedule_slots "
            "WHERE channel_id = :cid AND starts_at >= :ws AND ends_at <= :we "
            "ORDER BY starts_at"
        ),
        {"cid": str(channel_id), "ws": window_start, "we": window_end},
    )
    return result.fetchall()
