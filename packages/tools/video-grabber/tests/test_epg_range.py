"""
Tests for assemble_range — the continuous multi-day per-channel stitcher and
its #EXT-X-PROGRAM-DATE-TIME wall-clock anchoring.
"""
import re
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


def test_gap_uses_shared_sequenced_pool():
    ch = make_channel("cnn")
    playlists, _ = assemble_range(ch, WINDOW_START, WINDOW_END, None, slots=[])
    full = playlists["full"]
    # Empty window => one big gap, referencing the shared (channel-independent)
    # sequenced pool by tile index, starting at seg0000 after each discontinuity.
    assert "/hls/_gap.v3/full/seg0000.m4s" in full
    assert "/hls/cnn/_gap" not in full  # not the old per-channel package
    assert _count_playlist_duration(full) == WINDOW_SECS


def test_master_url_is_channel_level():
    ch = make_channel("cnn")
    playlists, _ = assemble_range(ch, WINDOW_START, WINDOW_END, None, slots=[])
    assert "/playlists/cnn/full.m3u8" in playlists["master"]
    assert playlists["master"].count("EXT-X-STREAM-INF") == 3


def test_fetch_slots_path_reshapes_joined_rows():
    """assemble_range without slots= must read schedule_slots JOIN programs and
    expose slot.program.* — the integration path unit tests otherwise bypass."""
    from unittest.mock import MagicMock

    row = {
        "starts_at": datetime(2001, 9, 11, 12, 30, tzinfo=timezone.utc),
        "ends_at": datetime(2001, 9, 11, 13, 0, tzinfo=timezone.utc),
        "ia_identifier": "WETA_20010911_123000_Demo",
        "title": "Demo",
        "description": "Desc",
        "wasabi_key": "hls/weta/20010911/WETA_20010911_123000_Demo/master.m3u8",
    }
    db = MagicMock()
    db.execute.return_value.mappings.return_value.all.return_value = [row]

    ch = make_channel("weta")
    playlists, epg = assemble_range(ch, WINDOW_START, WINDOW_END, db)  # no slots=

    assert "/weta/20010911/WETA_20010911_123000_Demo/full/" in playlists["full"]
    assert any(g["title"] == "Demo" for g in epg["grid"])
    assert _count_playlist_duration(playlists["full"]) == WINDOW_SECS


def test_segment_path_uses_stored_upload_key_after_reassignment():
    """A program reassigned to a new channel keeps its segments at the original
    upload location (keyed by the slug at encode time). assemble_range must path
    them from the stored ``segment_base``, not the program's current slug — else
    every reassigned program points at a dead URL."""
    ch = make_channel("cnn")  # program now lives on cnn...
    slot = make_slot(
        "CNN_20010911_010000_Larry_King_Live",
        datetime(2001, 9, 11, 1, 0, tzinfo=timezone.utc),
        1800,
    )
    # ...but its segments were uploaded while it was mis-slugged "king".
    slot.program.segment_base = "hls/king/20010911/CNN_20010911_010000_Larry_King_Live"
    playlists, _ = assemble_range(ch, WINDOW_START, WINDOW_END, None, slots=[slot])
    full = playlists["full"]
    assert "/hls/king/20010911/CNN_20010911_010000_Larry_King_Live/full/" in full
    assert "/hls/cnn/20010911/" not in full  # never under the new slug


def test_segment_path_falls_back_to_slug_without_key():
    """With no stored key (segment_base=None), fall back to the slug-based path."""
    ch = make_channel("cnn")
    slot = make_slot("prog-x", datetime(2001, 9, 11, 1, 0, tzinfo=timezone.utc), 1800)
    slot.program.segment_base = None
    playlists, _ = assemble_range(ch, WINDOW_START, WINDOW_END, None, slots=[slot])
    assert "/hls/cnn/20010911/prog-x/full/" in playlists["full"]


# --- accurate #EXTINF (the QuickTime-drift fix) ---------------------------------

