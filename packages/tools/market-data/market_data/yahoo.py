"""Yahoo chart API: fetch daily bars + split events, un-adjust to printed prices."""

from datetime import datetime
from urllib.parse import quote
from zoneinfo import ZoneInfo

import httpx

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"
_PRICE_FIELDS = ("open", "high", "low", "close")


def parse_chart(data: dict) -> list[dict]:
    """Yahoo v8 chart payload → daily bars [{date, open, high, low, close, volume}].

    Dates are the trading day in the exchange's own timezone. Rows with a null
    close (Yahoo pads some ranges) are dropped.
    """
    result = data.get("chart", {}).get("result")
    if not result:
        err = (data.get("chart", {}).get("error") or {}).get("description", "unknown")
        raise ValueError(f"yahoo returned no data: {err}")
    result = result[0]
    tz = ZoneInfo(result["meta"].get("exchangeTimezoneName", "America/New_York"))
    quote_ = result["indicators"]["quote"][0]
    bars = []
    for i, ts in enumerate(result.get("timestamp", [])):
        if quote_["close"][i] is None:
            continue
        bar = {"date": datetime.fromtimestamp(ts, tz).strftime("%Y-%m-%d")}
        for f in _PRICE_FIELDS:
            bar[f] = quote_[f][i]
        bar["volume"] = quote_["volume"][i]
        bars.append(bar)
    return bars


def unadjust(bars: list[dict], splits: list[dict]) -> list[dict]:
    """Undo Yahoo's split adjustment: multiply each bar's prices by the product
    of numerator/denominator for every split strictly after the bar's date.
    Recovers the price as printed at the time. Volume is left untouched."""
    out = []
    for bar in bars:
        bar_ts = datetime.strptime(bar["date"], "%Y-%m-%d").timestamp()
        factor = 1.0
        for s in splits:
            if s["date"] > bar_ts:
                factor *= s["numerator"] / s["denominator"]
        adjusted = dict(bar)
        for f in _PRICE_FIELDS:
            if adjusted.get(f) is not None:
                adjusted[f] = adjusted[f] * factor
        out.append(adjusted)
    return out


def fetch_chart(symbol: str, start: int, end: int, client: httpx.Client) -> dict:
    """Daily bars for [start, end) epoch seconds. Raises on HTTP error."""
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{quote(symbol)}"
        f"?period1={start}&period2={end}&interval=1d"
    )
    resp = client.get(url, headers={"User-Agent": USER_AGENT})
    resp.raise_for_status()
    return resp.json()


def fetch_splits(symbol: str, client: httpx.Client) -> list[dict]:
    """All split events over the symbol's full history."""
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{quote(symbol)}"
        f"?period1=0&period2=9999999999&interval=3mo&events=splits"
    )
    resp = client.get(url, headers={"User-Agent": USER_AGENT})
    resp.raise_for_status()
    result = resp.json()["chart"]["result"][0]
    events = (result.get("events") or {}).get("splits") or {}
    return sorted(events.values(), key=lambda s: s["date"])
