"""
Resolve a station to its 2001 NWS forecast zone.

api.weather.gov's forecastZone is a MODERN id (zones were re-split over the
years — KJFK's NYZ178 didn't exist in 2001), so the hint is trusted only when
it literally appears in the archived products. Otherwise the station's name
is token-matched against segment area-name headers from the real 2001 ZFPs.
"""

import re

STOP_TOKENS = {"NORTHERN", "SOUTHERN", "EASTERN", "WESTERN", "AIRPORT",
               "INTERNATIONAL", "INTL", "REGIONAL", "FIELD", "MUNI",
               "MUNICIPAL", "COUNTY", "METRO"}


def _tokens(s):
    words = re.split(r"[^A-Z]+", s.upper())
    return {w for w in words if len(w) > 2 and w not in STOP_TOKENS}


def resolve_zone(station_name, modern_zone_hint, segments):
    for seg in segments:
        if modern_zone_hint and modern_zone_hint in seg["zones"]:
            return modern_zone_hint, "exact"
    station_tokens = _tokens(station_name)
    best, best_score = None, 0
    for seg in segments:
        score = len(station_tokens & _tokens(seg["area_names"]))
        if score > best_score:
            best, best_score = seg, score
    if best is not None and best_score >= 1:
        return best["zones"][0], "name"
    return None, "none"