def _extinfs(playlist: str) -> list[float]:
    return [float(ln.split(":")[1].rstrip(","))
            for ln in playlist.splitlines() if ln.startswith("#EXTINF:")]


def _fake_wasabi(monkeypatch, index_text):
    """Inject a boto3-free stand-in for storage.wasabi so the assembler's lazy
    import resolves to it (the real module imports boto3, absent in unit env)."""
    import sys
    import types

    mod = types.ModuleType("video_grabber.storage.wasabi")
    mod._make_s3_client = lambda cfg: object()
    mod.read_text = lambda key, cfg, s3=None: index_text
    monkeypatch.setitem(sys.modules, "video_grabber.storage.wasabi", mod)


def test_program_extinf_comes_from_real_index_when_cfg_present(monkeypatch):
    """With cfg set, the assembler reads the program's uploaded index.m3u8 and
    emits its *real* fractional EXTINF + segment names — not a synthesized
    integer-6s layout. This is what keeps a sample-timestamp player locked to
    the playlist timeline."""
    real_index = (
        "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n"
        '#EXT-X-MAP:URI="init.mp4"\n'
        "#EXTINF:6.006006,\nseg0000.m4s\n"
        "#EXTINF:6.006006,\nseg0001.m4s\n"
        "#EXTINF:4.004000,\nseg0002.m4s\n"
        "#EXT-X-ENDLIST\n"
    )
    _fake_wasabi(monkeypatch, real_index)

    ch = make_channel("cnn")
    # Slot span (20s) exceeds the program (16.016s) so no segment is clipped —
    # the real fractional EXTINF pass through verbatim (clipping has its own test).
    slot = make_slot("CNN_x", datetime(2001, 9, 11, 1, 0, tzinfo=timezone.utc), 20)
    slot.program.segment_base = "hls/king/20010911/CNN_x"
    playlists, _ = assemble_range(
        ch, WINDOW_START, WINDOW_END, None, slots=[slot], cfg=object(),
    )
    full = playlists["full"]
    # Real segment names + fractional EXTINF appear verbatim.
    assert "/hls/king/20010911/CNN_x/full/seg0000.m4s" in full
    assert "#EXTINF:6.006," in full   # %g trims 6.006006 -> 6.006
    assert "#EXTINF:4.004," in full
    # The synthesized integer fallback ("seg0000.m4s" via range + EXTINF:6) is
    # not what produced these — verify a fractional value is present.
    assert any(abs(d - 6.006006) < 1e-3 for d in _extinfs(full))


def test_clipped_slot_drops_segments_past_its_window(monkeypatch):
    """A slot shorter than its program (scheduler clipped an overlap) emits only
    whole segments up to the slot span; the rest are dropped, not overrun."""
    # Program is 18s of real media (3x6s) but the slot is only ~12s.
    real_index = (
        "#EXTM3U\n"
        "#EXTINF:6.006,\nseg0000.m4s\n"
        "#EXTINF:6.006,\nseg0001.m4s\n"
        "#EXTINF:6.006,\nseg0002.m4s\n#EXT-X-ENDLIST\n"
    )
    _fake_wasabi(monkeypatch, real_index)

    ch = make_channel("cnn")
    slot = make_slot("CNN_x", datetime(2001, 9, 11, 1, 0, tzinfo=timezone.utc), 12)
    slot.program.segment_base = "hls/cnn/20010911/CNN_x"
    playlists, _ = assemble_range(
        ch, WINDOW_START, WINDOW_END, None, slots=[slot], cfg=object(),
    )
    full = playlists["full"]
    assert "/CNN_x/full/seg0001.m4s" in full       # fills the 12s slot
    assert "/CNN_x/full/seg0002.m4s" not in full    # 3rd would overrun the slot
    # The program's EXTINF total lands on the slot span exactly (final segment
    # clipped), so cumulative time stays equal to wall-clock at the boundary.
    prog_extinfs = [
        float(ln.split(":")[1].rstrip(","))
        for ln, nxt in zip(full.splitlines(), full.splitlines()[1:])
        if ln.startswith("#EXTINF:") and "/CNN_x/full/" in nxt
    ]
    assert abs(sum(prog_extinfs) - 12.0) < 1e-6


