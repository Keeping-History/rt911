"""Assemble, validate, and emit market-data.json. Fails loudly rather than
emitting a bundle with silent gaps — this data is the whole product surface."""

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

from market_data.fred import fetch_series
from market_data.market_calendar import build_calendar
from market_data.symbols import SYMBOLS, Symbol
from market_data.yahoo import fetch_chart, fetch_splits, parse_chart, unadjust

RANGE = {"start": "2001-09-04", "end": "2001-09-21"}
# Sessions the product window (Sep 9–18) actually displays, plus the prior
# close needed for change calculations on 9/10.
REQUIRED_DATES = ["2001-09-07", "2001-09-10", "2001-09-17", "2001-09-18"]

# Verified closes; validation refuses to emit if fetched data disagrees.
ANCHORS = {"DJIA": {"2001-09-10": 9605.51, "2001-09-17": 8920.70}}
ANCHOR_TOLERANCE = 0.5  # index points
SPOT_CHECK_TOLERANCE = 0.01  # relative

# Yahoo daily-bar epoch range: 2001-09-04 .. 2001-09-22 UTC
PERIOD1, PERIOD2 = 999561600, 1001116800

OVERRIDES_PATH = Path(__file__).parent / "overrides.json"


def _market(sym: Symbol) -> str:
    return "bond" if "bond" in sym.tags else "equity"


def _fill_missing_opens(bars: list[dict]) -> None:
    """Archival newspaper tables print high/low/close but not open. Where open
    is absent, approximate it as the prior close clamped into [low, high] —
    exact for a gapless open, and lands on the day's extreme for gap days
    (e.g. 9/17 crash opens)."""
    prev_close = None
    for bar in bars:
        if "open" not in bar and "high" in bar and "low" in bar and prev_close is not None:
            bar["open"] = min(max(prev_close, bar["low"]), bar["high"])
        prev_close = bar["close"]


def assemble(fetched: dict, overrides: dict, symbols: list[Symbol] = SYMBOLS) -> dict:
    out_symbols = []
    for sym in symbols:
        if sym.source == "override":
            if sym.symbol not in overrides:
                raise ValueError(
                    f"{sym.symbol} is override-sourced but has no entry in overrides.json"
                )
            entry = overrides[sym.symbol]
            bars = [dict(b) for b in entry["bars"]]
            source = f"override:{entry['citation']}"
        else:
            if sym.symbol not in fetched:
                raise ValueError(f"{sym.symbol} ({sym.source}) has no fetched data")
            bars = [dict(b) for b in fetched[sym.symbol]]
            source = sym.source
        bars = [b for b in bars if RANGE["start"] <= b["date"] <= RANGE["end"]]
        bars.sort(key=lambda b: b["date"])
        _fill_missing_opens(bars)
        out_symbols.append(
            {
                "symbol": sym.symbol,
                "name": sym.name,
                "tags": list(sym.tags),
                "unit": sym.unit,
                "market": _market(sym),
                "source": source,
                "bars": bars,
            }
        )
    return {
        "version": 1,
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "range": dict(RANGE),
        "calendar": build_calendar(),
        "symbols": out_symbols,
    }


def validate(bundle: dict, symbols: list[Symbol] = SYMBOLS) -> list[str]:
    """Return a list of human-readable problems; empty means emittable."""
    errors = []
    by_sym = {s["symbol"]: s for s in bundle["symbols"]}

    for sym in symbols:
        entry = by_sym.get(sym.symbol)
        if entry is None:
            errors.append(f"{sym.symbol}: missing from bundle")
            continue
        dates = {b["date"] for b in entry["bars"]}
        for d in REQUIRED_DATES:
            if d not in dates:
                errors.append(f"{sym.symbol}: no bar for required date {d}")
        if entry["market"] == "equity":
            for b in entry["bars"]:
                if any(f not in b for f in ("open", "high", "low", "close")):
                    errors.append(f"{sym.symbol}: bar {b['date']} lacks full OHLC")
        if sym.check_close_2001_09_10 is not None:
            bar = next((b for b in entry["bars"] if b["date"] == "2001-09-10"), None)
            if bar is not None:
                expected = sym.check_close_2001_09_10
                if abs(bar["close"] - expected) / expected > SPOT_CHECK_TOLERANCE:
                    errors.append(
                        f"{sym.symbol}: 2001-09-10 close {bar['close']:.2f} does not match "
                        f"archival spot-check {expected} (±1%)"
                    )

    for sym_name, closes in ANCHORS.items():
        entry = by_sym.get(sym_name)
        if entry is None:
            continue
        bar_by_date = {b["date"]: b for b in entry["bars"]}
        for date, expected in closes.items():
            bar = bar_by_date.get(date)
            if bar is None:
                continue  # already reported as missing required date
            if abs(bar["close"] - expected) > ANCHOR_TOLERANCE:
                errors.append(
                    f"{sym_name}: {date} close {bar['close']:.2f} != anchor {expected}"
                )
    return errors


def fetch_all(symbols: list[Symbol] = SYMBOLS, delay: float = 0.5) -> dict:
    """Fetch every non-override symbol from its source. Returns {display: bars}."""
    fetched = {}
    with httpx.Client(timeout=30) as client:
        for sym in symbols:
            provider, _, remote = sym.source.partition(":")
            if provider == "yahoo":
                chart = fetch_chart(remote, PERIOD1, PERIOD2, client)
                bars = parse_chart(chart)
                if not remote.startswith("^"):
                    bars = unadjust(bars, fetch_splits(remote, client))
                fetched[sym.symbol] = bars
                time.sleep(delay)
            elif provider == "fred":
                fetched[sym.symbol] = fetch_series(
                    remote, RANGE["start"], RANGE["end"], client
                )
    return fetched


def load_overrides() -> dict:
    if not OVERRIDES_PATH.exists():
        return {}
    return json.loads(OVERRIDES_PATH.read_text())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="market-data.json")
    args = parser.parse_args(argv)

    print(f"fetching {len(SYMBOLS)} symbols…", file=sys.stderr)
    bundle = assemble(fetch_all(), load_overrides())
    errors = validate(bundle)
    if errors:
        for e in errors:
            print(f"ERROR: {e}", file=sys.stderr)
        print(f"\n{len(errors)} problem(s) — refusing to emit.", file=sys.stderr)
        return 1
    Path(args.out).write_text(json.dumps(bundle, indent=1) + "\n")
    n_bars = sum(len(s["bars"]) for s in bundle["symbols"])
    print(f"wrote {args.out}: {len(bundle['symbols'])} symbols, {n_bars} bars", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
