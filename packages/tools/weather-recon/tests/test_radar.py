import struct

from weather_recon.radar import (build_index, corners, frame_times, iem_frame_url,
                                 iem_wld_url, parse_wld, png_dimensions,
                                 wasabi_frame_key)

# Real values from n0r_200109111740 (captured 2026-07-12)
WLD = "0.01\n0.0\n0.0\n-0.01\n-126.0\n50.0\n"


def _png_bytes(width, height):
    return (b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR"
            + struct.pack(">II", width, height) + b"\x08\x03" + b"\x00" * 20)


def test_frame_times_five_minute_steps_inclusive():
    times = frame_times("2001-09-09", "2001-09-12")
    assert len(times) == 4 * 288
    assert times[0] == "200109090000"
    assert times[1] == "200109090005"
    assert times[-1] == "200109122355"


def test_frame_times_single_day():
    times = frame_times("2001-09-11", "2001-09-11")
    assert len(times) == 288
    assert times[212] == "200109111740"


def test_iem_urls_embed_date_path_and_stamp():
    assert iem_frame_url("200109111740") == (
        "https://mesonet.agron.iastate.edu/archive/data/2001/09/11/GIS/uscomp/"
        "n0r_200109111740.png")
    assert iem_wld_url("200109111740").endswith("uscomp/n0r_200109111740.wld")


def test_wasabi_frame_key():
    assert wasabi_frame_key("200109111740") == "weather/radar/n0r_200109111740.png"


def test_png_dimensions_reads_ihdr():
    assert png_dimensions(_png_bytes(6000, 2600)) == (6000, 2600)


def test_png_dimensions_rejects_non_png():
    try:
        png_dimensions(b"<html>error page</html>")
        raise AssertionError("expected ValueError")
    except ValueError:
        pass


def test_parse_wld():
    assert parse_wld(WLD) == {"dx": 0.01, "dy": -0.01, "ulx": -126.0, "uly": 50.0}


def test_corners_maplibre_order():
    got = corners(parse_wld(WLD), 6000, 2600)
    assert got == [[-126.0, 50.0], [-66.0, 50.0], [-66.0, 24.0], [-126.0, 24.0]]


def test_build_index_shape():
    idx = build_index(["200109090000", "200109090010"], ["200109090005"],
                      [[-126.0, 50.0], [-66.0, 50.0], [-66.0, 24.0], [-126.0, 24.0]],
                      "2001-09-09", "2001-09-12")
    assert idx == {
        "product": "n0r", "interval_seconds": 300,
        "timezone": "UTC",
        "start": "2001-09-09", "end": "2001-09-12",
        "bounds": [[-126.0, 50.0], [-66.0, 50.0], [-66.0, 24.0], [-126.0, 24.0]],
        "key_prefix": "weather/radar/", "key_pattern": "n0r_{stamp}.png",
        "frames": ["200109090000", "200109090010"],
        "missing": ["200109090005"],
    }
