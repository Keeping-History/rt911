"""Curated symbol universe for the MarketWatch app (issue #185).

Every symbol is displayed under its *2001-era* ticker. `source` says where the
generator gets daily bars:

- ``yahoo:<ticker>`` — Yahoo chart API. The queried ticker is sometimes the
  *modern* name of the same share lineage (HWP→HPQ, MWD→MS, UTX→RTX, SBC→T);
  prices are un-adjusted back to as-printed-in-2001 via split events.
- ``fred:<series>`` — FRED CSV (yields, in percent).
- ``override`` — no free machine-readable source survives (delisted paper:
  AMR, LEH, old GM, …). Bars are hand-entered in ``overrides.json`` from
  archival sources; the generator fails loudly if any are missing.

Beware ticker reuse: today's UAL/DAL/GM/HLT/AA are *different companies* (or
re-listings) wearing an old symbol. Lineages were verified empirically
(firstTradeDate + sanity close) on 2026-07-10.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Symbol:
    symbol: str  # 2001-era display ticker
    name: str
    tags: tuple[str, ...]
    source: str
    unit: str = "usd"  # "usd" | "percent"
    check_close_2001_09_10: float | None = None  # archival spot-check, ±1% tolerance


IDX = "index"
DOW = "dow30"

SYMBOLS: list[Symbol] = [
    # ---- Indices / rates -------------------------------------------------
    Symbol("DJIA", "Dow Jones Industrials", (IDX,), "yahoo:^DJI", check_close_2001_09_10=9605.51),
    Symbol("SPX", "S&P 500", (IDX,), "yahoo:^GSPC", check_close_2001_09_10=1092.54),
    Symbol("COMP", "Nasdaq Composite", (IDX,), "yahoo:^IXIC", check_close_2001_09_10=1695.38),
    Symbol("US10Y", "10-Yr Treasury Yield", ("bond",), "fred:DGS10", unit="percent"),
    # ---- Dow 30 (Sept 2001 membership) -----------------------------------
    Symbol("AA", "Alcoa", (DOW,), "yahoo:AA"),
    Symbol("AXP", "American Express", (DOW,), "yahoo:AXP"),
    Symbol("BA", "Boeing", (DOW,), "yahoo:BA"),
    Symbol("C", "Citigroup", (DOW,), "yahoo:C"),
    Symbol("CAT", "Caterpillar", (DOW,), "yahoo:CAT"),
    Symbol("DD", "DuPont", (DOW,), "yahoo:DD"),
    Symbol("DIS", "Walt Disney", (DOW,), "yahoo:DIS"),
    Symbol("EK", "Eastman Kodak", (DOW,), "override"),
    Symbol("GE", "General Electric", (DOW,), "yahoo:GE"),
    Symbol("GM", "General Motors", (DOW,), "override"),
    Symbol("HD", "Home Depot", (DOW,), "yahoo:HD"),
    Symbol("HON", "Honeywell", (DOW,), "yahoo:HON"),
    Symbol("HWP", "Hewlett-Packard", (DOW,), "yahoo:HPQ"),
    Symbol("IBM", "IBM", (DOW,), "yahoo:IBM"),
    Symbol("INTC", "Intel", (DOW,), "yahoo:INTC"),
    Symbol("IP", "International Paper", (DOW,), "yahoo:IP"),
    Symbol("JNJ", "Johnson & Johnson", (DOW,), "yahoo:JNJ"),
    Symbol("JPM", "J.P. Morgan Chase", (DOW,), "yahoo:JPM"),
    Symbol("KO", "Coca-Cola", (DOW,), "yahoo:KO"),
    Symbol("MCD", "McDonald's", (DOW,), "yahoo:MCD"),
    Symbol("MMM", "Minnesota Mining (3M)", (DOW,), "yahoo:MMM"),
    Symbol("MO", "Philip Morris", (DOW,), "yahoo:MO"),
    Symbol("MRK", "Merck", (DOW,), "yahoo:MRK"),
    Symbol("MSFT", "Microsoft", (DOW,), "yahoo:MSFT"),
    Symbol("PG", "Procter & Gamble", (DOW,), "yahoo:PG"),
    Symbol("SBC", "SBC Communications", (DOW,), "yahoo:T"),  # Yahoo "T" = SBC lineage
    Symbol("T", "AT&T", (DOW,), "override"),  # old AT&T Corp; Yahoo "T" is NOT this
    Symbol("UTX", "United Technologies", (DOW,), "yahoo:RTX"),
    Symbol("WMT", "Wal-Mart Stores", (DOW,), "yahoo:WMT"),
    Symbol("XOM", "Exxon Mobil", (DOW,), "yahoo:XOM"),
    # ---- Airlines ---------------------------------------------------------
    Symbol("AMR", "AMR (American Airlines)", ("airline",), "override"),
    Symbol("UAL", "UAL (United Airlines)", ("airline",), "override"),
    Symbol("DAL", "Delta Air Lines", ("airline",), "override"),
    Symbol("LUV", "Southwest Airlines", ("airline",), "yahoo:LUV"),
    Symbol("CAL", "Continental Airlines", ("airline",), "override"),
    Symbol("NWAC", "Northwest Airlines", ("airline",), "override"),
    Symbol("U", "US Airways", ("airline",), "override"),
    Symbol("ALK", "Alaska Air Group", ("airline",), "yahoo:ALK"),
    # ---- Insurers ----------------------------------------------------------
    Symbol("AIG", "American International Group", ("insurer",), "yahoo:AIG"),
    Symbol("MMC", "Marsh & McLennan", ("insurer",), "yahoo:MMC"),
    Symbol("MET", "MetLife", ("insurer",), "yahoo:MET"),
    # ---- Brokers -----------------------------------------------------------
    Symbol("MER", "Merrill Lynch", ("broker",), "override"),
    Symbol("MWD", "Morgan Stanley Dean Witter", ("broker",), "yahoo:MS"),
    Symbol("GS", "Goldman Sachs", ("broker",), "yahoo:GS"),
    Symbol("LEH", "Lehman Brothers", ("broker",), "override"),
    Symbol("BSC", "Bear Stearns", ("broker",), "override"),
    # ---- Defense -----------------------------------------------------------
    Symbol("LMT", "Lockheed Martin", ("defense",), "yahoo:LMT"),
    Symbol("NOC", "Northrop Grumman", ("defense",), "yahoo:NOC"),
    Symbol("RTN", "Raytheon", ("defense",), "override"),  # RTX lineage is UTX's, not RTN's
    Symbol("GD", "General Dynamics", ("defense",), "yahoo:GD"),
    # ---- Travel / hotels ----------------------------------------------------
    Symbol("MAR", "Marriott International", ("travel",), "yahoo:MAR"),
    Symbol("HLT", "Hilton Hotels", ("travel",), "override"),
]


def by_symbol() -> dict[str, Symbol]:
    return {s.symbol: s for s in SYMBOLS}


def override_symbols() -> list[Symbol]:
    return [s for s in SYMBOLS if s.source == "override"]
