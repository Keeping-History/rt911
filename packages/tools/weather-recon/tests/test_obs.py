from weather_recon.obs import (observation_from_row, parse_gust, parse_tenths,
                               parse_vis_km, parse_wnd, raw_metar_from_rem,
                               shape_station_rows, sky_from_gf1, weather_from_mw1)

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
    assert weather_from_mw1("39,1") is None    # not in condensed map (blowing snow band)
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


KORD_FM15 = {
    "DATE": "2001-09-09T10:25:00", "REPORT_TYPE": "FM-15",
    "WND": "999,9,9,9999,9", "TMP": "+0190,1", "DEW": "+0180,1",
    "SLP": "99999,9", "VIS": "008046,1,N,1",
    "GF1": "08,99,1,99,9,99,9,99999,9,99,9,99,9", "MW1": "10,1", "OC1": "",
    "REM": "MET095KORD 091025Z 00000KT 5SM -RA BR BKN036 OVC110 19/18 A2990 "
           "RMK AO2 TSE24 PRESFR TS MOV NE P0005;",
}


def test_observation_from_row_shapes_all_columns():
    obs = observation_from_row(KORD_FM15, "KORD")
    assert obs == {
        "station_id": "KORD", "observed_at": "2001-09-09T10:25:00",
        "temp_c": 19.0, "dewpoint_c": 18.0, "wind_dir_deg": None,
        "wind_speed_kt": None, "gust_kt": None, "pressure_hpa": None,
        "sky_condition": "OVC", "present_weather": "mist",
        "visibility_km": 8.0,
        "raw_metar": "KORD 091025Z 00000KT 5SM -RA BR BKN036 OVC110 19/18 "
                     "A2990 RMK AO2 TSE24 PRESFR TS MOV NE P0005",
    }


def test_observation_from_row_missing_optional_columns():
    # dynamic columns: GF1/MW1/OC1/REM may be entirely absent from a response
    obs = observation_from_row({"DATE": "2001-09-10T04:00:00",
                                "REPORT_TYPE": "FM-15",
                                "WND": "140,1,N,0046,1", "TMP": "+0206,1",
                                "DEW": "+0150,1", "SLP": "10132,1",
                                "VIS": "016093,1,9,9"}, "CYYZ")
    assert obs["wind_dir_deg"] == 140 and obs["wind_speed_kt"] == 8.9
    assert obs["pressure_hpa"] == 1013.2 and obs["visibility_km"] == 16.1
    assert obs["sky_condition"] is None and obs["present_weather"] is None
    assert obs["raw_metar"] is None


def test_shape_filters_to_metar_and_speci():
    rows = [dict(KORD_FM15),
            {**KORD_FM15, "DATE": "2001-09-09T11:00:00", "REPORT_TYPE": "SY-MT"},
            {**KORD_FM15, "DATE": "2001-09-09T11:15:00", "REPORT_TYPE": "SOD"},
            {**KORD_FM15, "DATE": "2001-09-09T11:30:00", "REPORT_TYPE": "FM-16"}]
    shaped = shape_station_rows(rows, "KORD")
    assert [o["observed_at"] for o in shaped] == ["2001-09-09T10:25:00",
                                                  "2001-09-09T11:30:00"]


def test_shape_dedupes_same_timestamp_preferring_fm15():
    speci = {**KORD_FM15, "REPORT_TYPE": "FM-16", "TMP": "+0250,1"}
    shaped = shape_station_rows([speci, dict(KORD_FM15)], "KORD")
    assert len(shaped) == 1 and shaped[0]["temp_c"] == 19.0


def test_shape_sorts_by_time():
    later = {**KORD_FM15, "DATE": "2001-09-09T12:00:00"}
    shaped = shape_station_rows([later, dict(KORD_FM15)], "KORD")
    assert [o["observed_at"] for o in shaped] == ["2001-09-09T10:25:00",
                                                  "2001-09-09T12:00:00"]
