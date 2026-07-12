from weather_recon.obs import (parse_gust, parse_tenths, parse_vis_km, parse_wnd,
                               raw_metar_from_rem, sky_from_gf1, weather_from_mw1)

# Fixtures below are real values from NCEI global-hourly KORD/72530094846,
# 2001-09-09..12 (captured 2026-07-12).


def test_parse_tenths_signed_value():
    assert parse_tenths("+0190,1") == 19.0
    assert parse_tenths("-0056,1") == -5.6


def test_parse_tenths_missing_and_empty():
    assert parse_tenths("+9999,9") is None
    assert parse_tenths("99999,9") is None      # SLP missing form
    assert parse_tenths("") is None
    assert parse_tenths(None) is None


def test_parse_tenths_slp():
    assert parse_tenths("10132,1") == 1013.2


def test_parse_wnd_normal():
    # 140°, speed 46 = 4.6 m/s -> 8.9 kt
    assert parse_wnd("140,1,N,0046,1") == (140, 8.9)


def test_parse_wnd_missing_both():
    assert parse_wnd("999,9,9,9999,9") == (None, None)


def test_parse_wnd_calm():
    # type C = calm: no direction, zero speed
    assert parse_wnd("999,9,C,0000,1") == (None, 0.0)


def test_parse_gust():
    assert parse_gust("0103,1") == 20.0     # 10.3 m/s -> 20.0 kt
    assert parse_gust("") is None
    assert parse_gust(None) is None


def test_parse_vis_km():
    assert parse_vis_km("008046,1,N,1") == 8.0
    assert parse_vis_km("016093,1,9,9") == 16.1
    assert parse_vis_km("999999,9,9,9") is None
    assert parse_vis_km(None) is None


def test_sky_from_gf1_okta_bands():
    assert sky_from_gf1("00,99,1,99,9,99,9,99999,9,99,9,99,9") == "CLR"
    assert sky_from_gf1("02,99,1,99,9,99,9,99999,9,99,9,99,9") == "FEW"
    assert sky_from_gf1("04,99,1,99,9,99,9,99999,9,99,9,99,9") == "SCT"
    assert sky_from_gf1("06,99,1,99,9,99,9,99999,9,99,9,99,9") == "BKN"
    assert sky_from_gf1("08,99,1,99,9,99,9,99999,9,99,9,99,9") == "OVC"


def test_sky_from_gf1_missing():
    assert sky_from_gf1("99,99,1,99,9,99,9,99999,9,99,9,99,9") is None
    assert sky_from_gf1("") is None
    assert sky_from_gf1(None) is None


def test_weather_from_mw1():
    assert weather_from_mw1("10,1") == "mist"
    assert weather_from_mw1("61,1") == "light rain"
    assert weather_from_mw1("95,1") == "thunderstorm"
    assert weather_from_mw1("99,9") == "thunderstorm with hail"


def test_weather_from_mw1_unknown_and_missing():
    assert weather_from_mw1("47,1") is None    # not in condensed map
    assert weather_from_mw1("") is None
    assert weather_from_mw1(None) is None


def test_raw_metar_from_rem():
    rem = ("MET095KORD 091025Z 00000KT 5SM -RA BR BKN036 OVC110 19/18 A2990 "
           "RMK AO2 TSE24 PRESFR TS MOV NE P0005;")
    assert raw_metar_from_rem(rem) == (
        "KORD 091025Z 00000KT 5SM -RA BR BKN036 OVC110 19/18 A2990 "
        "RMK AO2 TSE24 PRESFR TS MOV NE P0005")


def test_raw_metar_from_rem_non_met_or_missing():
    assert raw_metar_from_rem("SYN088AAXX ...") is None
    assert raw_metar_from_rem("") is None
    assert raw_metar_from_rem(None) is None
