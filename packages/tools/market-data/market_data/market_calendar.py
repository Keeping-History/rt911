"""The Sept 2001 trading calendar, hardcoded — this is immutable history.

All timestamps UTC (September = EDT = UTC-4). Named market_calendar to avoid
shadowing the stdlib calendar module.
"""

EQUITY_DAYS = [
    "2001-09-04",
    "2001-09-05",
    "2001-09-06",
    "2001-09-07",
    "2001-09-10",
    # 9/11–9/14: NYSE & Nasdaq closed
    "2001-09-17",
    "2001-09-18",
    "2001-09-19",
    "2001-09-20",
    "2001-09-21",
]

# The bond market reopened Thursday 9/13, two trading days before equities.
BOND_DAYS = EQUITY_DAYS[:5] + ["2001-09-13", "2001-09-14"] + EQUITY_DAYS[5:]

# Display decision (issue #185): the halt banner starts at the first impact,
# 8:46 ET — trading never opened on 9/11.
HALT_START = "2001-09-11T12:46:00Z"

EQUITY_REASON = (
    "NYSE and Nasdaq closed following the September 11 attacks — "
    "the longest closure since 1933"
)
BOND_REASON = "US bond market closed following the September 11 attacks"


def _sessions(days: list[str], open_utc: str, close_utc: str) -> list[dict]:
    return [
        {"date": d, "open": f"{d}T{open_utc}Z", "close": f"{d}T{close_utc}Z"} for d in sorted(days)
    ]


def build_calendar() -> dict:
    return {
        "equity": {
            # 9:30–16:00 ET
            "sessions": _sessions(EQUITY_DAYS, "13:30:00", "20:00:00"),
            "closures": [
                {"start": HALT_START, "end": "2001-09-17T13:30:00Z", "reason": EQUITY_REASON}
            ],
        },
        "bond": {
            # 8:00–17:00 ET (Treasury cash market)
            "sessions": _sessions(BOND_DAYS, "12:00:00", "21:00:00"),
            "closures": [
                {"start": HALT_START, "end": "2001-09-13T12:00:00Z", "reason": BOND_REASON}
            ],
        },
    }
