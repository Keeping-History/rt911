"""Bundle assembly and fail-loud validation."""

import pytest

from market_data.generate import REQUIRED_DATES, assemble, validate
from market_data.symbols import Symbol

DATES = ["2001-09-07", "2001-09-10", "2001-09-17", "2001-09-18"]


def _bars(closes: dict[str, float], **extra) -> list[dict]:
    return [
        {"date": d, "open": c, "high": c + 1, "low": c - 1, "close": c, "volume": 100, **extra}
        for d, c in closes.items()
    ]


IDX = Symbol("DJIA", "Dow Jones Industrials", ("index",), "yahoo:^DJI")
STOCK = Symbol("LUV", "Southwest Airlines", ("airline",), "yahoo:LUV")
GONE = Symbol("AMR", "AMR (American Airlines)", ("airline",), "override")
YIELD = Symbol("US10Y", "10-Yr Treasury Yield", ("bond",), "fred:DGS10", unit="percent")

DJIA_CLOSES = {
    "2001-09-07": 9605.85,
    "2001-09-10": 9605.51,
    "2001-09-17": 8920.70,
    "2001-09-18": 8903.40,
}


def good_inputs():
    fetched = {
        "DJIA": _bars(DJIA_CLOSES),
        "LUV": _bars({d: 17.0 for d in DATES}),
        "US10Y": [{"date": d, "close": 4.8} for d in DATES + ["2001-09-13"]],
    }
    overrides = {
        "AMR": {
            "citation": "WSJ 2001-09-18 stock tables",
            "bars": _bars({d: 29.0 for d in DATES}),
        }
    }
    return fetched, overrides


SYMS = [IDX, STOCK, GONE, YIELD]


def test_assemble_merges_fetched_and_override_symbols():
    bundle = assemble(*good_inputs(), symbols=SYMS)
    by_sym = {s["symbol"]: s for s in bundle["symbols"]}
    assert set(by_sym) == {"DJIA", "LUV", "AMR", "US10Y"}
    assert by_sym["LUV"]["source"] == "yahoo:LUV"
    assert by_sym["AMR"]["source"] == "override:WSJ 2001-09-18 stock tables"
    assert by_sym["AMR"]["bars"][0]["close"] == 29.0


def test_assemble_sets_market_by_unit():
    bundle = assemble(*good_inputs(), symbols=SYMS)
    by_sym = {s["symbol"]: s for s in bundle["symbols"]}
    assert by_sym["US10Y"]["market"] == "bond"
    assert by_sym["DJIA"]["market"] == "equity"


def test_assemble_includes_calendar_and_range():
    bundle = assemble(*good_inputs(), symbols=SYMS)
    assert bundle["range"] == {"start": "2001-09-04", "end": "2001-09-21"}
    assert bundle["calendar"]["equity"]["sessions"]
    assert bundle["version"] == 1


def test_assemble_fills_missing_open_by_clamping_prev_close():
    # Crash-day override with no open: prev close 29.0 clamps into [17.9, 21.5] → 21.5
    fetched, overrides = good_inputs()
    overrides["AMR"]["bars"] = _bars({"2001-09-07": 30.0, "2001-09-10": 29.0}) + [
        {"date": "2001-09-17", "high": 21.5, "low": 17.9, "close": 18.0, "volume": 1},
        {"date": "2001-09-18", "open": 18.5, "high": 19.0, "low": 17.0, "close": 17.5, "volume": 1},
    ]
    bundle = assemble(fetched, overrides, symbols=SYMS)
    amr = next(s for s in bundle["symbols"] if s["symbol"] == "AMR")
    b_0917 = next(b for b in amr["bars"] if b["date"] == "2001-09-17")
    assert b_0917["open"] == 21.5


def test_assemble_fails_loudly_when_override_symbol_missing():
    fetched, _ = good_inputs()
    with pytest.raises(ValueError, match="AMR"):
        assemble(fetched, {}, symbols=SYMS)


def test_validate_ok_on_good_bundle():
    bundle = assemble(*good_inputs(), symbols=SYMS)
    assert validate(bundle, symbols=SYMS) == []


def test_validate_flags_missing_required_dates():
    fetched, overrides = good_inputs()
    fetched["LUV"] = _bars({"2001-09-07": 17.0, "2001-09-10": 17.0})  # no reopen bars
    bundle = assemble(fetched, overrides, symbols=SYMS)
    errors = validate(bundle, symbols=SYMS)
    assert any("LUV" in e and "2001-09-17" in e for e in errors)


def test_validate_flags_anchor_mismatch():
    fetched, overrides = good_inputs()
    fetched["DJIA"] = _bars({**DJIA_CLOSES, "2001-09-10": 9999.0})
    bundle = assemble(fetched, overrides, symbols=SYMS)
    errors = validate(bundle, symbols=SYMS)
    assert any("DJIA" in e and "9605.51" in e for e in errors)


def test_validate_requires_full_ohlc_on_equity_bars():
    fetched, overrides = good_inputs()
    overrides["AMR"]["bars"] = [
        {"date": d, "close": 29.0} for d in DATES
    ]  # close-only equity bars
    bundle = assemble(fetched, overrides, symbols=SYMS)
    errors = validate(bundle, symbols=SYMS)
    assert any("AMR" in e and "ohlc" in e.lower() for e in errors)


def test_validate_allows_close_only_bond_bars():
    bundle = assemble(*good_inputs(), symbols=SYMS)
    assert validate(bundle, symbols=SYMS) == []


def test_validate_checks_spot_close():
    sym = Symbol("LUV", "Southwest", ("airline",), "yahoo:LUV", check_close_2001_09_10=30.0)
    syms = [IDX, sym, GONE, YIELD]
    bundle = assemble(*good_inputs(), symbols=syms)  # fetched close is 17.0, expected 30.0
    errors = validate(bundle, symbols=syms)
    assert any("LUV" in e and "30.0" in e for e in errors)


def test_required_dates_are_the_product_critical_sessions():
    assert REQUIRED_DATES == ["2001-09-07", "2001-09-10", "2001-09-17", "2001-09-18"]
