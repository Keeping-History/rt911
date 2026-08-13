from datetime import datetime, timezone
from flight_recon.resample import assign_curated_phases, resample_track, assign_sources


def _mins(*hhmmss):
    return [{"utc": datetime(2001, 9, 11, h, m, s, tzinfo=timezone.utc), "phase": "cruise"}
            for (h, m, s) in hhmmss]


def test_assign_curated_phases_boundary_inclusive_and_ordered():
    samples = _mins((12, 0, 0), (12, 9, 0), (12, 24, 0), (12, 25, 0))
    phases = [
        {"phase": "tracon", "utc": "2001-09-11T12:00:00Z"},
        {"phase": "artcc", "utc": "2001-09-11T12:09:00Z"},
        {"phase": "atc_alert", "utc": "2001-09-11T12:24:38Z"},
    ]
    assign_curated_phases(samples, phases)
    # boundary-inclusive: 12:09 sample takes the artcc boundary exactly;
    # the off-minute 12:24:38 boundary leaves the 12:24 sample in artcc.
    assert [s["phase"] for s in samples] == ["tracon", "artcc", "artcc", "atc_alert"]


def test_assign_curated_phases_before_first_boundary_uses_first_phase():
    samples = _mins((11, 59, 0))
    phases = [{"phase": "takeoff", "utc": "2001-09-11T12:00:00Z"}]
    assign_curated_phases(samples, phases)
    assert samples[0]["phase"] == "takeoff"


def test_assign_curated_phases_out_of_list_order_by_time():
    # UA93: atc_alert (earlier) authored before course_change (later).
    samples = _mins((13, 33, 0), (13, 37, 0))
    phases = [
        {"phase": "atc_alert", "utc": "2001-09-11T13:32:00Z"},
        {"phase": "course_change", "utc": "2001-09-11T13:36:00Z"},
    ]
    assign_curated_phases(samples, phases)
    assert [s["phase"] for s in samples] == ["atc_alert", "course_change"]


def test_identical_waypoints_hold_position_no_nan():
    # A parked stretch is two identical waypoints minutes apart; every
    # interpolated sample must hold the exact position and altitude.
    wps = [
        {"utc": "2001-09-11T05:00:00Z", "lat": 27.3954, "lon": -82.5544, "alt_ft": 28},
        {"utc": "2001-09-11T05:10:00Z", "lat": 27.3954, "lon": -82.5544, "alt_ft": 28},
    ]
    samples = resample_track(wps)
    assert len(samples) == 11
    for s in samples:
        assert s["lat"] == 27.3954 and s["lon"] == -82.5544 and s["alt_ft"] == 28


def test_assign_sources_radar_bracket_and_default():
    wps = [
        {"utc": "2001-09-11T13:54:00Z", "lat": 27.4, "lon": -82.55, "alt_ft": 28, "source": "estimated"},
        {"utc": "2001-09-11T13:56:00Z", "lat": 27.5, "lon": -82.60, "alt_ft": 3000, "source": "radar"},
        {"utc": "2001-09-11T13:58:00Z", "lat": 27.6, "lon": -82.65, "alt_ft": 6000, "source": "radar"},
        {"utc": "2001-09-11T14:00:00Z", "lat": 27.7, "lon": -82.70, "alt_ft": 9000, "source": "estimated"},
    ]
    samples = resample_track(wps)
    assign_sources(samples, wps)
    by_min = {s["utc"].strftime("%H:%M"): s["source"] for s in samples}
    assert by_min["13:57"] == "radar"       # bracketed radar-radar
    assert by_min["13:55"] == "estimated"   # estimated-radar bracket
    assert by_min["13:59"] == "estimated"   # radar-estimated bracket


def test_assign_sources_absent_when_unmarked():
    # Files without source marks (the existing five notables) stay untouched.
    wps = [
        {"utc": "2001-09-11T13:54:00Z", "lat": 27.4, "lon": -82.55, "alt_ft": 28},
        {"utc": "2001-09-11T13:56:00Z", "lat": 27.5, "lon": -82.60, "alt_ft": 3000},
    ]
    samples = resample_track(wps)
    assign_sources(samples, wps)
    assert all("source" not in s for s in samples)
