"""Resolve a bare ``video_jobs`` row into linked ``channels`` + ``programs`` rows.

The scanner (``ia/scanner.py``) writes only ``ia_identifier``, ``collection``,
``stage`` and the abbreviated ``ia_metadata`` blob. The download → encode →
upload → Directus tail, however, dereferences a *channel* (slug, timezone) and
a *program* (air_date, duration, title) via the foreign keys ``channel_id`` /
``program_id``. Nothing populated those, so every job reached the upload stage
with ``job.program.air_date is None`` and crashed.

This stage closes that gap: it derives the channel/program facts from the
stored IA metadata (plus the downloaded media for an authoritative duration),
upserts the rows, and links them back onto the job. It is idempotent — a second
run on an already-resolved job updates the existing rows in place.

Derivation sources, chosen for reliability against the real archive:
- slug:     ``channel_map.normalize_slug`` (every ``discovered`` job already
            resolved one — that is what moved it out of ``pending_review``).
- air_date: the IA ``date`` field (clean ISO-8601 UTC, present on 100% of the
            discovered queue), falling back to parsing the human title.
- title:    ``subject[0]`` (the clean program name, e.g. "Victory Garden"),
            falling back to the text before the first " : " in the IA title.
- duration: ``ffprobe`` of the downloaded media — the actual playable length,
            which is what the Directus writer records as ``calc_duration`` /
            ``end_date``. The scheduled slot length lives in ``schedule_slots``
            and is handled separately by the EPG assembler.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Optional

import sqlalchemy as sa

from video_grabber.ia.channel_map import normalize_slug
from video_grabber.ia.metadata import extract_air_date_utc
from video_grabber.video.encoder import probe_duration_seconds

# Friendly display names for known network slugs. Call-sign slugs (e.g. a local
# affiliate "wttg") are not listed and fall back to the upper-cased slug.
_DISPLAY_NAMES: dict[str, str] = {
    "cnn": "CNN", "msnbc": "MSNBC", "abc-news": "ABC News",
    "cbs-news": "CBS News", "nbc-news": "NBC News", "pbs": "PBS",
    "bbc": "BBC", "fox-news": "Fox News", "c-span": "C-SPAN",
    "univision": "Univision", "telemundo": "Telemundo",
}

# Timezone abbreviations we may find embedded in an IA title, longest first so
# "EDT" wins over a stray "ET". US East Coast is the default for 9/11 coverage.
_TZ_ABBRS = (
    "CEST", "CET", "BST", "EDT", "EST", "CDT", "CST", "MDT", "MST",
    "PDT", "PST", "UTC", "GMT", "ET", "CT", "MT", "PT",
)
_DEFAULT_TZ = "EDT"

# Call-sign identifiers embed the UTC air time, e.g.
# "WETA_20010915_163000_Victory_Garden" -> 2001-09-15 16:30:00 UTC.
_IDENT_TS = re.compile(r"_(\d{8})_(\d{6})(?:_|$)")


def _as_meta(job) -> dict:
    """Return ``job.ia_metadata`` as a dict (JSONB usually arrives parsed)."""
    meta = getattr(job, "ia_metadata", None)
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except json.JSONDecodeError:
            meta = None
    return meta or {}


def _air_date_from_identifier(identifier: str) -> Optional[datetime]:
    """UTC air time embedded in a call-sign identifier, or None.

    e.g. "WETA_20010915_163000_Victory_Garden" -> 2001-09-15 16:30:00 UTC.
    """
    m = _IDENT_TS.search(identifier or "")
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S").replace(
            tzinfo=timezone.utc
        )
    except ValueError:
        return None


def _air_date(meta: dict) -> datetime:
    """Resolve the program's UTC air time.

    Priority: the UTC timestamp embedded in the identifier → the human title →
    the IA ``date`` field.

    The identifier wins because it is authoritative UTC, verified against two
    real timezones (WETA ``163000`` = 12:30pm EDT, BBC ``210000`` = 10:00pm
    BST). The title is only a fallback for non-call-sign identifiers (e.g.
    ``abc200109110954-1036``): its ``H:MMpm-H:MMpm TZ`` range format places the
    timezone after the *end* time, where ``extract_air_date_utc`` never sees it
    and silently defaults to EDT — correct for US feeds, 5h wrong for the BBC.
    ``date`` is last: it is the calendar day at midnight UTC, not an air time.
    """
    from_ident = _air_date_from_identifier(meta.get("identifier", ""))
    if from_ident is not None:
        return from_ident

    parsed = extract_air_date_utc(
        meta.get("title", ""), meta.get("description", "") or ""
    )
    if parsed is not None:
        return parsed

    raw = meta.get("date")
    if raw:
        try:
            return datetime.fromisoformat(
                str(raw).replace("Z", "+00:00")
            ).astimezone(timezone.utc)
        except ValueError:
            pass

    raise ValueError("could not determine air_date from IA metadata")


def _program_title(meta: dict) -> str:
    """Clean program name: ``subject[0]`` or the text before the first ' : '."""
    subj = meta.get("subject")
    if isinstance(subj, list) and subj:
        return str(subj[0]).strip()
    if isinstance(subj, str) and subj.strip():
        return subj.strip()
    title = meta.get("title", "") or ""
    return title.split(" : ", 1)[0].strip() or title.strip() or "Untitled"


def _timezone_abbr(meta: dict) -> str:
    title = (meta.get("title") or "").upper()
    for abbr in _TZ_ABBRS:
        if abbr in title:
            return abbr
    return _DEFAULT_TZ


def resolve_job(job, db, media_path: Optional[Path] = None):
    """Upsert channel + program rows for ``job`` and link them onto the row.

    Mutates ``job`` in place (channel / program namespaces, channel_id /
    program_id) so downstream stages in the same flow see the new links
    without re-reading the database, and returns it for convenience.
    """
    meta = _as_meta(job)
    slug = normalize_slug(meta)
    if not slug:
        raise ValueError(f"no channel slug for {job.ia_identifier}")

    display_name = _DISPLAY_NAMES.get(slug, slug.upper())
    tz = _timezone_abbr(meta)
    air_date = _air_date(meta)
    title = _program_title(meta)
    description = meta.get("description")
    duration = probe_duration_seconds(media_path) if media_path is not None else 0

    # Upsert the channel. ON CONFLICT ... DO UPDATE (a no-op self-assignment)
    # guarantees RETURNING yields the id on both insert and conflict, where a
    # bare DO NOTHING would return no row for an existing slug.
    channel_id = db.execute(
        sa.text(
            """
            INSERT INTO channels (slug, display_name, timezone)
            VALUES (:slug, :display_name, :tz)
            ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
            RETURNING id
            """
        ),
        {"slug": slug, "display_name": display_name, "tz": tz},
    ).scalar_one()

    # programs has no unique constraint on ia_identifier, so dedup by hand to
    # stay idempotent across re-runs / retries.
    program_id = db.execute(
        sa.text("SELECT id FROM programs WHERE ia_identifier = :iaid"),
        {"iaid": job.ia_identifier},
    ).scalar()
    params = {
        "cid": channel_id, "title": title, "descr": description,
        "air": air_date, "dur": duration, "iaid": job.ia_identifier,
    }
    if program_id is None:
        program_id = db.execute(
            sa.text(
                """
                INSERT INTO programs
                    (channel_id, title, description, air_date,
                     duration_seconds, ia_identifier)
                VALUES (:cid, :title, :descr, :air, :dur, :iaid)
                RETURNING id
                """
            ),
            params,
        ).scalar_one()
    else:
        db.execute(
            sa.text(
                "UPDATE programs SET channel_id = :cid, title = :title, "
                "description = :descr, air_date = :air, duration_seconds = :dur "
                "WHERE id = :pid"
            ),
            {**params, "pid": program_id},
        )

    db.execute(
        sa.text(
            "UPDATE video_jobs SET channel_id = :cid, program_id = :pid "
            "WHERE id = :jid"
        ),
        {"cid": channel_id, "pid": program_id, "jid": job.id},
    )
    db.commit()

    # Refresh in-memory view so upload/Directus stages see the populated links.
    job.channel_id = channel_id
    job.program_id = program_id
    job.channel = SimpleNamespace(
        slug=slug, display_name=display_name, timezone=tz
    )
    job.program = SimpleNamespace(
        title=title, description=description,
        air_date=air_date, duration_seconds=duration,
    )
    return job
