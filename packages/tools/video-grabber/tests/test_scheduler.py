"""
Contract tests for resolve_slots — these assert the invariants the EPG
assembler depends on, independent of which overlap policy is chosen.

If these pass, assemble_range can safely consume the output.
"""
from datetime import datetime, timezone


from video_grabber.epg.scheduler import (
    ScheduledProgram,
    resolve_slots,
)

WS = datetime(2001, 9, 9, 0, 0, tzinfo=timezone.utc)
WE = datetime(2001, 9, 18, 0, 0, tzinfo=timezone.utc)


def prog(pid, start, dur):
    return ScheduledProgram(
        program_id=pid, ia_identifier=pid, air_date=start, duration_seconds=dur
    )


def assert_assembler_contract(slots, window_start=WS, window_end=WE):
    """Every guarantee assemble_range's forward-only cursor relies on."""
    prev_end = window_start
    for s in slots:
        assert s.starts_at >= prev_end, f"overlap/disorder at {s.program_id}"
        assert s.ends_at > s.starts_at, f"non-positive slot {s.program_id}"
        assert s.starts_at >= window_start and s.ends_at <= window_end, "out of window"
        prev_end = s.ends_at


def test_empty_input_yields_no_slots():
    assert resolve_slots([], WS, WE) == []


def test_non_overlapping_programs_pass_through_in_order():
    progs = [
        prog("b", datetime(2001, 9, 11, 9, 0, tzinfo=timezone.utc), 3600),
        prog("a", datetime(2001, 9, 11, 8, 0, tzinfo=timezone.utc), 1800),
    ]
    slots = resolve_slots(progs, WS, WE)
    assert_assembler_contract(slots)
    assert [s.program_id for s in slots] == ["a", "b"]


def test_overlapping_programs_are_resolved_to_no_overlap():
    # b starts 30 min into a's hour-long slot.
    progs = [
        prog("a", datetime(2001, 9, 11, 8, 0, tzinfo=timezone.utc), 3600),
        prog("b", datetime(2001, 9, 11, 8, 30, tzinfo=timezone.utc), 3600),
    ]
    slots = resolve_slots(progs, WS, WE)
    assert_assembler_contract(slots)  # whatever policy, no overlap may remain


def test_program_outside_window_is_dropped_or_clipped():
    progs = [prog("early", datetime(2001, 9, 8, 23, 0, tzinfo=timezone.utc), 3600)]
    slots = resolve_slots(progs, WS, WE)
    assert_assembler_contract(slots)
