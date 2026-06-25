from datetime import datetime, timedelta, timezone
from video_grabber.config import Config
from video_grabber.thumbnails.clock import virtual_utc_now


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
