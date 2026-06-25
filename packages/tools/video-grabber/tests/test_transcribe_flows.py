from datetime import datetime, timezone
from video_grabber.transcribe.flows import build_channel_cues

WS = datetime(2001, 9, 11, 0, 0, 0, tzinfo=timezone.utc)

PROG_A = "1\n00:00:01,000 --> 00:00:02,000\nA opening\n"
PROG_B = "1\n00:00:00,500 --> 00:00:01,500\nB opening\n"


def test_build_channel_cues_offsets_each_program_onto_stream_timeline():
    # Program A airs 1h after window_start, program B airs 2h after.
    a_air = datetime(2001, 9, 11, 1, 0, 0, tzinfo=timezone.utc)
    b_air = datetime(2001, 9, 11, 2, 0, 0, tzinfo=timezone.utc)
    cues = build_channel_cues(WS, [(a_air, PROG_A), (b_air, PROG_B)])
    # A opening at 3600+1 = 3601s; B opening at 7200+0.5 = 7200.5s
    assert cues[0].text == "A opening"
    assert abs(cues[0].start - 3601.0) < 1e-6
    assert cues[1].text == "B opening"
    assert abs(cues[1].start - 7200.5) < 1e-6


def test_build_channel_cues_sorts_out_of_order_programs():
    a_air = datetime(2001, 9, 11, 5, 0, 0, tzinfo=timezone.utc)
    b_air = datetime(2001, 9, 11, 1, 0, 0, tzinfo=timezone.utc)
    cues = build_channel_cues(WS, [(a_air, PROG_A), (b_air, PROG_B)])
    assert cues[0].text == "B opening"   # earlier air_date first
