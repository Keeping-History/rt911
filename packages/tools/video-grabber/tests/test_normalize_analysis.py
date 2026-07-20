import pytest

from video_grabber.config import Config
from video_grabber.normalize.analysis import (
    archive_key_for,
    encode_args,
    needs_normalization,
    parse_loudnorm_json,
)

# Realistic ffmpeg stderr: progress noise, filter banner, then the JSON block.
FFMPEG_STDERR = """\
size=N/A time=00:12:31.05 bitrate=N/A speed= 214x
video:0KiB audio:70411KiB subtitle:0KiB other streams:0KiB global headers:0KiB
[Parsed_loudnorm_1 @ 0x55d1c3a4b2c0]
{
    "input_i" : "-27.61",
    "input_tp" : "-4.47",
    "input_lra" : "18.06",
    "input_thresh" : "-39.20",
    "output_i" : "-16.58",
    "output_tp" : "-2.22",
    "output_lra" : "14.78",
    "output_thresh" : "-27.71",
    "normalization_type" : "dynamic",
    "target_offset" : "0.58"
}
"""


def test_parse_loudnorm_json_extracts_trailing_block():
    d = parse_loudnorm_json(FFMPEG_STDERR)
    assert d["input_i"] == "-27.61"
    assert d["target_offset"] == "0.58"


def test_parse_loudnorm_json_takes_last_block_when_multiple():
    two = FFMPEG_STDERR + FFMPEG_STDERR.replace('"-27.61"', '"-20.00"')
    assert parse_loudnorm_json(two)["input_i"] == "-20.00"


def test_parse_loudnorm_json_raises_without_block():
    with pytest.raises(ValueError):
        parse_loudnorm_json("frame= 100 fps=25 ...\n")


def test_needs_normalization_boundaries():
    cfg = Config()  # I=-16, TP=-1.5, tol=1.0
    assert needs_normalization(-27.6, -4.5, cfg) is True    # far too quiet
    assert needs_normalization(-16.0, -2.0, cfg) is False   # on target
    assert needs_normalization(-17.0, -2.0, cfg) is False   # exactly at tolerance edge
    assert needs_normalization(-17.01, -2.0, cfg) is True   # just outside
    assert needs_normalization(-16.0, -1.4, cfg) is True    # loudness fine, peak too hot


def test_encode_args_floors_bitrate_and_matches_source():
    args = encode_args({"bit_rate": 64000, "sample_rate": 22050, "channels": 1})
    assert args == ["-ar", "22050", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k"]
    args = encode_args({"bit_rate": 192000, "sample_rate": 44100, "channels": 2})
    assert args[-1] == "192k"


def test_archive_key_for():
    assert archive_key_for("audio/wnyc-am.mp3") == "audio-original/wnyc-am.mp3"
