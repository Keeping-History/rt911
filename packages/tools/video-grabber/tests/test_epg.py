"""
Tests for EPG assembler — 24-hour playlist builder and EPG JSON output.
"""
from datetime import datetime, timezone, timedelta, date
from unittest.mock import MagicMock


from video_grabber.epg.assembler import assemble_day, REND_NAMES


def make_channel(slug="cnn", display_name="CNN"):
    ch = MagicMock()
    ch.id = "chan-001"
    ch.slug = slug
    ch.display_name = display_name
    return ch


def make_slot(
    ia_identifier,
    starts_at: datetime,
    duration_seconds: int,
    title="Program Title",
    description="Description",
    is_gap=False,
):
    program = MagicMock()
    program.ia_identifier = ia_identifier
    program.title = title
    program.description = description

    slot = MagicMock()
    slot.starts_at = starts_at
    slot.ends_at = starts_at + timedelta(seconds=duration_seconds)
    slot.program = program
    slot.is_gap = is_gap
    return slot


def get_slots_for_full_day():
    """A channel with three programs covering 8h each, filling 24h exactly."""
    base = datetime(2001, 9, 11, 0, 0, tzinfo=timezone.utc)
    return [
        make_slot("prog-a", base, 8 * 3600, "Morning News"),
        make_slot("prog-b", base + timedelta(hours=8), 8 * 3600, "Afternoon News"),
        make_slot("prog-c", base + timedelta(hours=16), 8 * 3600, "Evening News"),
    ]


def get_slots_with_gaps():
    """Two programs with gaps at start, middle, and end."""
    base = datetime(2001, 9, 11, 0, 0, tzinfo=timezone.utc)
    return [
        make_slot("prog-a", base + timedelta(hours=2), 4 * 3600, "Morning"),
        make_slot("prog-b", base + timedelta(hours=10), 6 * 3600, "Afternoon"),
    ]


# --- 24-hour coverage ---

def test_full_day_coverage_exactly_86400_seconds():
    ch = make_channel()
    slots = get_slots_for_full_day()
    db = MagicMock()

    playlists, _ = assemble_day(ch, date(2001, 9, 11), db, slots=slots)

    for rend in REND_NAMES:
        content = playlists[rend]
        total = _count_playlist_duration(content)
        assert total == 86400, f"{rend}: expected 86400s, got {total}s"


def test_day_with_gaps_still_covers_86400():
    ch = make_channel()
    slots = get_slots_with_gaps()
    db = MagicMock()

    playlists, _ = assemble_day(ch, date(2001, 9, 11), db, slots=slots)

    for rend in REND_NAMES:
        total = _count_playlist_duration(playlists[rend])
        assert total == 86400, f"{rend}: expected 86400s, got {total}s"


def test_empty_day_fills_with_gap():
    """A day with no programs should be one 86400-second gap."""
    ch = make_channel()
    db = MagicMock()

    playlists, epg = assemble_day(ch, date(2001, 9, 11), db, slots=[])

    for rend in REND_NAMES:
        total = _count_playlist_duration(playlists[rend])
        assert total == 86400

    assert epg["grid"][0]["title"] == "[No Signal]"


# --- Playlist structure ---

def test_rendition_playlists_have_discontinuity_tags():
    ch = make_channel()
    slots = get_slots_with_gaps()
    db = MagicMock()

    playlists, _ = assemble_day(ch, date(2001, 9, 11), db, slots=slots)

    for rend in REND_NAMES:
        assert "EXT-X-DISCONTINUITY" in playlists[rend]


def test_rendition_playlists_have_ext_x_map_tags():
    ch = make_channel()
    slots = get_slots_for_full_day()
    db = MagicMock()

    playlists, _ = assemble_day(ch, date(2001, 9, 11), db, slots=slots)

    for rend in REND_NAMES:
        assert "EXT-X-MAP" in playlists[rend]


def test_slot_map_uses_rendition_specific_url():
    ch = make_channel("cnn")
    base = datetime(2001, 9, 11, 0, 0, tzinfo=timezone.utc)
    slots = [make_slot("prog-a", base, 86400)]
    db = MagicMock()

    playlists, _ = assemble_day(ch, date(2001, 9, 11), db, slots=slots)

    # full rendition playlist must reference full/ init URL
    assert "/full/init.mp4" in playlists["full"]
    assert "/mid/init.mp4" in playlists["mid"]
    assert "/thumb/init.mp4" in playlists["thumb"]


def test_gap_map_uses_rendition_specific_url():
    ch = make_channel("cnn")
    base = datetime(2001, 9, 11, 2, 0, tzinfo=timezone.utc)  # gap at start
    slots = [make_slot("prog-a", base, 22 * 3600)]
    db = MagicMock()

    playlists, _ = assemble_day(ch, date(2001, 9, 11), db, slots=slots)

    # Gap segments should reference the shared pool's _gap.v3/{rend}/init.mp4
    assert "_gap.v3/full/init.mp4" in playlists["full"]
    assert "_gap.v3/mid/init.mp4" in playlists["mid"]
    assert "_gap.v3/thumb/init.mp4" in playlists["thumb"]


def test_master_playlist_has_three_streams():
    ch = make_channel()
    slots = get_slots_for_full_day()
    db = MagicMock()

    playlists, _ = assemble_day(ch, date(2001, 9, 11), db, slots=slots)

    master = playlists["master"]
    assert master.count("EXT-X-STREAM-INF") == 3
    for rend in REND_NAMES:
        assert rend in master


# --- EPG JSON ---

def test_epg_json_structure():
    ch = make_channel("cnn", "CNN")
    slots = get_slots_for_full_day()
    db = MagicMock()

    _, epg = assemble_day(ch, date(2001, 9, 11), db, slots=slots)

    assert epg["name"] == "CNN"
    assert epg["callSign"] == "CNN"
    assert "grid" in epg
    assert isinstance(epg["grid"], list)


def test_epg_start_end_are_iso8601():
    ch = make_channel()
    slots = get_slots_for_full_day()
    db = MagicMock()

    _, epg = assemble_day(ch, date(2001, 9, 11), db, slots=slots)

    for entry in epg["grid"]:
        # Must be parseable as ISO 8601
        datetime.fromisoformat(entry["start"].replace("Z", "+00:00"))
        datetime.fromisoformat(entry["end"].replace("Z", "+00:00"))


def test_epg_gap_programs_titled_no_signal():
    ch = make_channel()
    slots = get_slots_with_gaps()
    db = MagicMock()

    _, epg = assemble_day(ch, date(2001, 9, 11), db, slots=slots)

    gap_entries = [e for e in epg["grid"] if e["title"] == "[No Signal]"]
    assert len(gap_entries) >= 2  # gap before prog-a, between prog-a and prog-b, after prog-b


def test_epg_programs_have_full_title():
    ch = make_channel()
    base = datetime(2001, 9, 11, 0, 0, tzinfo=timezone.utc)
    slots = [make_slot("prog-a", base, 86400, title="CNN Morning News")]
    db = MagicMock()

    _, epg = assemble_day(ch, date(2001, 9, 11), db, slots=slots)

    real_programs = [e for e in epg["grid"] if e["title"] != "[No Signal]"]
    assert len(real_programs) >= 1
    assert real_programs[0]["fullTitle"] == "prog-a"


# --- helpers ---

def _count_playlist_duration(content: str) -> int:
    """Sum all #EXTINF durations in an m3u8 playlist."""
    total = 0
    for line in content.splitlines():
        if line.startswith("#EXTINF:"):
            val = line.split(":")[1].rstrip(",")
            total += round(float(val))
    return total
