from datetime import datetime, timezone
from flight_recon.resample import assign_curated_phases


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
