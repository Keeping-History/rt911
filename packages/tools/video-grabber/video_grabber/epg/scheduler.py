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

import re
from dataclasses import dataclass
from datetime import datetime, timedelta

import sqlalchemy as sa

# An EPG-grid recording embeds an explicit air time in its identifier, e.g.
# "CNN_20010911_210000_Inside_Politics". The other archive source uses a
# generic continuous-coverage form ("cnn200109111545-1626") with no such
# timestamp — those are the "Television News" captures that should yield to a
# named scheduled program when the two overlap (see resolve_slots).
_SCHEDULED_TS = re.compile(r"_\d{8}_\d{6}(?:_|$)")


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

    @property
    def is_scheduled(self) -> bool:
        """True for EPG-grid recordings (identifier carries an explicit
        ``_YYYYMMDD_HHMMSS``). These outrank generic live-coverage captures on
        overlap, so a named program always claims its airtime."""
        return bool(_SCHEDULED_TS.search(self.ia_identifier or ""))


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

    Policy: **priority tiers, then first-wins (clip)**. Programs are placed in
    two passes:

    1. *Scheduled* programs (``is_scheduled`` — EPG-grid recordings with an
       explicit identifier timestamp) are laid down first, in ``air_date``
       order, each clipped to the running cursor. A named program therefore
       always claims its airtime.
    2. *Generic* live-coverage captures (the "Television News" form) then fill
       only the gaps the scheduled pass left open, clipped to each free span.

    Within a tier the rule is the forgiving first-wins clip — ``air_date`` is
    heuristically derived (see resolve.py) and small overlaps are usually timing
    error, so clipping preserves as much footage as fits. The cross-tier
    priority is the real decision: where the two archive sources double-cover
    the same minutes (the Sep 11-13 breaking-news window), the scheduled program
    wins and the generic feed is relegated to the leftover gaps.

    Guarantees the assembler's forward-only cursor depends on — the returned
    list is sorted by ``starts_at``, non-overlapping, and clamped to
    ``[window_start, window_end)``. A clipped remnant below
    ``_MIN_SLOT_SECONDS`` is dropped (it becomes gap), so every emitted slot is
    at least one segment long.
    """
    slots: list[ResolvedSlot] = []
    occupied: list[tuple[datetime, datetime]] = []  # sorted, merged

    def place(candidates: list[ScheduledProgram]) -> None:
        for p in sorted(candidates, key=lambda p: p.air_date):
            lo = max(p.air_date, window_start)
            hi = min(p.natural_end, window_end)
            for span_start, span_end in _free_spans(occupied, lo, hi):
                if (span_end - span_start).total_seconds() < _MIN_SLOT_SECONDS:
                    continue
                slots.append(ResolvedSlot(p.program_id, span_start, span_end))
                _occupy(occupied, span_start, span_end)

    place([p for p in programs if p.is_scheduled])
    place([p for p in programs if not p.is_scheduled])
    slots.sort(key=lambda s: s.starts_at)
    return slots


def _free_spans(
    occupied: list[tuple[datetime, datetime]], lo: datetime, hi: datetime
) -> list[tuple[datetime, datetime]]:
    """Maximal sub-spans of ``[lo, hi)`` not covered by ``occupied`` (which must
    be sorted and merged)."""
    spans: list[tuple[datetime, datetime]] = []
    cursor = lo
    for start, end in occupied:
        if end <= cursor or start >= hi:
            continue
        if start > cursor:
            spans.append((cursor, min(start, hi)))
        cursor = max(cursor, end)
        if cursor >= hi:
            break
    if cursor < hi:
        spans.append((cursor, hi))
    return spans


def _occupy(
    occupied: list[tuple[datetime, datetime]], start: datetime, end: datetime
) -> None:
    """Insert ``[start, end)`` and re-merge so ``occupied`` stays sorted and
    overlap-free (the invariant ``_free_spans`` relies on)."""
    occupied.append((start, end))
    occupied.sort()
    merged: list[tuple[datetime, datetime]] = []
    for a, b in occupied:
        if merged and a <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    occupied[:] = merged


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
