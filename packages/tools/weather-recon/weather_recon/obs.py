"""
Parsers for NCEI global-hourly (ISD) CSV fields -> weather_observations rows.

Field formats: https://www.ncei.noaa.gov/data/global-hourly/doc/isd-format-document.pdf
All numeric ISD fields are scaled integers with sentinel missing values and a
trailing quality code; the archive is already QC'd, so quality codes are not
re-filtered here. Fixtures in tests/test_obs.py are captured from the real
KORD 2001-09 data.
"""

MS_TO_KT = 1.94384

# Condensed WMO ww (present weather, MW1) code -> display text. Codes not in
# the map render as no present-weather (None) rather than guessing.
WW_CODES = {
    "00": None, "01": None, "02": None, "03": None,
    "04": "smoke", "05": "haze", "06": "dust", "07": "dust",
    "10": "mist", "11": "fog patches", "12": "fog patches",
    "13": "lightning", "17": "thunder", "18": "squalls", "19": "funnel cloud",
    "40": "fog", "41": "fog patches", "42": "fog", "43": "fog",
    "44": "fog", "45": "fog", "46": "fog", "48": "freezing fog",
    "49": "freezing fog",
    "50": "light drizzle", "51": "light drizzle", "52": "drizzle",
    "53": "drizzle", "54": "heavy drizzle", "55": "heavy drizzle",
    "56": "freezing drizzle", "57": "freezing drizzle",
    "58": "drizzle and rain", "59": "drizzle and rain",
    "60": "light rain", "61": "light rain", "62": "rain", "63": "rain",
    "64": "heavy rain", "65": "heavy rain",
    "66": "freezing rain", "67": "freezing rain",
    "68": "rain and snow", "69": "rain and snow",
    "70": "light snow", "71": "light snow", "72": "snow", "73": "snow",
    "74": "heavy snow", "75": "heavy snow", "76": "ice crystals",
    "77": "snow grains", "79": "ice pellets",
    "80": "light rain showers", "81": "rain showers", "82": "heavy rain showers",
    "83": "rain and snow showers", "84": "rain and snow showers",
    "85": "snow showers", "86": "snow showers", "87": "ice pellet showers",
    "88": "ice pellet showers", "89": "hail showers", "90": "hail showers",
    "91": "thunderstorm", "92": "thunderstorm with rain",
    "93": "thunderstorm with snow", "94": "thunderstorm with hail",
    "95": "thunderstorm", "96": "thunderstorm with hail",
    "97": "heavy thunderstorm", "98": "thunderstorm with dust",
    "99": "thunderstorm with hail",
}

_SKY_BANDS = [(0, "CLR"), (2, "FEW"), (4, "SCT"), (7, "BKN"), (8, "OVC")]


def parse_tenths(s):
    """Signed scaled-by-10 field ('+0190,1' -> 19.0). None on missing."""
    if not s:
        return None
    val = s.split(",")[0]
    if val in ("+9999", "-9999", "9999", "99999", "+99999"):
        return None
    return round(int(val) / 10.0, 1)


def parse_wnd(s):
    """WND 'dir,q,type,speed,q' -> (dir_deg | None, speed_kt | None)."""
    if not s:
        return (None, None)
    parts = s.split(",")
    if len(parts) < 5:
        return (None, None)
    direction = None if parts[0] == "999" else int(parts[0])
    if parts[3] == "9999":
        speed = 0.0 if parts[2] == "C" else None
    else:
        speed = round(int(parts[3]) / 10.0 * MS_TO_KT, 1)
    return (direction, speed)


def parse_gust(s):
    """OC1 'speed,q' (m/s*10) -> kt | None."""
    if not s:
        return None
    val = s.split(",")[0]
    if val in ("9999", ""):
        return None
    return round(int(val) / 10.0 * MS_TO_KT, 1)


def parse_vis_km(s):
    """VIS 'meters,q,variability,q' -> km | None."""
    if not s:
        return None
    val = s.split(",")[0]
    if val == "999999":
        return None
    return round(int(val) / 1000.0, 1)


def sky_from_gf1(s):
    """GF1 total-coverage oktas (field 1) -> CLR/FEW/SCT/BKN/OVC | None."""
    if not s:
        return None
    code = s.split(",")[0]
    if not code.isdigit() or int(code) > 8:
        return None
    oktas = int(code)
    for bound, label in _SKY_BANDS:
        if oktas <= bound:
            return label
    return None


def weather_from_mw1(s):
    """MW1 'ww,q' -> display text | None."""
    if not s:
        return None
    return WW_CODES.get(s.split(",")[0])


def raw_metar_from_rem(s):
    """REM 'MET<3-digit len><payload>;' -> payload | None for non-MET remarks."""
    if not s or not s.startswith("MET") or not s[3:6].isdigit():
        return None
    return s[6:].rstrip(";").strip()
