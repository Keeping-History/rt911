"""FRED CSV parsing (10-yr Treasury yield)."""

from market_data.fred import parse_fred_csv

CSV = """observation_date,DGS10
2001-09-07,4.80
2001-09-10,4.84
2001-09-11,.
2001-09-12,.
2001-09-13,4.64
"""


def test_parses_dates_and_values_as_close_only_bars():
    bars = parse_fred_csv(CSV)
    assert bars[0] == {"date": "2001-09-07", "close": 4.80}
    assert bars[1] == {"date": "2001-09-10", "close": 4.84}


def test_skips_missing_observations():
    bars = parse_fred_csv(CSV)
    assert [b["date"] for b in bars] == ["2001-09-07", "2001-09-10", "2001-09-13"]


def test_skips_empty_observations():
    # Current fredgraph.csv emits empty values for market-closed days, not "."
    bars = parse_fred_csv("observation_date,DGS10\n2001-09-10,4.84\n2001-09-11,\n2001-09-13,4.64\n")
    assert [b["date"] for b in bars] == ["2001-09-10", "2001-09-13"]


def test_tolerates_legacy_uppercase_date_header():
    bars = parse_fred_csv("DATE,DGS10\n2001-09-07,4.80\n")
    assert bars == [{"date": "2001-09-07", "close": 4.80}]
