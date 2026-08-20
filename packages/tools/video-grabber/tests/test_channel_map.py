"""Tests for channel slug normalization, including the identifier-prefix fallback."""
from video_grabber.ia.channel_map import normalize_slug


def test_known_network_from_title():
    assert normalize_slug({"title": "CNN : September 11, 2001"}) == "cnn"


def test_known_network_from_creator():
    assert normalize_slug({"creator": "Cable News Network"}) == "cnn"


def test_local_call_sign_from_title():
    # W/K + 3 letters is treated as a local affiliate slug.
    assert normalize_slug({"title": "WETA broadcast"}) == "weta"


def test_identifier_prefix_fallback_for_international_feed():
    # No recognizable network in the human fields -> fall back to the
    # identifier's channel-code prefix (the previously-stranded case).
    assert normalize_slug(
        {"identifier": "ANT1_20010914_010000_Antenna_1_Greece",
         "title": "Antenna 1 Greece : ANT1 : September 13, 2001"}
    ) == "ant1"
    assert normalize_slug({"identifier": "NHK_20010914_010000_News"}) == "nhk"
    assert normalize_slug({"identifier": "CCTV3_20010914_010000_x"}) == "cctv4"


def test_identifier_prefix_requires_leading_letter():
    # A date- or number-led identifier must NOT become a channel.
    assert normalize_slug({"identifier": "20010911_0900_unknown"}) is None


def test_unresolvable_returns_none():
    assert normalize_slug({}) is None
    assert normalize_slug({"identifier": "", "title": ""}) is None


def test_human_field_wins_over_identifier_prefix():
    # When the title names a known network, that wins over the raw prefix.
    assert normalize_slug(
        {"identifier": "FOX5NEWS_20010911_x", "title": "Fox 5 News"}
    ) == "fox-news"


def test_identifier_prefix_beats_call_sign_in_title():
    # Regression: four-letter title words (WOLF, KING, WILL, WITH, WALL, ...)
    # match the [WK][A-Z]{3} call-sign pattern and previously minted bogus
    # channels. The identifier prefix is authoritative and must win.
    cases = {
        "CNN_20010911_000000_Wolf_Blitzer_Reports": "cnn",
        "CNN_20010911_010000_Larry_King_Live": "cnn",
        "WRC_20010914_010000_Will__Grace": "wrc",
        "WETA_20010910_230000_The_NewsHour_With_Jim_Lehrer": "weta",
        "NEWSW_20010911_140000_Need_to_Know": "newsw",
        "NTV_20010913_160500_Kino": "ntv",
        "WSBK_20010912_080000_Sex_Wars": "wsbk",
    }
    for identifier, expected in cases.items():
        title = identifier.split("_", 3)[-1].replace("_", " ")
        assert normalize_slug({"identifier": identifier, "title": title}) == expected


def test_call_sign_in_title_still_works_without_identifier():
    # The call-sign path is preserved as a last resort when no identifier
    # prefix is present.
    assert normalize_slug({"title": "WUSA broadcast"}) == "wusa"
