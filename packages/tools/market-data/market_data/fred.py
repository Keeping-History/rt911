"""FRED CSV series (no API key needed): https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10"""

import csv
import io

import httpx


def parse_fred_csv(text: str) -> list[dict]:
    """FRED CSV → close-only bars. Missing observations are '.' and are skipped."""
    bars = []
    for row in csv.reader(io.StringIO(text)):
        if not row or row[0].lower() in ("date", "observation_date"):
            continue
        date, value = row[0], row[1]
        if value.strip() in (".", ""):  # missing observation (legacy "." or current empty)
            continue
        bars.append({"date": date, "close": float(value)})
    return bars


def fetch_series(series: str, start: str, end: str, client: httpx.Client) -> list[dict]:
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series}&cosd={start}&coed={end}"
    resp = client.get(url)
    resp.raise_for_status()
    return parse_fred_csv(resp.text)
