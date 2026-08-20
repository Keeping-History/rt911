import struct
import zlib

from weather_recon.radar import (add_index0_transparency, build_index, corners,
                                 frame_times, iem_frame_url, iem_wld_url,
                                 parse_wld, png_dimensions, wasabi_frame_key)

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


def _chunk(ctype, data):
    return (struct.pack(">I", len(data)) + ctype + data
            + struct.pack(">I", zlib.crc32(ctype + data)))


def _palette_png(with_trns=False):
    """Minimal valid 1x1 palette PNG (index 0 = black), like IEM's n0r frames."""
    ihdr = _chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 3, 0, 0, 0))
    plte = _chunk(b"PLTE", b"\x00\x00\x00\xff\x00\x00")
    trns = _chunk(b"tRNS", b"\x00") if with_trns else b""
    idat = _chunk(b"IDAT", zlib.compress(b"\x00\x00"))
    return b"\x89PNG\r\n\x1a\n" + ihdr + plte + trns + idat + _chunk(b"IEND", b"")


def test_add_index0_transparency_inserts_trns_after_plte():
    out = add_index0_transparency(_palette_png())
    assert out == _palette_png(with_trns=True)


def test_add_index0_transparency_is_idempotent():
    already = _palette_png(with_trns=True)
    assert add_index0_transparency(already) == already


def test_add_index0_transparency_rejects_non_png():
    try:
        add_index0_transparency(b"<html>error page</html>")
        raise AssertionError("expected ValueError")
    except ValueError:
        pass


def test_add_index0_transparency_rejects_non_palette_png():
    # RGB (color type 2) PNG has no PLTE to hang a palette tRNS off of.
    ihdr = _chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
    idat = _chunk(b"IDAT", zlib.compress(b"\x00\x00\x00\x00"))
    rgb = b"\x89PNG\r\n\x1a\n" + ihdr + idat + _chunk(b"IEND", b"")
    try:
        add_index0_transparency(rgb)
        raise AssertionError("expected ValueError")
    except ValueError:
        pass


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
