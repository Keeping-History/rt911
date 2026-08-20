from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

from video_grabber.config import Config
from video_grabber.thumbnails.clock import virtual_utc_now
from video_grabber.thumbnails.flows import _channel_rows, generate_thumbnails_flow
from video_grabber.thumbnails.generator import (
    capture_frame,
    capture_frame_from_bytes,
    ensure_offline_placeholder,
    upload_thumbnail,
)
from video_grabber.thumbnails.m3u8 import _find_segment_in_playlist, find_thumb_segment
from video_grabber.thumbnails.batch_flow import _parse_all_segments, _select_boundary_items
import respx
import httpx as _httpx


_WINDOW_JSON = {"data": [{"start_date": "2001-09-09T00:00:00", "end_date": "2001-09-18T00:00:00"}]}
_WINDOW_START = datetime(2001, 9, 9, tzinfo=timezone.utc)
_WINDOW_END = datetime(2001, 9, 18, tzinfo=timezone.utc)
_WINDOW_DURATION = _WINDOW_END - _WINDOW_START  # 9 days


def _cfg(real_iso: str) -> Config:
    c = Config()
    c.virtual_epoch_real = real_iso
    return c


def _mock_client(json_data):
    """Minimal httpx-alike returning a fixed JSON response for any GET."""

    class _Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return json_data

    class _Client:
        def get(self, *_a, **_kw):
            return _Resp()

    return _Client()


def test_virtual_utc_now_at_epoch_matches_window_start():
    """When real clock == epoch_real, virtual_now == start_date."""
    now_real = datetime.now(timezone.utc)
    cfg = _cfg(now_real.isoformat())
    result = virtual_utc_now(cfg, client=_mock_client(_WINDOW_JSON))
    assert abs((result - _WINDOW_START).total_seconds()) < 2


def test_virtual_utc_now_advances_proportionally():
    """One real hour after epoch_real → virtual_now is one hour after start_date."""
    now = datetime.now(timezone.utc)
    past = now - timedelta(hours=1)
    cfg = _cfg(past.isoformat())
    result = virtual_utc_now(cfg, client=_mock_client(_WINDOW_JSON))
    expected = _WINDOW_START + timedelta(hours=1)
    assert abs((result - expected).total_seconds()) < 5


def test_virtual_utc_now_returns_aware_utc():
    cfg = _cfg(datetime.now(timezone.utc).isoformat())
    result = virtual_utc_now(cfg, client=_mock_client(_WINDOW_JSON))
    assert result.tzinfo is not None


def test_virtual_utc_now_loops_through_window():
    """After exactly one full 9-day window of real time, virtual_now wraps back to start_date."""
    epoch_real = datetime.now(timezone.utc) - _WINDOW_DURATION
    cfg = _cfg(epoch_real.isoformat())
    result = virtual_utc_now(cfg, client=_mock_client(_WINDOW_JSON))
    assert abs((result - _WINDOW_START).total_seconds()) < 5


# Synthetic playlist: two slots separated by a discontinuity.
# First slot: 2001-09-11T12:00:00Z, three 6-second segments.
# Second slot: 2001-09-11T14:00:00Z, one segment.
SAMPLE_PLAYLIST = """\
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-PROGRAM-DATE-TIME:2001-09-11T12:00:00+00:00
#EXTINF:6.000,
https://files.911realtime.org/hls/cnn/20010911/cnn-a/seg-000001.m4s
#EXTINF:6.000,
https://files.911realtime.org/hls/cnn/20010911/cnn-a/seg-000002.m4s
#EXTINF:6.000,
https://files.911realtime.org/hls/cnn/20010911/cnn-a/seg-000003.m4s
#EXT-X-DISCONTINUITY
#EXT-X-PROGRAM-DATE-TIME:2001-09-11T14:00:00+00:00
#EXTINF:6.000,
https://files.911realtime.org/hls/cnn/20010911/cnn-b/seg-000001.m4s
#EXT-X-ENDLIST
"""


def test_find_segment_in_playlist_first_segment():
    t = datetime(2001, 9, 11, 12, 0, 3, tzinfo=timezone.utc)  # 3 s into seg 1
    assert _find_segment_in_playlist(SAMPLE_PLAYLIST, t) == \
        "https://files.911realtime.org/hls/cnn/20010911/cnn-a/seg-000001.m4s"


def test_find_segment_in_playlist_second_segment_by_accumulated_duration():
    t = datetime(2001, 9, 11, 12, 0, 8, tzinfo=timezone.utc)  # 8 s in → seg 2
    assert _find_segment_in_playlist(SAMPLE_PLAYLIST, t) == \
        "https://files.911realtime.org/hls/cnn/20010911/cnn-a/seg-000002.m4s"


