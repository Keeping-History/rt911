"""prep_bts maps raw BTS -> contract CSV. New: Tail_Number passes through;
a raw file lacking the column (shouldn't happen, but usecols is a lambda
filter so it degrades silently) yields an empty Tail_Number column rather
than a KeyError."""

import pandas as pd

from flight_recon.prep_bts import CONTRACT, prep

RAW_HEADER = ("FlightDate,Reporting_Airline,Tail_Number,"
              "Flight_Number_Reporting_Airline,Origin,Dest,WheelsOff,WheelsOn,"
              "Cancelled,Diverted,Distance,Div1Airport,Div1WheelsOn")
RAW_ROW = "2001-09-10,AA,N334AA,11,BOS,LAX,0800,1100,0,0,2611,,"


def test_contract_includes_tail_number():
    assert "Tail_Number" in CONTRACT


def test_prep_passes_tail_through(tmp_path):
    raw = tmp_path / "raw.csv"
    raw.write_text(f"{RAW_HEADER}\n{RAW_ROW}\n")
    out = tmp_path / "out.csv"
    prep(raw, out)
    df = pd.read_csv(out)
    assert list(df.columns) == CONTRACT
    assert df.loc[0, "Tail_Number"] == "N334AA"


def test_prep_tolerates_missing_tail_column(tmp_path):
    header = RAW_HEADER.replace("Tail_Number,", "")
    row = RAW_ROW.replace("N334AA,", "")
    raw = tmp_path / "raw.csv"
    raw.write_text(f"{header}\n{row}\n")
    out = tmp_path / "out.csv"
    prep(raw, out)
    df = pd.read_csv(out)
    assert "Tail_Number" in df.columns
    assert pd.isna(df.loc[0, "Tail_Number"])
