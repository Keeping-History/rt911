"""
EPG assembler — builds continuous per-channel HLS playlists and EPG JSON.

``assemble_range()`` stitches every scheduled program for a channel across an
arbitrary UTC window (e.g. Sep 9 → Sep 18) into a single VOD playlist per
rendition, with gaps filled by the blue ``_gap`` package so the media timeline
stays **isochronous** with wall-clock: one real second == one media second.
That invariant is what lets the player seek to any instant with a single
subtraction — ``currentTime = (wallClock - window_start) / 1000`` — and it is
re-anchored at every splice by an absolute ``#EXT-X-PROGRAM-DATE-TIME`` tag.

``assemble_day()`` is the 24-hour special case, kept for the existing EPG grid.

Each call returns:
  - playlists: dict with keys 'master', 'full', 'mid', 'thumb'
  - epg_channel: dict matching EPGChannel[] contract from EPG.tsx

Gap logic ported from packages/backend/gen-epg.mjs:65-101.
Every slot boundary gets #EXT-X-DISCONTINUITY + absolute #EXT-X-MAP URL +
#EXT-X-PROGRAM-DATE-TIME.
"""
import posixpath
from datetime import datetime, date, timedelta, timezone
from types import SimpleNamespace
from typing import Optional

WASABI_BASE = "https://files.911realtime.org"
REND_NAMES = ["full", "mid", "thumb"]
REND_BANDWIDTHS = {"full": 2628000, "mid": 396000, "thumb": 136000}
REND_RESOLUTIONS = {"full": "854x480", "mid": "320x240", "thumb": "160x120"}

_SEGMENT_DURATION = 6  # seconds per fMP4 segment


