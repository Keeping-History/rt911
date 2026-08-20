from weather_recon.zone_resolve import resolve_zone

SEGMENTS = [
    {"zones": ["CTZ005", "NJZ002", "NYZ067"], "area_names":
     "NORTHERN FAIRFIELD NORTHERN MIDDLESEX ORANGE PUTNAM WESTERN PASSAIC",
     "ugc": "", "text": ""},
    {"zones": ["NYZ072"], "area_names": "NEW YORK (MANHATTAN)", "ugc": "", "text": ""},
    {"zones": ["NYZ075", "NYZ078"], "area_names": "KINGS (BROOKLYN) QUEENS",
     "ugc": "", "text": ""},
]


def test_exact_modern_hint_wins():
    assert resolve_zone("LA GUARDIA AIRPORT", "NYZ072", SEGMENTS) == ("NYZ072", "exact")


def test_name_match_when_hint_anachronistic():
    # KJFK's modern hint NYZ178 doesn't exist in 2001; falls to name match
    assert resolve_zone("JOHN F KENNEDY INTERNATIONAL AIRPORT QUEENS", "NYZ178",
                        SEGMENTS) == ("NYZ075", "name")


def test_no_match():
    assert resolve_zone("ALBUQUERQUE INTL", "NMZ001", SEGMENTS) == (None, "none")


def test_stop_tokens_do_not_match():
    # "INTERNATIONAL AIRPORT" alone must not match anything
    assert resolve_zone("INTERNATIONAL AIRPORT", "XXZ999", SEGMENTS) == (None, "none")
