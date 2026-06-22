"""
Contract tests for resolve_slots — these assert the invariants the EPG
assembler depends on, independent of which overlap policy is chosen.

If these pass, assemble_range can safely consume the output.
"""
from datetime import datetime, timedelta, timezone


from video_grabber.epg.scheduler import (
    ScheduledProgram,
    resolve_slots,
)

WS = datetime(2001, 9, 9, 0, 0, tzinfo=timezone.utc)
WE = datetime(2001, 9, 18, 0, 0, tzinfo=timezone.utc)


def prog(pid, start, dur, ia_identifier=None):
    return ScheduledProgram(
        program_id=pid,
        ia_identifier=ia_identifier if ia_identifier is not None else pid,
        air_date=start,
        duration_seconds=dur,
    )


def scheduled(pid, start, dur):
    """A program whose identifier carries an explicit air time (EPG-grid)."""
    return prog(pid, start, dur, ia_identifier=f"CNN_20010911_120000_{pid}")


def generic(pid, start, dur):
    """A continuous-coverage capture with no identifier timestamp."""
    return prog(pid, start, dur, ia_identifier=f"cnn200109111545-{pid}")


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


def test_scheduled_program_wins_over_overlapping_generic():
    # A generic "Television News" block overlaps a named scheduled program;
    # the scheduled program must keep its full airtime.
    t = datetime(2001, 9, 11, 13, 0, tzinfo=timezone.utc)
    progs = [
        generic("news", t, 3600),                                   # 13:00-14:00
        scheduled("sched", t + timedelta(minutes=15), 1800),        # 13:15-13:45
    ]
    slots = resolve_slots(progs, WS, WE)
    assert_assembler_contract(slots)
    by_id = {s.program_id: s for s in slots}
    # Scheduled keeps its exact slot...
    assert by_id["sched"].starts_at == t + timedelta(minutes=15)
    assert by_id["sched"].ends_at == t + timedelta(minutes=45)
    # ...and the generic fills only the gaps around it.
    gen = sorted((s for s in slots if s.program_id == "news"), key=lambda s: s.starts_at)
    assert gen[0].starts_at == t and gen[0].ends_at == t + timedelta(minutes=15)
    assert gen[-1].ends_at == t + timedelta(hours=1)


def test_generic_fills_gap_when_no_scheduled_overlap():
    # With no competing scheduled program, the generic capture is placed as-is.
    t = datetime(2001, 9, 11, 13, 0, tzinfo=timezone.utc)
    slots = resolve_slots([generic("news", t, 1800)], WS, WE)
    assert_assembler_contract(slots)
    assert [s.program_id for s in slots] == ["news"]
    assert slots[0].starts_at == t and slots[0].ends_at == t + timedelta(minutes=30)
