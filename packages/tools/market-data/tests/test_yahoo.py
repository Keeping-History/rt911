"""Yahoo chart-API parsing and split un-adjustment."""

import pytest

from market_data.yahoo import parse_chart, unadjust

# 2001-09-07 and 2001-09-10, both 13:30:00Z (9:30 ET market open stamps)
TS_0907 = 999869400
TS_0910 = 1000128600

CHART = {
    "chart": {
        "result": [
            {
                "meta": {"symbol": "TEST", "exchangeTimezoneName": "America/New_York"},
                "timestamp": [TS_0907, TS_0910],
                "indicators": {
                    "quote": [
                        {
                            "open": [10.0, 11.0],
                            "high": [12.0, 13.0],
                            "low": [9.0, 10.5],
                            "close": [11.5, 12.5],
                            "volume": [1000, 2000],
                        }
                    ]
                },
            }
        ],
        "error": None,
    }
}


def test_parse_chart_maps_timestamps_to_exchange_dates():
    bars = parse_chart(CHART)
    assert [b["date"] for b in bars] == ["2001-09-07", "2001-09-10"]
    assert bars[0] == {
        "date": "2001-09-07",
        "open": 10.0,
        "high": 12.0,
        "low": 9.0,
        "close": 11.5,
        "volume": 1000,
    }


def test_parse_chart_skips_null_rows():
    chart = {
        "chart": {
            "result": [
                {
                    "meta": {"symbol": "T", "exchangeTimezoneName": "America/New_York"},
                    "timestamp": [TS_0907, TS_0910],
                    "indicators": {
                        "quote": [
                            {
                                "open": [10.0, None],
                                "high": [12.0, None],
                                "low": [9.0, None],
                                "close": [11.5, None],
                                "volume": [1000, None],
                            }
                        ]
                    },
                }
            ],
            "error": None,
        }
    }
    bars = parse_chart(chart)
    assert len(bars) == 1
    assert bars[0]["date"] == "2001-09-07"


def test_parse_chart_raises_on_no_result():
    with pytest.raises(ValueError, match="no data"):
        parse_chart({"chart": {"result": None, "error": {"description": "Data doesn't exist"}}})


def _bar(date, close):
    return {"date": date, "open": close, "high": close, "low": close, "close": close, "volume": 1}


def test_unadjust_multiplies_by_splits_after_bar_date():
    # 2:1 split in 2003 → Sept-2001 raw prices are halved; un-adjust doubles them
    bars = [_bar("2001-09-10", 28.79)]
    splits = [{"date": 1045666200, "numerator": 2, "denominator": 1}]  # 2003-02-19
    out = unadjust(bars, splits)
    assert out[0]["close"] == pytest.approx(57.58)
    assert out[0]["open"] == pytest.approx(57.58)
    assert out[0]["volume"] == 1  # volume untouched


def test_unadjust_reverse_split_scales_down():
    # AIG-style 1-for-20 reverse split (2009): raw 2001 close 1485.20 → printed 74.26
    bars = [_bar("2001-09-10", 1485.20)]
    splits = [{"date": 1246368600, "numerator": 1, "denominator": 20}]
    out = unadjust(bars, splits)
    assert out[0]["close"] == pytest.approx(74.26)


def test_unadjust_ignores_splits_on_or_before_bar_date():
    bars = [_bar("2001-09-10", 50.0)]
    splits = [{"date": 999869400, "numerator": 2, "denominator": 1}]  # 2001-09-07, before
    out = unadjust(bars, splits)
    assert out[0]["close"] == pytest.approx(50.0)


def test_unadjust_compounds_multiple_splits():
    bars = [_bar("2001-09-10", 1.0)]
    splits = [
        {"date": 1100000000, "numerator": 2, "denominator": 1},
        {"date": 1400000000, "numerator": 7, "denominator": 1},
        {"date": 1600000000, "numerator": 4, "denominator": 1},
    ]
    out = unadjust(bars, splits)
    assert out[0]["close"] == pytest.approx(56.0)
