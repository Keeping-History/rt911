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
    assert normalize_slug({"identifier": "CCTV3_20010914_010000_x"}) == "cctv3"


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
