from datetime import datetime, timedelta, timezone
from video_grabber.config import Config
from video_grabber.thumbnails.clock import virtual_utc_now
from video_grabber.thumbnails.m3u8 import _find_segment_in_playlist, find_thumb_segment
import respx, httpx as _httpx


def _cfg(real_iso: str, virtual_iso: str = "2001-09-11T12:40:00+00:00") -> Config:
    c = Config()
    c.virtual_epoch_real = real_iso
    c.virtual_epoch_virtual = virtual_iso
    return c


def test_virtual_utc_now_at_epoch_matches_virtual_start():
    """When real clock == epoch_real, virtual_now == epoch_virtual."""
    now_real = datetime.now(timezone.utc)
    cfg = _cfg(now_real.isoformat(), "2001-09-11T12:40:00+00:00")
    result = virtual_utc_now(cfg)
    assert abs((result - datetime(2001, 9, 11, 12, 40, tzinfo=timezone.utc)).total_seconds()) < 2


def test_virtual_utc_now_advances_proportionally():
    """One real hour after epoch_real → virtual_now is one hour after epoch_virtual."""
    # Simulate 1 hour after epoch_real by patching: we can't freeze time here, so
    # test the math by calling with a cfg whose epoch is 1 hour in the past.
    now = datetime.now(timezone.utc)
    past = now - timedelta(hours=1)
    cfg = _cfg(past.isoformat(), "2001-09-11T12:40:00+00:00")
    result = virtual_utc_now(cfg)
    expected = datetime(2001, 9, 11, 13, 40, tzinfo=timezone.utc)
    assert abs((result - expected).total_seconds()) < 5  # allow ~5s for real elapsed


def test_virtual_utc_now_returns_aware_utc():
    cfg = _cfg(datetime.now(timezone.utc).isoformat())
    result = virtual_utc_now(cfg)
    assert result.tzinfo is not None


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
    thumb_url = "https://files.911realtime.org/playlists/cnn/thumb/playlist.m3u8"
    respx.get(thumb_url).mock(return_value=_httpx.Response(200, text=SAMPLE_PLAYLIST))
    t = datetime(2001, 9, 11, 12, 0, 3, tzinfo=timezone.utc)
    result = find_thumb_segment(master, t)
    assert result == "https://files.911realtime.org/hls/cnn/20010911/cnn-a/seg-000001.m4s"
