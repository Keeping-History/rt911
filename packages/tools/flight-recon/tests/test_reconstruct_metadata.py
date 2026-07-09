"""Tail/aircraft-type threading through reconstruct(). Three contracts:
matched tail -> display name; unmatched/missing -> None (never a guess);
legacy contract CSVs without Tail_Number still reconstruct."""

import pytest

from reconstruct import reconstruct

AIRPORTS = "code,lat,lon,utc_offset\nBOS,42.3656,-71.0096,-4\nLAX,33.9425,-118.4081,-7\n"
FLIGHT_COLS = ("FlightDate,Reporting_Airline,Flight_Number,Origin,Dest,"
               "WheelsOff,WheelsOn,Cancelled,Diverted,DivAirport,Distance")


@pytest.fixture
def airports_csv(tmp_path):
    p = tmp_path / "airports.csv"
    p.write_text(AIRPORTS)
    return p


def _flights_csv(tmp_path, tail_cell):
    p = tmp_path / "flights.csv"
    header = FLIGHT_COLS + ",Tail_Number" if tail_cell is not None else FLIGHT_COLS
    row = "2001-09-10,AA,11,BOS,LAX,0800,1100,0,0,,2611"
    if tail_cell is not None:
        row += f",{tail_cell}"
    p.write_text(f"{header}\n{row}\n")
    return p


def test_matched_tail_resolves_type(tmp_path, airports_csv):
    flights = _flights_csv(tmp_path, "334AA")  # missing N prefix on purpose
    fleet = {"N334AA": "Boeing 767-223"}
    _, tracks, _, _ = reconstruct("2001-09-10", "2001-09-10", flights, airports_csv, fleet=fleet)
    props = tracks[0]["properties"]
    assert props["tail_number"] == "N334AA"
    assert props["aircraft_type"] == "Boeing 767-223"


def test_unmatched_tail_keeps_type_none(tmp_path, airports_csv):
    flights = _flights_csv(tmp_path, "N777ZZ")
    _, tracks, _, _ = reconstruct("2001-09-10", "2001-09-10", flights, airports_csv,
                                  fleet={"N334AA": "Boeing 767-223"})
    props = tracks[0]["properties"]
    assert props["tail_number"] == "N777ZZ"
    assert props["aircraft_type"] is None


def test_missing_tail_column_still_reconstructs(tmp_path, airports_csv):
    flights = _flights_csv(tmp_path, None)  # legacy contract, no Tail_Number
    positions, tracks, _, _ = reconstruct("2001-09-10", "2001-09-10", flights, airports_csv)
    assert len(tracks) == 1
    assert tracks[0]["properties"]["tail_number"] is None
    assert tracks[0]["properties"]["aircraft_type"] is None
    # positions untouched by this feature
    assert "tail_number" not in positions[0]
