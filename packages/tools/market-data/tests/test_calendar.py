"""Market calendar: Sept 2001 sessions and the 9/11 closures, all UTC."""

from market_data.market_calendar import build_calendar

EQUITY_TRADING_DAYS = [
    "2001-09-04",
    "2001-09-05",
    "2001-09-06",
    "2001-09-07",
    "2001-09-10",
    "2001-09-17",
    "2001-09-18",
    "2001-09-19",
    "2001-09-20",
    "2001-09-21",
]


def test_equity_sessions_cover_exactly_the_trading_days():
    cal = build_calendar()
    assert [s["date"] for s in cal["equity"]["sessions"]] == EQUITY_TRADING_DAYS


def test_equity_sessions_are_930_to_1600_edt_in_utc():
    cal = build_calendar()
    s = next(x for x in cal["equity"]["sessions"] if x["date"] == "2001-09-10")
    assert s["open"] == "2001-09-10T13:30:00Z"
    assert s["close"] == "2001-09-10T20:00:00Z"


def test_equity_closure_spans_first_impact_to_reopening_bell():
    cal = build_calendar()
    (closure,) = cal["equity"]["closures"]
    assert closure["start"] == "2001-09-11T12:46:00Z"  # 8:46 ET, first impact
    assert closure["end"] == "2001-09-17T13:30:00Z"  # reopening bell
    assert "1933" in closure["reason"]


def test_bond_market_reopens_thursday_913():
    cal = build_calendar()
    (closure,) = cal["bond"]["closures"]
    assert closure["start"] == "2001-09-11T12:46:00Z"
    assert closure["end"] == "2001-09-13T12:00:00Z"  # 8:00 ET Thu 9/13
    bond_days = [s["date"] for s in cal["bond"]["sessions"]]
    assert "2001-09-13" in bond_days
    assert "2001-09-14" in bond_days
    assert "2001-09-11" not in bond_days
    assert "2001-09-12" not in bond_days