def test_find_segment_in_playlist_after_discontinuity():
    t = datetime(2001, 9, 11, 14, 0, 2, tzinfo=timezone.utc)
    assert _find_segment_in_playlist(SAMPLE_PLAYLIST, t) == \
        "https://files.911realtime.org/hls/cnn/20010911/cnn-b/seg-000001.m4s"


def test_find_segment_in_playlist_before_stream_start():
    t = datetime(2001, 9, 9, 0, 0, 0, tzinfo=timezone.utc)
    assert _find_segment_in_playlist(SAMPLE_PLAYLIST, t) is None


def test_find_segment_in_playlist_after_stream_end():
    t = datetime(2001, 9, 18, 0, 0, 0, tzinfo=timezone.utc)
    assert _find_segment_in_playlist(SAMPLE_PLAYLIST, t) is None


@respx.mock
def test_find_thumb_segment_fetches_correct_url():
    master = "https://files.911realtime.org/playlists/cnn/master.m3u8"
    thumb_url = "https://files.911realtime.org/playlists/cnn/thumb.m3u8"
    respx.get(thumb_url).mock(return_value=_httpx.Response(200, text=SAMPLE_PLAYLIST))
    t = datetime(2001, 9, 11, 12, 0, 3, tzinfo=timezone.utc)
    init_url, seg_url = find_thumb_segment(master, t)
    # SAMPLE_PLAYLIST has no #EXT-X-MAP tag
    assert init_url is None
    assert seg_url == "https://files.911realtime.org/hls/cnn/20010911/cnn-a/seg-000001.m4s"


FMPG4_PLAYLIST = """\
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="https://files.911realtime.org/hls/cnn/thumb/init.mp4"
#EXT-X-PROGRAM-DATE-TIME:2001-09-11T12:00:00+00:00
#EXTINF:6.000,
https://files.911realtime.org/hls/cnn/thumb/seg0001.m4s
#EXT-X-ENDLIST
"""


@respx.mock
def test_find_thumb_segment_returns_init_url_for_fmp4():
    master = "https://files.911realtime.org/playlists/cnn/master.m3u8"
    thumb_url = "https://files.911realtime.org/playlists/cnn/thumb.m3u8"
    respx.get(thumb_url).mock(return_value=_httpx.Response(200, text=FMPG4_PLAYLIST))
    t = datetime(2001, 9, 11, 12, 0, 3, tzinfo=timezone.utc)
    init_url, seg_url = find_thumb_segment(master, t)
    assert init_url == "https://files.911realtime.org/hls/cnn/thumb/init.mp4"
    assert seg_url == "https://files.911realtime.org/hls/cnn/thumb/seg0001.m4s"


# ---------------------------------------------------------------------------
# Task 3: frame capture, offline placeholder, Wasabi upload
# ---------------------------------------------------------------------------

def make_cfg() -> Config:
    return Config()


def test_capture_frame_returns_bytes_on_success(monkeypatch, tmp_path):
    fake_jpeg = b"\xff\xd8\xff\xe0fake"

    def fake_run(args, **kw):
        # ffmpeg writes to args[-1]; write our fake bytes there
        Path(args[-1]).write_bytes(fake_jpeg)
        return SimpleNamespace(returncode=0, stderr=b"")

    monkeypatch.setattr("video_grabber.thumbnails.generator.subprocess.run", fake_run)
    result = capture_frame("https://files.911realtime.org/hls/cnn/seg.m4s")
    assert result == fake_jpeg


def test_capture_frame_returns_none_on_ffmpeg_failure(monkeypatch):
    def fake_run(args, **kw):
        return SimpleNamespace(returncode=1, stderr=b"decoder error")

    monkeypatch.setattr("video_grabber.thumbnails.generator.subprocess.run", fake_run)
    result = capture_frame("https://files.911realtime.org/hls/cnn/seg.m4s")
    assert result is None


def test_upload_thumbnail_puts_correct_key_and_headers():
    uploads = {}

    class FakeS3:
        def put_object(self, **kw):
            uploads[kw["Key"]] = kw

    upload_thumbnail("cnn", b"\xff\xd8\xff", make_cfg(), s3=FakeS3())
    assert "thumbnails/cnn.jpg" in uploads
    assert uploads["thumbnails/cnn.jpg"]["ContentType"] == "image/jpeg"
    assert uploads["thumbnails/cnn.jpg"]["CacheControl"] == "max-age=30"
    assert uploads["thumbnails/cnn.jpg"]["Body"] == b"\xff\xd8\xff"


