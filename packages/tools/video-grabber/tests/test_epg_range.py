"""
Tests for assemble_range — the continuous multi-day per-channel stitcher and
its #EXT-X-PROGRAM-DATE-TIME wall-clock anchoring.
"""
from datetime import datetime, timezone, timedelta
from unittest.mock import MagicMock

from video_grabber.epg.assembler import assemble_range, REND_NAMES


def make_channel(slug="cnn", display_name="CNN"):
    ch = MagicMock()
    ch.id = "chan-001"
    ch.slug = slug
    ch.display_name = display_name
    return ch


def make_slot(ia_id, starts_at, duration_sec, title="News"):
    prog = MagicMock()
    prog.ia_identifier = ia_id
    prog.title = title
    prog.description = "Desc"
    slot = MagicMock()
    slot.starts_at = starts_at
    slot.ends_at = starts_at + timedelta(seconds=duration_sec)
    slot.program = prog
    return slot


# Sep 9 -> Sep 18 window, the real product timeline.
WINDOW_START = datetime(2001, 9, 9, 0, 0, tzinfo=timezone.utc)
WINDOW_END = datetime(2001, 9, 18, 0, 0, tzinfo=timezone.utc)
WINDOW_SECS = int((WINDOW_END - WINDOW_START).total_seconds())  # 9 days


def _count_playlist_duration(content: str) -> int:
    total = 0
    for line in content.splitlines():
        if line.startswith("#EXTINF:"):
            total += round(float(line.split(":")[1].rstrip(",")))
    return total


def test_multiday_window_is_isochronous():
    """Total media duration must equal the wall-clock window exactly — the
    invariant that makes currentTime = (wallClock - window_start) exact."""
    ch = make_channel()
    # Two programs on different days, gaps everywhere else.
    slots = [
        make_slot("prog-a", datetime(2001, 9, 11, 12, 30, tzinfo=timezone.utc), 1800),
        make_slot("prog-b", datetime(2001, 9, 14, 9, 0, tzinfo=timezone.utc), 3600),
    ]
    playlists, _ = assemble_range(ch, WINDOW_START, WINDOW_END, None, slots=slots)
    for r in REND_NAMES:
        assert _count_playlist_duration(playlists[r]) == WINDOW_SECS


def test_program_date_time_present_per_slot_and_gap():
    ch = make_channel()
    slots = [make_slot("prog-a", datetime(2001, 9, 11, 12, 30, tzinfo=timezone.utc), 1800)]
    playlists, _ = assemble_range(ch, WINDOW_START, WINDOW_END, None, slots=slots)
    full = playlists["full"]
    # Leading gap PDT (window start), the slot PDT, and trailing gap PDT.
    assert "#EXT-X-PROGRAM-DATE-TIME:2001-09-09T00:00:00+00:00" in full
    assert "#EXT-X-PROGRAM-DATE-TIME:2001-09-11T12:30:00+00:00" in full


def test_program_date_time_follows_each_discontinuity():
    """Every discontinuity must be immediately re-anchored by a PDT, else the
    player cannot map wall-clock across the PTS reset."""
    ch = make_channel()
    slots = [make_slot("prog-a", datetime(2001, 9, 11, 12, 30, tzinfo=timezone.utc), 1800)]
    playlists, _ = assemble_range(ch, WINDOW_START, WINDOW_END, None, slots=slots)
    for r in REND_NAMES:
        lines = [ln for ln in playlists[r].splitlines()
                 if ln.startswith("#EXT-X-DISCONTINUITY") or ln.startswith("#EXT-X-PROGRAM-DATE-TIME")]
        # Pair up: each DISCONTINUITY (after its MAP) is followed by a PDT.
        disc = sum(1 for ln in lines if ln == "#EXT-X-DISCONTINUITY")
        pdt = sum(1 for ln in lines if ln.startswith("#EXT-X-PROGRAM-DATE-TIME"))
        assert disc == pdt, f"{r}: {disc} discontinuities but {pdt} PDT tags"


def test_slot_segment_url_uses_program_air_date_not_window():
    """A program airing Sep 11 must reference hls/<slug>/20010911/... even though
    the window starts Sep 9 — matching the uploader's per-air-date layout."""
    ch = make_channel("cnn")
    slots = [make_slot("prog-a", datetime(2001, 9, 11, 12, 30, tzinfo=timezone.utc), 1800)]
    playlists, _ = assemble_range(ch, WINDOW_START, WINDOW_END, None, slots=slots)
    assert "/cnn/20010911/prog-a/full/" in playlists["full"]


def test_gap_package_is_channel_level():
    ch = make_channel("cnn")
    playlists, _ = assemble_range(ch, WINDOW_START, WINDOW_END, None, slots=[])
    # Empty window => one big gap, referencing the date-independent _gap package.
    assert "/hls/cnn/_gap/full/" in playlists["full"]
    assert _count_playlist_duration(playlists["full"]) == WINDOW_SECS


def test_master_url_is_channel_level():
    ch = make_channel("cnn")
    playlists, _ = assemble_range(ch, WINDOW_START, WINDOW_END, None, slots=[])
    assert "/epg/cnn/full.m3u8" in playlists["master"]
    assert playlists["master"].count("EXT-X-STREAM-INF") == 3
