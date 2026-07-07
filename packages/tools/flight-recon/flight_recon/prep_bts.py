"""
Map a raw BTS "Reporting Carrier On-Time Performance (1987-present)" CSV onto
the flight-recon input contract. This is the manual staging step that runs
after downloading a monthly PREZIP from TranStats — the flow itself never
fetches BTS data.

    python -m flight_recon.prep_bts \
        --raw '/srv/flight-recon-data/bts_raw/On_Time_..._2001_9.csv' \
        --out /srv/flight-recon-data/bts_2001-09.csv

Contract quirks handled here so reconstruct.py stays untouched:
- raw files are latin-1, not UTF-8;
- `Flight_Number` is named `Flight_Number_Reporting_Airline`;
- there is no single `DivAirport` column — modern files carry Div1..Div5
  legs, and the honest endpoint for a diverted flight is its LAST diversion
  landing (with that leg's WheelsOn, local to that airport). NOTE: files
  before 2003 leave the Div* detail empty, so pre-2003 diverted flights have
  no recorded landing and get skipped by reconstruct() as "no usable
  airborne interval" — that is a fact of the source data, not a bug.
"""

import argparse

import pandas as pd

CONTRACT = ["FlightDate", "Reporting_Airline", "Flight_Number", "Origin", "Dest",
            "WheelsOff", "WheelsOn", "Cancelled", "Diverted", "DivAirport", "Distance"]
DIV_LEGS = 5


def prep(raw_path, out_path):
    usecols = ["FlightDate", "Reporting_Airline", "Flight_Number_Reporting_Airline",
               "Origin", "Dest", "WheelsOff", "WheelsOn", "Cancelled", "Diverted",
               "Distance"]
    usecols += [f"Div{i}Airport" for i in range(1, DIV_LEGS + 1)]
    usecols += [f"Div{i}WheelsOn" for i in range(1, DIV_LEGS + 1)]

    df = pd.read_csv(raw_path, usecols=lambda c: c in usecols,
                     dtype={"FlightDate": str}, encoding="latin-1", low_memory=False)
    df = df.rename(columns={"Flight_Number_Reporting_Airline": "Flight_Number"})

    # Last populated diversion leg wins: that's where the flight actually
    # came down, and its WheelsOn is local time at that airport (matching
    # how reconstruct() converts the endpoint).
    df["DivAirport"] = pd.NA
    for i in range(1, DIV_LEGS + 1):
        ap, on = f"Div{i}Airport", f"Div{i}WheelsOn"
        if ap not in df.columns:
            continue
        leg = df[ap].notna() & df[on].notna()
        df.loc[leg, "DivAirport"] = df.loc[leg, ap]
        df.loc[leg, "WheelsOn"] = df.loc[leg, on]

    out = df[CONTRACT]
    out.to_csv(out_path, index=False)

    flown = out[(out.Cancelled == 0) & out.WheelsOff.notna() & out.WheelsOn.notna()]
    print(f"{out_path}: {len(out)} rows "
          f"({int(out.Cancelled.sum())} cancelled, {int(out.Diverted.sum())} diverted, "
          f"{len(flown)} with usable wheels times)")


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    p.add_argument("--raw", required=True, help="raw BTS monthly CSV (from PREZIP)")
    p.add_argument("--out", required=True, help="contract CSV to write")
    args = p.parse_args(argv)
    prep(args.raw, args.out)


if __name__ == "__main__":
    main()
