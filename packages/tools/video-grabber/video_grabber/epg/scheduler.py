"""
Schedule builder — lays a channel's ``programs`` onto a non-overlapping,
time-ordered ``schedule_slots`` timeline that the EPG assembler consumes.

The assembler (:mod:`video_grabber.epg.assembler`) walks slots with a forward-
only ``cursor`` and synthesizes gap fillers for the spaces between them. It
therefore REQUIRES the slots it reads to be:
  - time-ordered by ``starts_at``,
  - non-overlapping (each ``starts_at`` >= the previous ``ends_at``),
  - inside ``[window_start, window_end)``.

``programs`` rows do not guarantee any of that: ``air_date`` is derived
heuristically (see resolve.py) so two programs can overlap. Resolving those
overlaps is the one real policy decision in this module — it lives in
:func:`resolve_slots`, which is intentionally left for a human to implement.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

import sqlalchemy as sa


@dataclass(frozen=True)
class ScheduledProgram:
    """A candidate program to place on the timeline."""
    program_id: str
    ia_identifier: str
    air_date: datetime          # derived UTC broadcast start
    duration_seconds: int       # true playable length (ffprobe'd at resolve time)

    @property
    def natural_end(self) -> datetime:
        return self.air_date + timedelta(seconds=self.duration_seconds)


@dataclass(frozen=True)
class ResolvedSlot:
    """One non-overlapping slot ready to insert into schedule_slots."""
    program_id: str
    starts_at: datetime
    ends_at: datetime


def build_schedule(
    channel_id: str,
    window_start: datetime,
    window_end: datetime,
    db,
) -> int:
    """Rebuild ``schedule_slots`` for one channel across the window. Idempotent:
    wipes the channel's existing in-window slots and re-inserts the resolved set.
    Returns the number of slots written.
    """
    programs = _fetch_programs(db, channel_id, window_start, window_end)
    slots = resolve_slots(programs, window_start, window_end)

    # Idempotency: clear this channel's slots in the window, then re-insert.
    db.execute(
        sa.text(
            "DELETE FROM schedule_slots "
            "WHERE channel_id = :cid AND starts_at >= :ws AND ends_at <= :we"
        ),
        {"cid": str(channel_id), "ws": window_start, "we": window_end},
    )
    for slot in slots:
        db.execute(
            sa.text(
                "INSERT INTO schedule_slots "
                "(channel_id, program_id, starts_at, ends_at, is_gap) "
                "VALUES (:cid, :pid, :starts, :ends, false)"
            ),
            {
                "cid": str(channel_id),
                "pid": str(slot.program_id),
                "starts": slot.starts_at,
                "ends": slot.ends_at,
            },
        )
    db.commit()
    return len(slots)


# A clipped slot shorter than one fMP4 segment can't produce a playable
# segment, so it is dropped to gap instead of emitting a degenerate slot.
_MIN_SLOT_SECONDS = 6


def resolve_slots(
    programs: list[ScheduledProgram],
    window_start: datetime,
    window_end: datetime,
) -> list[ResolvedSlot]:
    """Turn raw, possibly-overlapping programs into a clean slot timeline.

    Policy: **first-wins (clip)**. Programs are processed in ``air_date`` order;
    whoever claims the air first keeps it, and a later program that overlaps has
    its start clipped to the running cursor. This is the most forgiving choice
    for archive content, where ``air_date`` is heuristically derived (see
    resolve.py) and small overlaps are usually timing error rather than a real
    contest — clipping preserves as much footage as fits instead of dropping it.

    Guarantees the assembler's forward-only cursor depends on — the returned
    list is sorted by ``starts_at``, non-overlapping, and clamped to
    ``[window_start, window_end)``. A clipped remnant below
    ``_MIN_SLOT_SECONDS`` is dropped (it becomes gap), so every emitted slot is
    at least one segment long.
    """
    slots: list[ResolvedSlot] = []
    cursor = window_start
    for p in sorted(programs, key=lambda p: p.air_date):
        start = max(p.air_date, cursor)
        end = min(p.natural_end, window_end)
        if (end - start).total_seconds() < _MIN_SLOT_SECONDS:
            continue  # entirely before the cursor, past the window, or too short
        slots.append(ResolvedSlot(p.program_id, start, end))
        cursor = end
    return slots


def _fetch_programs(
    db, channel_id: str, window_start: datetime, window_end: datetime
) -> list[ScheduledProgram]:
    rows = db.execute(
        sa.text(
            "SELECT id, ia_identifier, air_date, duration_seconds "
            "FROM programs "
            "WHERE channel_id = :cid AND air_date >= :ws AND air_date < :we "
            "ORDER BY air_date"
        ),
        {"cid": str(channel_id), "ws": window_start, "we": window_end},
    ).mappings().all()
    return [
        ScheduledProgram(
            program_id=str(r["id"]),
            ia_identifier=r["ia_identifier"],
            air_date=r["air_date"],
            duration_seconds=r["duration_seconds"],
        )
        for r in rows
    ]
