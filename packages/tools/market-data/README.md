# market-data

Offline generator for the static `market-data.json` bundle behind the **MarketWatch**
frontend app (issue #185). Run once; the output is immutable historical data for
September 2001, uploaded to Wasabi and served at
`https://files.911realtime.org/market/market-data.json`.

## What it emits

One JSON document (see [`schema/market-data.schema.json`](schema/market-data.schema.json)):

- **`calendar`** — equity + bond market sessions (UTC open/close per trading day,
  2001-09-04 → 2001-09-21) and extraordinary **closures** (the 9/11 halt: equities
  closed until Mon 9/17 09:30 ET, the longest NYSE closure since 1933; bonds reopened
  Thu 9/13). Weekends/overnights are *not* closures — they're just gaps between
  sessions. The frontend's `marketClock` reduces a virtual-clock timestamp over this
  to `open | closed | halted`.
- **`symbols`** — ~55 curated symbols (indices, the Sept-2001 Dow 30, airlines,
  insurers, brokers, defense, travel; see `market_data/symbols.py`) with daily OHLC
  bars in **as-printed 2001 prices** (un-adjusted), plus the 10-yr Treasury yield
  (FRED `DGS10`, `unit: "percent"`, close-only bars).

Equity bars always carry full OHLC (the frontend synthesizes a deterministic
intraday path pinned to open/high/low/close); yield bars may be close-only.

## Data sources

| Source | Used for | Notes |
|---|---|---|
| Yahoo chart API | Listed lineages that reach back to 2001 | Yahoo closes are split-adjusted; we multiply back by the product of post-date split ratios to recover printed prices. Some 2001 tickers are queried under their modern lineage name: HWP→HPQ, MWD→MS, UTX→RTX, SBC→`T`. |
| FRED `DGS10` | 10-yr Treasury yield | Free CSV, no API key. |
| `market_data/overrides.json` | Delisted paper with no free source (AMR, UAL, DAL, CAL, NWAC, U, MER, LEH, BSC, EK, GM, RTN, HLT, old AT&T `T`) | Hand-entered from archival newspaper stock tables / contemporaneous reporting; every entry carries a citation. |

**Ticker-reuse warning:** today's `UAL`, `DAL`, `GM`, `HLT` are different companies
wearing a dead company's symbol, and Yahoo's `T` is the SBC lineage (SBC took the
name in 2005) — the *old* AT&T Corp is override-only. Lineage per symbol was
verified empirically (firstTradeDate + archival close spot-check).

## Validation (fail-loud)

`generate.py` refuses to emit unless:

- every curated symbol has bars for all required dates (9/7, 9/10, 9/17, 9/18 at
  minimum), from its source or an override;
- anchors match fetched data (DJIA close 9605.51 on 9/10 → 8920.70 on 9/17, −684.81);
- every symbol with a `check_close_2001_09_10` matches within ±1%;
- the output validates against the JSON Schema.

## Usage

```sh
cd packages/tools/market-data
pip install -e '.[dev]'
market-data --out market-data.json          # fetch, validate, emit
pytest tests/ -v                             # offline tests (fixtures, no network)
ruff check market_data/ tests/
```

Upload (same pattern as other tools; bucket credentials from the usual env):

```sh
aws s3 cp market-data.json s3://<bucket>/market/market-data.json --endpoint-url <wasabi>
```

Serving requires `/market/` on the `files.911realtime.org` allow-list
(Keeping-History/infra Traefik Ingress).
