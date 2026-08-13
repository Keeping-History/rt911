from datetime import datetime, timezone

from video_grabber.catalogue.filenames import parse_key


def test_clip_hhmmss_is_local_et_converted_to_utc():
    p = parse_key("audio/AA77/083950 aa77 approach indy .mp3")
    assert p.start_utc == datetime(2001, 9, 11, 12, 39, 50, tzinfo=timezone.utc)
    assert p.title == "approach indy"


def test_clip_hhmm_is_accepted():
    p = parse_key("audio/AA77/0812 aa77 taxi to runway t.mp3")
    assert p.start_utc == datetime(2001, 9, 11, 12, 12, 0, tzinfo=timezone.utc)


def test_faa_atc_tape_window_is_already_utc():
    p = parse_key("audio/faa_atc/zny/tmu/4 ZNY 132 TMU DC 1245-1316 UTC AP.mp3")
    assert p.start_utc == datetime(2001, 9, 11, 12, 45, tzinfo=timezone.utc)


def test_unparseable_name_yields_no_timestamp_rather_than_a_guess():
    p = parse_key("audio/norad/neads/DRM1_DAT2_Channel_3_MCC_TK.mp3")
    assert p.start_utc is None
    assert p.title == "DRM1_DAT2_Channel_3_MCC_TK"


def test_an_hour_of_100_is_not_read_as_midnight():
    # The transcript-contamination bug: '\d{2}' matched '10' out of '100225'
    # and a re-anchored search read hour 100 as 0.
    p = parse_key("audio/AA77/100225 aa77 line 4530 repo.mp3")
    assert p.start_utc == datetime(2001, 9, 11, 14, 2, 25, tzinfo=timezone.utc)


def test_impossible_clock_time_is_refused():
    # '995959' is not a time. Better to store nothing than a wrong instant.
    p = parse_key("audio/AA77/995959 something.mp3")
    assert p.start_utc is None
