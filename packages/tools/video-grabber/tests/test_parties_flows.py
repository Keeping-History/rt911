from video_grabber.parties.flows import sample_windows, srt_text_to_plain

SRT = (
    "1\n00:00:01,000 --> 00:00:02,000\nIndy Center.\n\n"
    "2\n00:00:03,000 --> 00:00:04,000\nAmerican 77.\n"
)


def test_srt_to_plain_drops_indices_and_timestamps():
    assert srt_text_to_plain(SRT) == "Indy Center. American 77."


def test_sample_windows_returns_whole_text_when_short():
    assert sample_windows("short", n=6, size=2000) == ["short"]


def test_sample_windows_spreads_across_a_long_transcript():
    # Position-varying content: a repeating pattern whose period divides the
    # step would make distinct windows compare equal and hide a real bug.
    text = "".join(f"{i:04d}" for i in range(5000))
    got = sample_windows(text, n=6, size=2000)
    assert len(got) == 6
    assert all(len(w) == 2000 for w in got)
    assert len(set(got)) == 6


def test_sample_windows_reaches_the_end_of_the_transcript():
    # The last minutes of a NEADS tape are as interesting as the first; a
    # sampler that only ever reads the opening would miss them.
    text = "a" * 19000 + "TAIL" + "b" * 1000
    got = sample_windows(text, n=6, size=2000)
    assert any("TAIL" in w for w in got)