def test_ensure_offline_placeholder_skips_if_exists():
    put_calls = []

    class FakeS3:
        def head_object(self, **kw):
            pass  # no exception → object exists

        def put_object(self, **kw):
            put_calls.append(kw)

    ensure_offline_placeholder(make_cfg(), s3=FakeS3())
    assert put_calls == []  # must NOT upload when it already exists


def test_ensure_offline_placeholder_uploads_when_missing(monkeypatch):
    put_calls = []
    fake_jpeg = b"\xff\xd8\xff\xe0blue"

    class NoSuchKey(Exception):
        pass

    class FakeS3:
        exceptions = SimpleNamespace(ClientError=NoSuchKey)

        def head_object(self, **kw):
            raise NoSuchKey("not found")

        def put_object(self, **kw):
            put_calls.append(kw)

    monkeypatch.setattr(
        "video_grabber.thumbnails.generator.generate_offline_jpeg", lambda: fake_jpeg
    )
    ensure_offline_placeholder(make_cfg(), s3=FakeS3())
    assert len(put_calls) == 1
    assert put_calls[0]["Key"] == "thumbnails/offline.jpg"
    assert put_calls[0]["CacheControl"] == "max-age=31536000"


# ---------------------------------------------------------------------------
# Task 4: Prefect flow + registration
# ---------------------------------------------------------------------------


def test_channel_rows_returns_urls_and_slugs():
    cfg = make_cfg()
    with respx.mock:
        respx.get(f"{cfg.directus_url}/items/tv_channels").mock(
            return_value=_httpx.Response(200, json={"data": [
                {"title": "CNN", "url": "https://files.911realtime.org/playlists/cnn/master.m3u8"},
                {"title": "WETA", "url": "https://files.911realtime.org/playlists/weta/master.m3u8"},
                # slug comes from the title, not the playlist URL path
                {"title": "CCTV4", "url": "https://files.911realtime.org/playlists/cctv3/master.m3u8"},
                # rows missing a title are skipped
                {"url": "https://files.911realtime.org/playlists/abc/master.m3u8"},
            ]})
        )
        rows = _channel_rows(cfg)
    assert rows == [
        ("cnn", "https://files.911realtime.org/playlists/cnn/master.m3u8"),
        ("weta", "https://files.911realtime.org/playlists/weta/master.m3u8"),
        ("cctv4", "https://files.911realtime.org/playlists/cctv3/master.m3u8"),
    ]


def test_generate_thumbnails_flow_uploads_for_found_segments(monkeypatch):
    uploaded = {}

    monkeypatch.setattr(
        "video_grabber.thumbnails.flows.ensure_offline_placeholder", lambda cfg: None
    )
    monkeypatch.setattr(
        "video_grabber.thumbnails.flows.virtual_utc_now",
        lambda cfg: datetime(2001, 9, 11, 12, 0, 3, tzinfo=timezone.utc),
    )
    monkeypatch.setattr(
        "video_grabber.thumbnails.flows._channel_rows",
        lambda cfg: [("cnn", "https://files.911realtime.org/playlists/cnn/master.m3u8")],
    )
    monkeypatch.setattr(
        "video_grabber.thumbnails.flows.find_thumb_segment",
        lambda url, vt: ("https://files.911realtime.org/hls/cnn/thumb/init.mp4",
                         "https://files.911realtime.org/hls/cnn/seg.m4s"),
    )
    monkeypatch.setattr(
        "video_grabber.thumbnails.flows.capture_frame",
        lambda url, init_url=None: b"\xff\xd8\xff",
    )
    monkeypatch.setattr(
        "video_grabber.thumbnails.flows.upload_thumbnail",
        lambda slug, data, cfg: uploaded.update({slug: data}),
    )

    generate_thumbnails_flow()
    assert "cnn" in uploaded
    assert uploaded["cnn"] == b"\xff\xd8\xff"


def test_generate_thumbnails_flow_skips_upload_when_capture_fails(monkeypatch):
    uploaded = {}

    monkeypatch.setattr(
        "video_grabber.thumbnails.flows.ensure_offline_placeholder", lambda cfg: None
    )
    monkeypatch.setattr(
        "video_grabber.thumbnails.flows.virtual_utc_now",
        lambda cfg: datetime(2001, 9, 11, 12, 0, 3, tzinfo=timezone.utc),
    )
    monkeypatch.setattr(
        "video_grabber.thumbnails.flows._channel_rows",
        lambda cfg: [("offline_ch", "https://files.911realtime.org/playlists/offline_ch/master.m3u8")],
    )
    monkeypatch.setattr(
        "video_grabber.thumbnails.flows.find_thumb_segment",
        lambda url, vt: (None, None),  # no segment found
    )
    monkeypatch.setattr(
        "video_grabber.thumbnails.flows.upload_thumbnail",
        lambda slug, data, cfg: uploaded.update({slug: data}),
    )

    generate_thumbnails_flow()
    assert "offline_ch" not in uploaded  # frontend falls back to offline.jpg