def test_short_program_is_blue_padded_to_slot_span(monkeypatch):
    """A program whose real encoded media falls short of its slot (the slot was
    sized from the over-reporting .mpg probe) gets the remainder blue-padded, so
    cumulative #EXTINF still equals the slot's wall-clock span — no under-fill,
    no 404 tail segments."""
    # Program is only 12.012s of real media but the slot is 60s.
    real_index = (
        "#EXTM3U\n"
        "#EXTINF:6.006,\nseg0000.m4s\n"
        "#EXTINF:6.006,\nseg0001.m4s\n#EXT-X-ENDLIST\n"
    )
    _fake_wasabi(monkeypatch, real_index)

    ch = make_channel("cnn")
    slot = make_slot("CNN_x", datetime(2001, 9, 11, 1, 0, tzinfo=timezone.utc), 60)
    slot.program.segment_base = "hls/cnn/20010911/CNN_x"
    playlists, _ = assemble_range(
        ch, WINDOW_START, WINDOW_END, None, slots=[slot], cfg=object(),
    )
    full = playlists["full"]
    assert "/CNN_x/full/seg0001.m4s" in full           # real program segments
    assert "/hls/_gap.v3/full/seg0000.m4s" in full      # blue pad fills the rest
    # No phantom program segments past the real two (the legacy 404 tail).
    assert "/CNN_x/full/seg0002.m4s" not in full
    # The whole window's real media still equals wall-clock (slot fully filled).
    assert abs(sum(_extinfs(full)) - WINDOW_SECS) < 6.5


def test_gap_tiles_are_referenced_in_sequence():
    """The gap references the pool by ascending index (seg0000, seg0001, …) so
    each tile carries an increasing fMP4 sequence_number/tfdt — the thing that
    stops conformant players (VLC) flagging the dead air and drifting."""
    ch = make_channel("cnn")
    # A 5-minute gap = 50 tiles, well under POOL_TILES (one run, no reset).
    slots = [make_slot("p", datetime(2001, 9, 11, 0, 5, tzinfo=timezone.utc), 60)]
    playlists, _ = assemble_range(ch, WINDOW_START, WINDOW_END, None, slots=slots)
    full = playlists["full"]
    seen = [int(m) for m in re.findall(r"/_gap\.v3/full/seg(\d{4})\.m4s", full)]
    leading = seen[: seen.index(max(seen[:60])) + 1]  # first run's tile indices
    # Within a run the indices ascend 0,1,2,… (not a single repeated tile).
    assert leading[:5] == [0, 1, 2, 3, 4]
    assert max(seen) > 1  # not the old single-tile repeat


def test_long_gap_resets_pool_with_discontinuity():
    """A gap longer than POOL_TILES restarts at seg0000 behind a fresh
    discontinuity so the bounded pool is reused — verified safe in VLC."""
    from video_grabber.epg.assembler import POOL_TILES, TILE_SECONDS
    ch = make_channel("cnn")
    # Empty window => one enormous gap spanning many pool lengths.
    playlists, _ = assemble_range(ch, WINDOW_START, WINDOW_END, None, slots=[])
    full = playlists["full"]
    # seg0000 recurs once per run; the run length is POOL_TILES.
    runs = full.count("/_gap.v3/full/seg0000.m4s")
    expected_runs = -(-WINDOW_SECS // (POOL_TILES * TILE_SECONDS))  # ceil
    assert runs == expected_runs
    # Each run is preceded by a discontinuity (full-rendition count).
    assert full.count("#EXT-X-DISCONTINUITY") == runs
