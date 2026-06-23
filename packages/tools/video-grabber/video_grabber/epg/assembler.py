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
    cfg=None,
    gap_durations: Optional[dict[int, float]] = None,
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

    ``cfg`` / ``gap_durations`` enable *accurate* ``#EXTINF``: with ``cfg`` the
    assembler reads each program's real per-segment durations from its uploaded
    ``index.m3u8``; ``gap_durations`` (from :func:`gap_filler.gap_segment_durations`)
    gives the blue tiles' true sub-second lengths. When both are absent the
    assembler falls back to a synthesized integer-second timeline (the legacy
    behaviour the unit tests exercise). Honest ``#EXTINF`` keeps a player that
    advances by sample timestamps (AVFoundation/QuickTime) locked to the
    playlist timeline instead of creeping ahead by ~0.5 % of all dead air.
    """
    if slots is None:
        slots = _fetch_slots(db, channel.id, window_start, window_end)

    s3 = None
    if cfg is not None:
        from video_grabber.storage.wasabi import _make_s3_client
        s3 = _make_s3_client(cfg)
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
            gap_secs = (slot.starts_at - cursor).total_seconds()
            _append_gap(rend_lines, cursor, gap_secs, gap_prefix, gap_durations)
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
        program_segs = None
        if isinstance(seg_base, str) and seg_base:
            slot_prefix = f"{WASABI_BASE}/{seg_base}"
            if cfg is not None:
                program_segs = _program_segments(seg_base, cfg, s3)
        else:
            slot_yyyymmdd = slot.starts_at.strftime("%Y%m%d")
            slot_prefix = (
                f"{WASABI_BASE}/hls/{channel.slug}/{slot_yyyymmdd}/{slot.program.ia_identifier}"
            )
        filled = _append_slot(rend_lines, slot, slot_prefix, program_segs)
        # The slot's wall-clock span is sized from the source .mpg probe, which
        # over-reports vs the actual encoded HLS, so a program's real segments
        # can fall short of the slot. Blue-pad the shortfall to keep cumulative
        # #EXTINF equal to wall-clock (the legacy integer path "filled" it with
        # segment URLs that 404). Only the accurate path under-fills; the
        # integer fallback already covers the whole span.
        slot_secs = (slot.ends_at - slot.starts_at).total_seconds()
        pad = slot_secs - filled
        if pad > 1.0:
            _append_gap(
                rend_lines, slot.starts_at + timedelta(seconds=filled),
                pad, gap_prefix, gap_durations,
            )
        epg_grid.append({
            "title": slot.program.title,
            "description": slot.program.description,
            "fullTitle": slot.program.ia_identifier,
            "start": slot.starts_at.isoformat(),
            "end": slot.ends_at.isoformat(),
        })
        cursor = slot.ends_at

    if cursor < window_end:
        gap_secs = (window_end - cursor).total_seconds()
        _append_gap(rend_lines, cursor, gap_secs, gap_prefix, gap_durations)
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
    cfg=None,
    gap_durations: Optional[dict[int, float]] = None,
) -> tuple[dict[str, str], dict]:
    """24-hour special case of :func:`assemble_range` (one UTC midnight-to-midnight day)."""
    window_start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    window_end = window_start + timedelta(days=1)
    return assemble_range(
        channel, window_start, window_end, db,
        slots=slots, cfg=cfg, gap_durations=gap_durations,
    )


def _fmt(secs: float) -> str:
    """Format an ``#EXTINF`` duration to millisecond precision, trimming
    trailing zeros so whole values render bare (6.0 -> "6", legacy-identical)
    and real fractional durations stay readable (6.006006 -> "6.006")."""
    return f"{secs:.3f}".rstrip("0").rstrip(".")


def _append_gap(
    rend_lines: dict, gap_start: datetime, gap_secs: float, gap_prefix: str,
    gap_durations: Optional[dict[int, float]] = None,
) -> None:
    tiles = _plan_gap_tiles(gap_secs, gap_durations)
    for r in REND_NAMES:
        rend_lines[r].append("#EXT-X-DISCONTINUITY")
        rend_lines[r].append(f'#EXT-X-MAP:URI="{gap_prefix}/{r}/init.mp4"')
        rend_lines[r].append(f"#EXT-X-PROGRAM-DATE-TIME:{gap_start.isoformat()}")
        for label, dur in tiles:
            rend_lines[r].append(f"#EXTINF:{_fmt(dur)},")
            rend_lines[r].append(f"{gap_prefix}/{r}/seg_gap_{label}s.m4s")


def _plan_gap_tiles(
    gap_secs: float, gap_durations: Optional[dict[int, float]]
) -> list[tuple[int, float]]:
    """Choose blue tiles to fill a gap, returning ``(label_secs, extinf)`` pairs.

    Legacy (``gap_durations is None``): exact integer fill — ⌊G/6⌋ six-second
    tiles plus one remainder — labelled at their nominal seconds, so the
    timeline stays integer-isochronous for the unit tests.

    Accurate: tiles are really ~6.029 s, so size the fill by *real* duration
    (⌊G / real_6s⌋ tiles) and pick the single remainder tile whose real length
    best closes the leftover. ``#EXTINF`` carries the true durations, so the sum
    tracks wall-clock to within half a tile with no systematic per-tile bias.
    """
    if not gap_durations:
        n_segs, remainder = divmod(int(gap_secs), _SEGMENT_DURATION)
        tiles = [(_SEGMENT_DURATION, float(_SEGMENT_DURATION))] * n_segs
        if remainder:
            tiles.append((remainder, float(remainder)))
        return tiles

    d6 = gap_durations.get(_SEGMENT_DURATION, float(_SEGMENT_DURATION))
    n_segs = int(gap_secs // d6)
    tiles = [(_SEGMENT_DURATION, d6)] * n_segs
    remaining = gap_secs - n_segs * d6
    best_label, best_err = None, abs(remaining)
    for label, real in sorted(gap_durations.items()):
        if label == _SEGMENT_DURATION:
            continue
        if abs(real - remaining) < best_err:
            best_err, best_label = abs(real - remaining), label
    if best_label is not None:
        tiles.append((best_label, gap_durations[best_label]))
    return tiles


def _append_slot(
    rend_lines: dict, slot, slot_prefix: str,
    program_segs: Optional[list[tuple[str, float]]] = None,
) -> float:
    """Append a program slot's segments, returning the wall-clock seconds filled
    (so the caller can blue-pad any shortfall to the slot's span)."""
    slot_secs = (slot.ends_at - slot.starts_at).total_seconds()
    emitted = _clip_program_segments(program_segs, slot_secs) if program_segs else None

    if emitted:
        for r in REND_NAMES:
            rend_lines[r].append("#EXT-X-DISCONTINUITY")
            rend_lines[r].append(f'#EXT-X-MAP:URI="{slot_prefix}/{r}/init.mp4"')
            rend_lines[r].append(f"#EXT-X-PROGRAM-DATE-TIME:{slot.starts_at.isoformat()}")
            for name, dur in emitted:
                rend_lines[r].append(f"#EXTINF:{_fmt(dur)},")
                rend_lines[r].append(f"{slot_prefix}/{r}/{name}")
        return sum(dur for _, dur in emitted)

    # Fallback: synthesize an integer-second layout from the slot duration. Used
    # in tests (no cfg) and when a program's index.m3u8 can't be read.
    n_segs, remainder = divmod(int(slot_secs), _SEGMENT_DURATION)
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
    return float(n_segs * _SEGMENT_DURATION + remainder)


def _clip_program_segments(
    program_segs: list[tuple[str, float]], slot_secs: float
) -> list[tuple[str, float]]:
    """Emit real segments filling the slot's wall-clock span *exactly*.

    Whole segments are emitted at their true ``#EXTINF`` until the next one
    would overrun the slot; that final segment's ``#EXTINF`` is then clipped to
    land the program's total on ``slot_secs`` to the millisecond (the file still
    holds its full ~6 s of frames — only the timeline duration is trimmed). This
    keeps cumulative ``#EXTINF`` equal to wall-clock at every program boundary,
    so a pure-``#EXTINF`` player's elapsed time matches the burned-in clock with
    no per-program accumulation. A slot the scheduler clipped for overlap (span
    ≪ program) simply stops early; the residual under-fill (program shorter than
    its slot) is under one segment and re-anchored by the next ``PROGRAM-DATE-TIME``."""
    emitted: list[tuple[str, float]] = []
    cum = 0.0
    for name, dur in program_segs:
        remaining = slot_secs - cum
        if remaining <= 1e-6:
            break
        if dur <= remaining + 1e-6:
            emitted.append((name, dur))
            cum += dur
        else:
            emitted.append((name, remaining))  # clip final segment to fill slot
            break
    return emitted


def _program_segments(seg_base: str, cfg, s3) -> Optional[list[tuple[str, float]]]:
    """Real ``(segment_name, duration)`` pairs from a program's uploaded
    ``index.m3u8`` (the ``full`` rendition is authoritative — every rendition
    shares segment timing). Returns None if the playlist can't be read or
    parsed, so the caller falls back to the synthesized layout. Renditions all
    use the same segment filenames, so these durations apply to each."""
    from video_grabber.storage.wasabi import read_text

    try:
        text = read_text(f"{seg_base}/full/index.m3u8", cfg, s3=s3)
    except Exception:
        return None

    segs: list[tuple[str, float]] = []
    dur: Optional[float] = None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("#EXTINF:"):
            try:
                dur = float(line.split(":", 1)[1].rstrip(","))
            except ValueError:
                dur = None
        elif line and not line.startswith("#"):
            if dur is not None:
                segs.append((line.rsplit("/", 1)[-1], dur))
            dur = None
    return segs or None


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
