"""
Pure helpers for mirroring IEM's archived NEXRAD CONUS composites (n0r).

The 2001 archive serves 5-minute mosaic PNGs + ESRI world files in a plain
EPSG:4326 grid (verified live: 6000x2600 px, 0.01 deg/px from -126,50).
Gaps exist in the 2001 archive; callers treat a 404 frame as "missing", never
fatal. Geometry consistency across frames is a hard requirement — the index
carries ONE bounds for every frame.
"""

import struct
import zlib
from datetime import date, datetime, timedelta

IEM_BASE = "https://mesonet.agron.iastate.edu/archive/data"
FRAME_INTERVAL = timedelta(minutes=5)
KEY_PREFIX = "weather/radar/"


def frame_times(start_date, end_date):
    """5-minute 'YYYYMMDDHHMM' stamps from start 00:00 through end 23:55 UTC."""
    start = datetime.combine(date.fromisoformat(start_date), datetime.min.time())
    stop = datetime.combine(date.fromisoformat(end_date),
                            datetime.min.time()) + timedelta(days=1)
    out, t = [], start
    while t < stop:
        out.append(t.strftime("%Y%m%d%H%M"))
        t += FRAME_INTERVAL
    return out


def iem_frame_url(stamp):
    return f"{IEM_BASE}/{stamp[:4]}/{stamp[4:6]}/{stamp[6:8]}/GIS/uscomp/n0r_{stamp}.png"


def iem_wld_url(stamp):
    return iem_frame_url(stamp).removesuffix(".png") + ".wld"


def wasabi_frame_key(stamp):
    return f"{KEY_PREFIX}n0r_{stamp}.png"


def png_dimensions(data):
    """(width, height) from the IHDR chunk; ValueError on non-PNG bytes."""
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    return struct.unpack(">II", data[16:24])


def add_index0_transparency(data):
    """Insert a tRNS chunk making palette index 0 fully transparent.

    IEM's n0r composites are palette PNGs whose index 0 (black) means "no
    echo"; without a tRNS chunk MapLibre renders that background as an opaque
    box over the whole CONUS. Inserting tRNS right after PLTE keeps the image
    data untouched. Idempotent: bytes that already carry a tRNS chunk are
    returned unchanged. ValueError on non-PNG or non-palette input.
    """
    if len(data) < 8 or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, plte_end = 8, None
    while pos + 8 <= len(data):
        length, ctype = struct.unpack(">I4s", data[pos:pos + 8])
        if ctype == b"tRNS":
            return data
        if ctype == b"PLTE":
            plte_end = pos + 8 + length + 4
        pos += 8 + length + 4
    if plte_end is None:
        raise ValueError("no PLTE chunk (not a palette PNG)")
    trns = (struct.pack(">I", 1) + b"tRNS" + b"\x00"
            + struct.pack(">I", zlib.crc32(b"tRNS\x00")))
    return data[:plte_end] + trns + data[plte_end:]


def parse_wld(text):
    """ESRI world file -> {dx, dy, ulx, uly} (skew lines 2-3 ignored: always 0)."""
    lines = [float(x) for x in text.split()]
    return {"dx": lines[0], "dy": lines[3], "ulx": lines[4], "uly": lines[5]}


def corners(wld, width, height):
    """MapLibre image-source corner order: TL, TR, BR, BL as [lon, lat]."""
    left, top = wld["ulx"], wld["uly"]
    right = left + wld["dx"] * width
    bottom = top + wld["dy"] * height
    return [[left, top], [right, top], [right, bottom], [left, bottom]]


def build_index(frames_present, missing, bounds, start, end):
    return {
        "product": "n0r", "interval_seconds": 300,
        "timezone": "UTC",   # frame stamps are UTC YYYYMMDDHHMM
        "start": start, "end": end,
        "bounds": bounds,
        "key_prefix": KEY_PREFIX, "key_pattern": "n0r_{stamp}.png",
        "frames": frames_present,
        "missing": missing,
    }
