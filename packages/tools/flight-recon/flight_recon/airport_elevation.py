"""Enrich the airport reference CSV with field elevations from OurAirports.

The production airports.csv (code,lat,lon,utc_offset) predates elevation; this
joins OurAirports' surveyed elevation_ft by IATA code. Airports OurAirports
lacks default to 0 (sea level) — the pre-existing reconstruction behavior.

Usage (operator downloads OurAirports first — https://ourairports.com/data/):
    python -m flight_recon.airport_elevation \
        --base /srv/flight-recon-data/airports.csv \
        --ourairports /srv/flight-recon-data/ourairports.csv \
        --out /srv/flight-recon-data/airports.csv
"""
import argparse

import pandas as pd


def elevation_by_iata(ourairports_df):
    """Map IATA code -> integer elevation_ft, skipping blank IATA/elevation."""
    df = ourairports_df[["iata_code", "elevation_ft"]].dropna()
    df = df[df["iata_code"].astype(str).str.len() == 3]
    return {code: int(elev) for code, elev in zip(df["iata_code"], df["elevation_ft"])}


def add_elevation(base_df, elev):
    """Return base_df with an elevation_ft column (0 for codes absent from elev)."""
    out = base_df.copy()
    out["elevation_ft"] = out["code"].map(lambda c: elev.get(c, 0)).astype(int)
    return out


def main():
    p = argparse.ArgumentParser(description="Add elevation_ft to airports.csv from OurAirports")
    p.add_argument("--base", required=True, help="airports.csv (code,lat,lon,utc_offset)")
    p.add_argument("--ourairports", required=True, help="OurAirports airports.csv")
    p.add_argument("--out", required=True, help="output CSV path")
    args = p.parse_args()

    base = pd.read_csv(args.base)
    oa = pd.read_csv(args.ourairports)
    enriched = add_elevation(base, elevation_by_iata(oa))
    enriched.to_csv(args.out, index=False)
    missing = int((enriched["elevation_ft"] == 0).sum())
    print(f"wrote {args.out}: {len(enriched)} airports, {missing} defaulted to 0 ft")


if __name__ == "__main__":
    main()
