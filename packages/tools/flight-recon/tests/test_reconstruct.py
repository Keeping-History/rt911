"""Tests for the reconstruction wrapper — incl. the pipeline acceptance invariant."""

import math
from pathlib import Path

import pytest

from reconstruct import CLIMB_FRAC, altitude, gc_interp, phase, reconstruct

DATA = Path(__file__).parent.parent / "data"
FLIGHTS = DATA / "sample_bts_2001-09-09_2001-09-12.csv"
AIRPORTS = DATA / "airports.csv"

ACCEPTANCE_FLIGHTS = {"US800", "NW300", "AA100", "UA50", "CO400"}


@pytest.fixture(scope="module")
def full_window():
    return reconstruct("2001-09-09", "2001-09-12", FLIGHTS, AIRPORTS)


# ---------------------------------------------------------------- math unchanged
def test_gc_interp_endpoints_and_midpoint():
    lat, lon = gc_interp(42.0, -71.0, 34.0, -118.0, 0.0)
    assert (lat, lon) == (42.0, -71.0)
    lat, lon = gc_interp(42.0, -71.0, 34.0, -118.0, 1.0)
    assert math.isclose(lat, 34.0, abs_tol=1e-9) and math.isclose(lon, -118.0, abs_tol=1e-9)
    # great-circle midpoint arcs north of the straight-line latitude average
    mid_lat, _ = gc_interp(42.0, -71.0, 34.0, -118.0, 0.5)
    assert mid_lat > (42.0 + 34.0) / 2


def test_altitude_profile_and_phase_agree():
    # Default endpoints (0) reproduce the original sea-level trapezoid.
    assert altitude(0.0) == 0
    assert altitude(0.5) == 35000
    assert altitude(1.0) == 0
    for f, expect in [(0.0, "climb"), (0.14, "climb"), (0.5, "cruise"),
                      (0.86, "descent"), (1.0, "descent")]:
        assert phase(f) == expect
        if expect == "cruise":
            assert altitude(f) == 35000


def test_altitude_anchors_to_endpoint_elevations():
    # Takeoff sits at the origin field elevation, touchdown at the destination's.
    assert altitude(0.0, origin_ft=5431, dest_ft=13) == 5431   # DEN departure
    assert altitude(1.0, origin_ft=20, dest_ft=5431) == 5431   # DEN arrival
    # Cruise is unaffected by endpoint elevations.
    assert altitude(0.5, origin_ft=5431, dest_ft=5431) == 35000
    # Descent ramp is monotonic down to the field, never below it.
    lo = altitude(1 - CLIMB_FRAC / 2, origin_ft=0, dest_ft=5431)
    assert 5431 < lo < 35000


# ---------------------------------------------------------------- acceptance invariant
def test_airborne_set_at_ground_stop(full_window):
    """flight_date=2001-09-11 AND et_seconds=35100 (9:45 ET) -> exactly the 5 flights."""
    positions = full_window[0]
    airborne = {p["flight"] for p in positions
                if p["flight_date"] == "2001-09-11" and p["et_seconds"] == 35100}
    assert airborne == ACCEPTANCE_FLIGHTS


def test_diversions_land_at_diversion_airport(full_window):
    tracks = full_window[1]
    by_flight = {(t["properties"]["flight"], t["properties"]["flight_date"]): t["properties"]
                 for t in tracks}
    aa100 = by_flight[("AA100", "2001-09-11")]
    assert aa100["diverted"] is True
    assert aa100["landed_at"] == "DEN" and aa100["scheduled_dest"] == "LAX"
    nw300 = by_flight[("NW300", "2001-09-11")]
    assert nw300["diverted"] is False and nw300["landed_at"] == "SEA"


def test_skips_and_cancellations(full_window):
    summary = full_window[2]
    reasons = {(s["flight"], s["flight_date"]): s["reason"] for s in summary["skipped"]}
    assert reasons[("DL500", "2001-09-11")] == "cancelled"
    assert reasons[("TW600", "2001-09-11")] == "unknown airport"
    assert reasons[("WN700", "2001-09-11")] == "no usable airborne interval"
    assert summary["cancelled_by_day"] == {"2001-09-11": 1, "2001-09-12": 3}
    assert summary["flights_reconstructed"] == 13  # 19 rows - 6 skipped
    assert summary["tracks_count"] == 13


def test_clock_seconds_is_continuous_across_days(full_window):
    """clock_seconds == et_seconds + 86400 * days-since-window-start, for every row."""
    positions = full_window[0]
    day_index = {"2001-09-09": 0, "2001-09-10": 1, "2001-09-11": 2, "2001-09-12": 3}
    for p in positions:
        # utc date can roll past the flight_date; derive days from the utc stamp
        utc_day = p["utc"][:10]
        assert p["clock_seconds"] == p["et_seconds"] + 86400 * day_index[utc_day] \
            or p["et_seconds"] < 4 * 3600  # ET midnight rollover: utc day is one ahead


def test_window_filtering():
    positions, tracks, summary, _ = reconstruct("2001-09-11", "2001-09-11", FLIGHTS, AIRPORTS)
    dates = {p["flight_date"] for p in positions}
    assert dates == {"2001-09-11"}
    assert summary["cancelled_by_day"] == {"2001-09-11": 1}
    # clock_seconds now anchors at 9/11 ET midnight, so it equals et_seconds
    at_ground_stop = {p["flight"] for p in positions if p["clock_seconds"] == 35100}
    assert at_ground_stop == ACCEPTANCE_FLIGHTS


def test_bad_inputs_raise():
    with pytest.raises(ValueError, match="precedes"):
        reconstruct("2001-09-12", "2001-09-09", FLIGHTS, AIRPORTS)
    with pytest.raises(ValueError, match="missing columns"):
        reconstruct("2001-09-09", "2001-09-12", AIRPORTS, AIRPORTS)


def test_trim_summary_stays_under_directus_payload_cap():
    # Regression: the real 9/11 window skips ~35k flights (mostly cancelled);
    # the raw summary blew Directus's 1 MB MAX_PAYLOAD_SIZE (run cherubic-chicken).
    import json

    from flight_recon.flow import SKIPPED_DETAIL_CAP, trim_summary

    skipped = [{"flight": f"XX{i}", "flight_date": "2001-09-11",
                "reason": "cancelled"} for i in range(35000)]
    skipped += [{"flight": f"DV{i}", "flight_date": "2001-09-11",
                 "reason": "no usable airborne interval"} for i in range(3000)]
    summary = {"flights_reconstructed": 4000, "positions_count": 3_470_000,
               "tracks_count": 4000, "skipped_count": len(skipped),
               "skipped": skipped, "cancelled_by_day": {"2001-09-11": 35000}}

    row = trim_summary(summary, run_id="abc123")

    assert row["run_id"] == "abc123"
    assert row["skipped_by_reason"] == {"cancelled": 35000,
                                        "no usable airborne interval": 3000}
    # cancelled detail is dropped (aggregated in cancelled_by_day); rest capped
    assert len(row["skipped"]) == SKIPPED_DETAIL_CAP
    assert all(s["reason"] != "cancelled" for s in row["skipped"])
    assert len(json.dumps(row)) < 900_000  # headroom under the 1 MB cap