def assemble_range(
    channel,
    window_start: datetime,
    window_end: datetime,
    db,
    *,
    slots: Optional[list] = None,
) -> tuple[dict[str, str], dict]:
    """
    Build continuous HLS playlists and EPG JSON for ``channel`` across
    ``[window_start, window_end)``.

    slots: pre-fetched list (for testing); if None, fetched from db.
    Returns (playlists, epg_channel_dict).

    The published playlist URL is channel-level (``playlists/<slug>/``) because the
    product serves one continuous stream per channel, regenerated in place as
    more content is acquired. The blue gap package is likewise channel-level
    (``hls/<slug>/_gap``) — its content is date-independent.
    """
    if slots is None:
        slots = _fetch_slots(db, channel.id, window_start, window_end)

    gap_prefix = f"{WASABI_BASE}/hls/{channel.slug}/_gap"

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
            _append_gap(rend_lines, cursor, gap_secs, gap_prefix)
            epg_grid.append({
                "title": "[No Signal]",
                "start": cursor.isoformat(),
                "end": slot.starts_at.isoformat(),
            })

        # Segments live at their original upload location (storage/wasabi.py),
        # which is keyed by the channel slug *at encode time*. That slug can
        # later change when a program is reassigned to its correct channel, so
        # path the segments from the authoritative stored upload key — otherwise
        # every reassigned program points at a dead URL under the new slug. Fall
        # back to reconstructing from the current slug when no key is recorded
        # (e.g. unit tests that hand-build slots).
        seg_base = getattr(slot.program, "segment_base", None)
        if isinstance(seg_base, str) and seg_base:
            slot_prefix = f"{WASABI_BASE}/{seg_base}"
        else:
            slot_yyyymmdd = slot.starts_at.strftime("%Y%m%d")
            slot_prefix = (
                f"{WASABI_BASE}/hls/{channel.slug}/{slot_yyyymmdd}/{slot.program.ia_identifier}"
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
        _append_gap(rend_lines, cursor, gap_secs, gap_prefix)
        epg_grid.append({
            "title": "[No Signal]",
            "start": cursor.isoformat(),
            "end": window_end.isoformat(),
        })

    for r in REND_NAMES:
        rend_lines[r].append("#EXT-X-ENDLIST")

    channel_prefix = f"{WASABI_BASE}/playlists/{channel.slug}"
    master_lines = ["#EXTM3U", "#EXT-X-INDEPENDENT-SEGMENTS"]
    for r in REND_NAMES:
        master_lines += [
            f"#EXT-X-STREAM-INF:BANDWIDTH={REND_BANDWIDTHS[r]},RESOLUTION={REND_RESOLUTIONS[r]}",
            f"{channel_prefix}/{r}.m3u8",
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


def assemble_day(
    channel,
    day: date,
    db,
    *,
    slots: Optional[list] = None,
) -> tuple[dict[str, str], dict]:
    """24-hour special case of :func:`assemble_range` (one UTC midnight-to-midnight day)."""
    window_start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    window_end = window_start + timedelta(days=1)
    return assemble_range(channel, window_start, window_end, db, slots=slots)


def _append_gap(rend_lines: dict, gap_start: datetime, gap_secs: int, gap_prefix: str) -> None:
    n_segs, remainder = divmod(gap_secs, _SEGMENT_DURATION)
    for r in REND_NAMES:
        rend_lines[r].append("#EXT-X-DISCONTINUITY")
        rend_lines[r].append(f'#EXT-X-MAP:URI="{gap_prefix}/{r}/init.mp4"')
        rend_lines[r].append(f"#EXT-X-PROGRAM-DATE-TIME:{gap_start.isoformat()}")
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
        rend_lines[r].append(f"#EXT-X-PROGRAM-DATE-TIME:{slot.starts_at.isoformat()}")
        for i in range(n_segs):
            rend_lines[r].append(f"#EXTINF:{_SEGMENT_DURATION},")
            rend_lines[r].append(f"{slot_prefix}/{r}/seg{i:04d}.m4s")
        if remainder:
            rend_lines[r].append(f"#EXTINF:{remainder},")
            rend_lines[r].append(f"{slot_prefix}/{r}/seg{n_segs:04d}.m4s")


def _fetch_slots(db, channel_id: str, window_start: datetime, window_end: datetime) -> list:
    """Load the channel's in-window slots joined to their program.

    A bare ``SELECT *`` only carries ``program_id``; the assembler dereferences
    ``slot.program.ia_identifier`` / ``.title`` / ``.description``, so the row
    must be reshaped into the nested namespace those accesses expect (the same
    pattern ``flows.get_job`` uses for its channel/program relationships).
    """
    from sqlalchemy import text
    # Pull the program's actual upload key via a scalar subquery (rather than a
    # JOIN) so a program with more than one video_jobs row can't multiply the
    # slot into duplicate segments. Newest uploaded key wins.
    rows = db.execute(
        text(
            "SELECT s.starts_at, s.ends_at, "
            "       p.ia_identifier, p.title, p.description, "
            "       (SELECT v.wasabi_key FROM video_jobs v "
            "        WHERE v.program_id = p.id AND v.wasabi_key IS NOT NULL "
            "        ORDER BY v.last_transition_at DESC LIMIT 1) AS wasabi_key "
            "FROM schedule_slots s "
            "JOIN programs p ON p.id = s.program_id "
            "WHERE s.channel_id = :cid AND s.starts_at >= :ws AND s.ends_at <= :we "
            "ORDER BY s.starts_at"
        ),
        {"cid": str(channel_id), "ws": window_start, "we": window_end},
    ).mappings().all()
    return [
        SimpleNamespace(
            starts_at=r["starts_at"],
            ends_at=r["ends_at"],
            program=SimpleNamespace(
                ia_identifier=r["ia_identifier"],
                title=r["title"],
                description=r["description"],
                segment_base=_segment_base(r["wasabi_key"]),
            ),
        )
        for r in rows
    ]


def _segment_base(wasabi_key: Optional[str]) -> Optional[str]:
    """The directory holding a program's rendition folders, taken from its
    stored upload key (e.g.
    ``hls/king/20010911/CNN_..._Larry_King_Live/master.m3u8`` ->
    ``hls/king/20010911/CNN_..._Larry_King_Live``).

    This is the *actual* upload location — keyed by the channel slug at encode
    time — and stays correct after a program is reassigned to a different
    channel, where ``channel.slug`` no longer matches the stored path.
    """
    if not wasabi_key:
        return None
    return posixpath.dirname(wasabi_key)
