from weather_recon.afos import (expand_ugc, parse_wmo_issued, split_products,
                                split_segments)

# Real ZFPOKX excerpts captured live from the IEM AFOS archive, 2026-07-12.
PRODUCT = """FPUS51 KOKX 111905
ZFPOKX
ZONE (COUNTY) FORECASTS
NATIONAL WEATHER SERVICE NEW YORK NY


CTZ005>008-NJZ002-NYZ067-068-120905-
NORTHERN FAIRFIELD-NORTHERN MIDDLESEX-NORTHERN NEW HAVEN-
NORTHERN NEW LONDON-ORANGE-PUTNAM-WESTERN PASSAIC-
305 PM EDT TUE SEP 11 2001

.TONIGHT...CLEAR. LOWS NEAR 50. NORTHWEST WIND AROUND 10 MPH
BECOMING NORTH 5 TO 10 MPH.
.WEDNESDAY...SUNNY. HIGHS IN THE UPPER 70S.

$$

NYZ072-120905-
NEW YORK (MANHATTAN)-
305 PM EDT TUE SEP 11 2001

.TONIGHT...CLEAR. LOWS IN THE MIDDLE 50S.

$$
"""

RAW_STREAM = ("\x01\n080 \n" + PRODUCT + "\x03"
              "\x01\n081 \nFPUS51 KOKX 120859\nZFPOKX\nZONE FORECASTS\n\n"
              "NYZ072-121500-\nNEW YORK (MANHATTAN)-\n"
              "459 AM EDT WED SEP 12 2001\n\n.TODAY...SUNNY.\n\n$$\n\x03")


def test_split_products():
    prods = split_products(RAW_STREAM)
    assert len(prods) == 2
    assert prods[0].startswith("FPUS51 KOKX 111905")
    assert prods[1].startswith("FPUS51 KOKX 120859")


def test_parse_wmo_issued():
    assert parse_wmo_issued(PRODUCT, 2001, 9) == "2001-09-11T19:05:00"


def test_expand_ugc_ranges_prefixes_and_bare_numbers():
    assert expand_ugc("CTZ005>008-NJZ002-NYZ067-068-120905-") == [
        "CTZ005", "CTZ006", "CTZ007", "CTZ008", "NJZ002", "NYZ067", "NYZ068"]


def test_expand_ugc_single_zone():
    assert expand_ugc("NYZ072-120905-") == ["NYZ072"]


def test_split_segments():
    segs = split_segments(PRODUCT)
    assert len(segs) == 2
    assert segs[0]["zones"] == ["CTZ005", "CTZ006", "CTZ007", "CTZ008",
                                "NJZ002", "NYZ067", "NYZ068"]
    assert "NORTHERN FAIRFIELD" in segs[0]["area_names"]
    assert ".TONIGHT...CLEAR. LOWS NEAR 50." in segs[0]["text"]
    assert segs[1]["zones"] == ["NYZ072"]
    assert "MANHATTAN" in segs[1]["area_names"]


def test_split_segments_multiline_ugc():
    prod = ("FPUS51 KBOX 111845\nZFPBOX\n\n"
            "MAZ002>004-CTZ002-\nRIZ001-120845-\nAREA ONE-AREA TWO-\n"
            "245 PM EDT TUE SEP 11 2001\n\n.TONIGHT...CLEAR.\n\n$$\n")
    segs = split_segments(prod)
    assert segs[0]["zones"] == ["MAZ002", "MAZ003", "MAZ004", "CTZ002", "RIZ001"]