# ---------------------------------------------------------------------------
# Batch flow: segment parsing + boundary selection
# ---------------------------------------------------------------------------

# Playlist with two discontinuous slots; segments are 6 seconds.
# Slot A starts at 2001-09-11T12:00:00Z (unix 1000209600).
# Slot B starts at 2001-09-11T12:01:00Z (unix 1000209660).
BATCH_PLAYLIST = """\
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="https://files.911realtime.org/hls/cnn/thumb/init.mp4"
#EXT-X-PROGRAM-DATE-TIME:2001-09-11T12:00:00+00:00
#EXTINF:6.000,
https://files.911realtime.org/hls/cnn/thumb/seg0001.m4s
#EXTINF:6.000,
https://files.911realtime.org/hls/cnn/thumb/seg0002.m4s
#EXTINF:6.000,
https://files.911realtime.org/hls/cnn/thumb/seg0003.m4s
#EXTINF:6.000,
https://files.911realtime.org/hls/cnn/thumb/seg0004.m4s
#EXTINF:6.000,
https://files.911realtime.org/hls/cnn/thumb/seg0005.m4s
#EXT-X-DISCONTINUITY
#EXT-X-PROGRAM-DATE-TIME:2001-09-11T12:01:00+00:00
#EXTINF:6.000,
https://files.911realtime.org/hls/cnn/thumb/seg0006_gap.v3.m4s
#EXTINF:6.000,
https://files.911realtime.org/hls/cnn/thumb/seg0007.m4s
#EXT-X-ENDLIST
"""
# Slot A: seg0001 starts at unix=1000209600 (a 30-s boundary!).
# seg0002 @ +6, seg0003 @ +12, seg0004 @ +18, seg0005 @ +24.
# The next 30-s boundary is at 1000209630 (+30), which falls in seg0006 but
# seg0006 is a gap — so it should be skipped.
# Slot B: seg0006 (gap) @ 1000209660, seg0007 @ 1000209666.
# Next boundary after 1000209660 = 1000209690 — but no segment covers that, so nothing emitted.
# Expected boundary items: just (1000209600, seg0001.m4s).


def test_parse_all_segments_counts():
    segs = _parse_all_segments(BATCH_PLAYLIST)
    assert len(segs) == 7


def test_parse_all_segments_first_entry():
    segs = _parse_all_segments(BATCH_PLAYLIST)
    unix_ts, dur, is_gap, url = segs[0]
    assert unix_ts == 1000209600
    assert dur == 6.0
    assert not is_gap
    assert "seg0001" in url


def test_parse_all_segments_gap_detected():
    segs = _parse_all_segments(BATCH_PLAYLIST)
    _, _, is_gap, url = segs[5]  # seg0006_gap.v3
    assert is_gap
    assert "_gap.v3" in url


def test_parse_all_segments_discontinuity_resets_time():
    segs = _parse_all_segments(BATCH_PLAYLIST)
    unix_ts, _, _, _ = segs[5]  # first in slot B = 1000209660
    assert unix_ts == 1000209660


def test_select_boundary_items_skips_gaps():
    segs = _parse_all_segments(BATCH_PLAYLIST)
    boundaries = _select_boundary_items(segs)
    urls = [url for _, url in boundaries]
    assert not any("_gap.v3" in u for u in urls)


def test_select_boundary_items_correct_boundary():
    segs = _parse_all_segments(BATCH_PLAYLIST)
    boundaries = _select_boundary_items(segs)
    assert len(boundaries) == 1
    ts, url = boundaries[0]
    assert ts == 1000209600
    assert "seg0001" in url


def test_capture_frame_from_bytes_returns_jpeg(monkeypatch, tmp_path):
    fake_jpeg = b"\xff\xd8\xff\xe0batch"

    def fake_run(args, **kw):
        Path(args[-1]).write_bytes(fake_jpeg)
        return SimpleNamespace(returncode=0, stderr=b"")

    monkeypatch.setattr("video_grabber.thumbnails.generator.subprocess.run", fake_run)
    result = capture_frame_from_bytes(b"\x00init\x00seg")
    assert result == fake_jpeg


def test_capture_frame_from_bytes_returns_none_on_ffmpeg_failure(monkeypatch):
    monkeypatch.setattr(
        "video_grabber.thumbnails.generator.subprocess.run",
        lambda args, **kw: SimpleNamespace(returncode=1, stderr=b"error"),
    )
    assert capture_frame_from_bytes(b"\x00") is None
