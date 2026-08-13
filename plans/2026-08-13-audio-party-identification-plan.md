# Audio Transcript Linkage + Party Identification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Link the 788 existing audio SRTs to their `mp3_items` rows, backfill the 168 uncatalogued objects, and add a structured `parties` field identifying who each recording's traffic is between.

**Architecture:** Three layers. (1) Fixes to the existing `video_grabber.transcribe` pipeline so the Directus linkage stops silently failing. (2) A new `video_grabber.catalogue` module that creates missing `mp3_items` rows from bucket objects. (3) A new `video_grabber.parties` module that reads transcripts and writes a JSON `parties` object, split pure-logic/network exactly as `transcript/summarize.py` is, with a containment gate that forbids the model naming anything the transcript does not contain.

**Tech Stack:** Python 3.12, Prefect 3 flows, SQLAlchemy Core, httpx against Directus REST, boto3 against Wasabi, `anthropic` SDK, pytest.

**Spec:** [`plans/2026-08-13-audio-party-identification-design.md`](2026-08-13-audio-party-identification-design.md)

## Global Constraints

- Run everything from `packages/tools/video-grabber/`. Tests: `pytest tests/ -v`. Lint: `ruff check video_grabber/ tests/`.
- **Never run `scan-transcribe` until Task 1 has been applied and verified.** `transcribe_jobs` is empty; a scan run enqueues all 789 MP3s plus every completed TV program and re-transcribes ~296 hours of audio. `scan-transcribe` is manual-only (no schedule), so the hazard is latent, not live.
- **No re-transcription anywhere in this plan.** All 788 SRTs are correct and reusable.
- WINS (`wins1010`) and WCBS (`wcbs`) are excluded from party identification via an affirmative allow-list. Never implement this as a deny-list.
- Every commit carries `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Deployment is GitOps. Land on `main`; never `kubectl set image`.
- Directus JSON fields require the **cast-json** special or they 400 opaquely.

---

## File Structure

**Modified**
- `video_grabber/directus/writer.py` — add `wasabi_public_url()`
- `video_grabber/transcribe/flows.py` — use the helper; fail loudly on unmatched patch; mirror SRT keys to the source path; add `reconcile_transcribe_jobs_flow`
- `video_grabber/transcript/summarize.py` — extract `unsupported_words()` for reuse by the parties gate
- `video_grabber/config.py` — add `parties_model`
- `video_grabber/serve.py` — register the new flows

**Created**
- `video_grabber/catalogue/__init__.py`
- `video_grabber/catalogue/filenames.py` — pure: bucket key → title / start_date
- `video_grabber/catalogue/flows.py` — backfill rows, link subtitles
- `video_grabber/parties/__init__.py`
- `video_grabber/parties/identify.py` — pure: media-kind map, tiering, prompts, parsing, containment gate
- `video_grabber/parties/flows.py` — Prefect flow, Anthropic + Directus
- `tests/test_wasabi_public_url.py`
- `tests/test_catalogue_filenames.py`
- `tests/test_parties_identify.py`

**Fixtures (already committed)**
- `tests/fixtures/aa77/parties.csv` — 39 hand-classified clips (23 tier-A, 13 tier-B, 3 undeterminable)
- `tests/fixtures/aa77/srt/*.srt` — their transcripts

---

### Task 1: Guard `scan-transcribe` against mass re-transcription

`transcribe_jobs` has 0 rows. `scan_transcribe_flow` de-duplicates on `ON CONFLICT (source_key) DO NOTHING`, so with the table empty it re-enqueues everything. This flow seeds the table as `done` for every source whose SRT already exists, restoring idempotency.

It checks **both** SRT layouts (the current flat `subtitles/audio/<stem>.srt` and the mirrored `subtitles/audio/<path>.srt` introduced in Task 4) so it stays correct regardless of task order.

**Files:**
- Modify: `video_grabber/transcribe/flows.py`
- Modify: `video_grabber/serve.py`
- Test: `tests/test_transcribe_flows.py`

**Interfaces:**
- Produces: `reconcile_transcribe_jobs_flow()` — Prefect flow, no args; `existing_srt_key(mp3_key, srt_stems, srt_paths) -> str | None`

- [ ] **Step 1: Write the failing test**

In `tests/test_transcribe_flows.py`:

```python
def test_existing_srt_key_prefers_the_mirrored_path():
    stems = {"0812 aa77 taxi"}
    paths = {"subtitles/audio/AA77/0812 aa77 taxi.srt"}
    assert flows.existing_srt_key("audio/AA77/0812 aa77 taxi.mp3", stems, paths) == \
        "subtitles/audio/AA77/0812 aa77 taxi.srt"


def test_existing_srt_key_falls_back_to_the_flat_stem():
    stems = {"0812 aa77 taxi"}
    assert flows.existing_srt_key("audio/AA77/0812 aa77 taxi.mp3", stems, set()) == \
        "subtitles/audio/0812 aa77 taxi.srt"


def test_existing_srt_key_returns_none_when_untranscribed():
    assert flows.existing_srt_key("audio/AA77/never.mp3", set(), set()) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_transcribe_flows.py -k existing_srt_key -v`
Expected: FAIL — `AttributeError: module 'video_grabber.transcribe.flows' has no attribute 'existing_srt_key'`

- [ ] **Step 3: Write the implementation**

In `video_grabber/transcribe/flows.py`:

```python
def existing_srt_key(mp3_key: str, srt_stems: set[str], srt_paths: set[str]) -> str | None:
    """Return the SRT key already in the bucket for *mp3_key*, or None.

    Checks the mirrored layout first (Task 4) and falls back to the historical
    flat-stem layout, so this stays correct whichever layout the bucket is in.
    """
    mirrored = f"{Path(mp3_key).with_suffix('.srt')}"
    mirrored = f"subtitles/{mirrored}"
    if mirrored in srt_paths:
        return mirrored
    stem = Path(mp3_key).stem
    if stem in srt_stems:
        return f"subtitles/audio/{stem}.srt"
    return None


@flow(name="reconcile-transcribe-jobs")
def reconcile_transcribe_jobs_flow() -> None:
    """Seed transcribe_jobs as 'done' for every mp3 whose SRT already exists.

    Load-bearing guard: transcribe_jobs is empty, and scan-transcribe only
    de-duplicates against rows that are there. Without this, the next scan
    re-transcribes ~296 hours of audio that is already captioned.
    """
    logger = get_run_logger()
    cfg = Config()
    srt_keys = [k for k in wasabi.list_keys(f"{cfg.subtitles_prefix}/", cfg)
                if k.endswith(".srt")]
    srt_paths = set(srt_keys)
    srt_stems = {Path(k).stem for k in srt_keys}
    mp3_keys = [k for k in wasabi.list_keys("audio/", cfg) if k.lower().endswith(".mp3")]

    seeded = skipped = 0
    with get_db() as db:
        for key in mp3_keys:
            srt_key = existing_srt_key(key, srt_stems, srt_paths)
            if srt_key is None:
                skipped += 1
                continue
            res = db.execute(sa.text("""
                INSERT INTO transcribe_jobs (kind, source_key, source_url, stage, srt_key)
                VALUES ('mp3', :sk, :url, 'done', :srt)
                ON CONFLICT (source_key) DO NOTHING
            """), {"sk": key, "url": wasabi_public_url(key), "srt": srt_key})
            seeded += res.rowcount or 0
        db.commit()
    logger.info("reconcile-transcribe-jobs: seeded %d done, %d still untranscribed",
                seeded, skipped)
```

Add `from pathlib import Path` if absent, and `wasabi_public_url` to the existing
`from video_grabber.directus.writer import …` block (created in Task 2 — if running
tasks in order, complete Task 2 first or add the helper now).

- [ ] **Step 4: Run tests**

Run: `pytest tests/test_transcribe_flows.py -v`
Expected: PASS

- [ ] **Step 5: Register the flow**

In `video_grabber/serve.py`, add `reconcile_transcribe_jobs_flow` to the
`from video_grabber.transcribe.flows import (…)` block and add a manual-only
deployment alongside `scan_transcribe_flow.to_deployment(…)`:

```python
        reconcile_transcribe_jobs_flow.to_deployment(
            name="reconcile-transcribe-jobs",
        ),
```

Do not give it a schedule.

- [ ] **Step 6: Commit**

```bash
git add video_grabber/transcribe/flows.py video_grabber/serve.py tests/test_transcribe_flows.py
git commit -m "feat(transcribe): seed transcribe_jobs from existing SRTs

transcribe_jobs is empty, and scan-transcribe only de-duplicates against
rows already present, so the next scan would re-enqueue all 789 mp3s and
re-transcribe ~296h of already-captioned audio.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Percent-encode Wasabi public URLs

Root cause of the 46/621 linkage gap. `patch_mp3_subtitles` matches
`mp3_items.url` with an exact `_eq` filter; Directus stores the percent-encoded
form while the caller passes a raw key. Only the three space-free folders matched.

**Files:**
- Modify: `video_grabber/directus/writer.py:16`
- Modify: `video_grabber/transcribe/flows.py` (three call sites)
- Test: `tests/test_wasabi_public_url.py`

**Interfaces:**
- Produces: `wasabi_public_url(key: str) -> str`

- [ ] **Step 1: Write the failing test**

Create `tests/test_wasabi_public_url.py`:

```python
from video_grabber.directus.writer import wasabi_public_url


def test_encodes_spaces():
    assert wasabi_public_url("audio/AA77/0812 aa77 taxi.mp3") == (
        "https://files.911realtime.org/audio/AA77/0812%20aa77%20taxi.mp3"
    )


def test_keeps_path_separators_unencoded():
    assert "/audio/AA77/" in wasabi_public_url("audio/AA77/x.mp3")


def test_matches_the_form_directus_actually_stores():
    # The exact row that never linked for 18 months.
    assert wasabi_public_url("audio/AA77/0812 aa77 taxi to runway t.mp3") == (
        "https://files.911realtime.org/audio/AA77/"
        "0812%20aa77%20taxi%20to%20runway%20t.mp3"
    )


def test_space_free_keys_are_unchanged():
    # The three folders that DID link must keep linking.
    assert wasabi_public_url("audio/norad/neads/DRM1_DAT2_Channel_3_MCC_TK.mp3") == (
        "https://files.911realtime.org/audio/norad/neads/DRM1_DAT2_Channel_3_MCC_TK.mp3"
    )
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_wasabi_public_url.py -v`
Expected: FAIL — `ImportError: cannot import name 'wasabi_public_url'`

- [ ] **Step 3: Write the implementation**

In `video_grabber/directus/writer.py`, after `_WASABI_BASE`:

```python
from urllib.parse import quote

_WASABI_BASE = "https://files.911realtime.org"


def wasabi_public_url(key: str) -> str:
    """Public URL for a bucket key, encoded the way mp3_items.url stores it.

    Load-bearing: patch_mp3_subtitles matches mp3_items.url with an exact _eq
    filter. Directus stores '…/0812%20aa77….mp3'; passing the raw key matched
    only the three folders whose filenames contain no spaces, silently leaving
    575 of 621 rows unlinked while the pipeline reported success.

    quote() leaves '/' alone by default, so path structure survives.
    """
    return f"{_WASABI_BASE}/{quote(key)}"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_wasabi_public_url.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Update the call sites**

In `video_grabber/transcribe/flows.py`, import the helper and replace all three
raw concatenations:

```python
from video_grabber.directus.writer import (
    _WASABI_BASE,
    get_tv_channel_start_date,
    patch_mp3_subtitles,
    patch_tv_channel_subtitles,
    wasabi_public_url,
)
```

- in `scan_transcribe_flow`, TV branch: `src_url = wasabi_public_url(r["wasabi_key"])`
- in `scan_transcribe_flow`, mp3 branch: `src_url = wasabi_public_url(key)`
- in `transcribe_item_flow`: `patch_mp3_subtitles(job.source_url, wasabi_public_url(srt_key), cfg)`

- [ ] **Step 6: Run the full suite**

Run: `pytest tests/ -v && ruff check video_grabber/ tests/`
Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add video_grabber/directus/writer.py video_grabber/transcribe/flows.py tests/test_wasabi_public_url.py
git commit -m "fix(transcribe): percent-encode Wasabi URLs so Directus linkage matches

patch_mp3_subtitles matches mp3_items.url exactly, but callers passed a raw
key while the column stores it encoded. Only the three space-free folders
ever matched: 46 of 621 rows.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Fail loudly when the Directus row does not match

The encoding bug survived 575 occurrences because the flow logged a warning and
still marked the job `done`. A miss is now a job failure.

**Files:**
- Modify: `video_grabber/transcribe/flows.py`
- Test: `tests/test_transcribe_flows.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_transcribe_flows.py`:

```python
def test_transcribe_item_fails_when_no_mp3_items_row_matches(flow_env):
    flow_env.monkeypatch.setattr(flows, "transcribe_wav", flow_env.make_transcriber())
    flow_env.monkeypatch.setattr(
        flows, "get_transcribe_job",
        lambda job_id: SimpleNamespace(
            id=job_id, kind="mp3",
            source_key="audio/AA77/x.mp3",
            source_url="https://files.911realtime.org/audio/AA77/x.mp3",
        ),
    )
    flow_env.monkeypatch.setattr(flows, "patch_mp3_subtitles", lambda *a, **k: False)
    with pytest.raises(RuntimeError, match="matched no mp3_items row"):
        flows.transcribe_item_flow.fn("job-1")
    assert _stages(flow_env.conns)[-1] == "failed"


def test_transcribe_item_succeeds_when_the_row_matches(flow_env):
    flow_env.monkeypatch.setattr(flows, "transcribe_wav", flow_env.make_transcriber())
    flow_env.monkeypatch.setattr(
        flows, "get_transcribe_job",
        lambda job_id: SimpleNamespace(
            id=job_id, kind="mp3",
            source_key="audio/AA77/x.mp3",
            source_url="https://files.911realtime.org/audio/AA77/x.mp3",
        ),
    )
    flow_env.monkeypatch.setattr(flows, "patch_mp3_subtitles", lambda *a, **k: True)
    flows.transcribe_item_flow.fn("job-1")
    assert _stages(flow_env.conns) == ["transcribing", "done"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_transcribe_flows.py -k no_mp3_items_row -v`
Expected: FAIL — the flow completes and the stage is `done`, not `failed`

- [ ] **Step 3: Write the implementation**

In `transcribe_item_flow`, replace the warning block:

```python
        if job.kind == "mp3":
            matched = patch_mp3_subtitles(job.source_url, wasabi_public_url(srt_key), cfg)
            if not matched:
                # A miss means the SRT is in the bucket but nothing points at it.
                # This warned-and-continued for 575 jobs while reporting success;
                # it is a failure, not a note.
                raise RuntimeError(
                    f"patch_mp3_subtitles matched no mp3_items row for "
                    f"source_url={job.source_url!r} (source_key={job.source_key!r}). "
                    f"SRT/VTT uploaded to {srt_key!r} but the row is unlinked."
                )
```

- [ ] **Step 4: Run tests**

Run: `pytest tests/test_transcribe_flows.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add video_grabber/transcribe/flows.py tests/test_transcribe_flows.py
git commit -m "fix(transcribe): fail the job when no mp3_items row matches

A warned-and-continued miss is why the URL-encoding bug survived 575 jobs
while every run reported success.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Mirror SRT keys to the source path

The flat stem namespace has 93 colliding basenames. All 93 are currently genuine
duplicates (`audio/AA11/X.mp3` and `audio/faa_atc/clips/aa11/X.mp3`, identical
durations), so nothing is corrupt today — this is hardening against the first real
collision.

**Files:**
- Modify: `video_grabber/transcribe/flows.py`
- Test: `tests/test_transcribe_flows.py`

**Interfaces:**
- Produces: `subtitle_base_key(job_kind: str, source_key: str, cfg) -> str`

- [ ] **Step 1: Write the failing test**

```python
def test_subtitle_base_key_mirrors_the_audio_path():
    cfg = SimpleNamespace(subtitles_prefix="subtitles")
    assert flows.subtitle_base_key("mp3", "audio/AA77/0812 aa77 taxi.mp3", cfg) == \
        "subtitles/audio/AA77/0812 aa77 taxi"


def test_subtitle_base_key_disambiguates_colliding_basenames():
    cfg = SimpleNamespace(subtitles_prefix="subtitles")
    a = flows.subtitle_base_key("mp3", "audio/AA11/081015 aa11 fl290.mp3", cfg)
    b = flows.subtitle_base_key("mp3", "audio/faa_atc/clips/aa11/081015 aa11 fl290.mp3", cfg)
    assert a != b


def test_subtitle_base_key_leaves_tv_alone():
    cfg = SimpleNamespace(subtitles_prefix="subtitles")
    assert flows.subtitle_base_key("tv", "TCN_test", cfg) == "subtitles/programs/TCN_test"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_transcribe_flows.py -k subtitle_base_key -v`
Expected: FAIL — `AttributeError: … has no attribute 'subtitle_base_key'`

- [ ] **Step 3: Write the implementation**

```python
def subtitle_base_key(job_kind: str, source_key: str, cfg) -> str:
    """Extension-less subtitle key for a source.

    mp3 keys mirror their full audio/ path rather than collapsing to a bare
    stem: 93 basenames repeat across folders, and a flat namespace makes the
    second transcription silently overwrite the first.
    """
    if job_kind == "tv":
        return f"{cfg.subtitles_prefix}/programs/{source_key}"
    return f"{cfg.subtitles_prefix}/{str(Path(source_key).with_suffix(''))}"
```

Replace the inline branch in `transcribe_item_flow`:

```python
        base_key = subtitle_base_key(job.kind, job.source_key, cfg)
```

- [ ] **Step 4: Run tests**

Run: `pytest tests/test_transcribe_flows.py -v`
Expected: PASS

- [ ] **Step 5: Migrate the existing objects**

Server-side S3 copy — no re-transcription. Run from a pod with Wasabi credentials:

```python
from pathlib import Path
from video_grabber.config import Config
from video_grabber.storage import wasabi

cfg = Config()
audio = {Path(k).stem: k for k in wasabi.list_keys("audio/", cfg) if k.endswith(".mp3")}
moved = 0
for k in wasabi.list_keys("subtitles/audio/", cfg):
    stem, ext = Path(k).stem, Path(k).suffix
    src = audio.get(stem)
    if src is None:
        print("orphan subtitle, leaving in place:", k)
        continue
    dest = f"subtitles/{Path(src).with_suffix('')}{ext}"
    if dest != k and wasabi.copy_object_if_absent(k, dest, cfg):
        moved += 1
print("copied", moved)
```

Colliding stems resolve to whichever source the loop sees last; because all 93 are
byte-identical duplicates this is safe. Leave the flat objects in place until
Task 7 has repointed `mp3_items.subtitles`.

- [ ] **Step 6: Commit**

```bash
git add video_grabber/transcribe/flows.py tests/test_transcribe_flows.py
git commit -m "fix(transcribe): mirror SRT keys to the source audio path

93 basenames repeat across folders; a flat subtitle namespace lets the
second transcription overwrite the first.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Add the `parties` field to `mp3_items`

Operational, not code. Do this before Task 9 so the flow has somewhere to write.

- [ ] **Step 1: Check for a running backup**

```sql
SELECT pid, state, query_start, left(query, 60)
FROM pg_stat_activity
WHERE query ILIKE '%pg_dump%' OR query ILIKE '%COPY%';
```

A schema ALTER queued behind a `pg_dump` stalls live reads. If a backup is running, wait.

- [ ] **Step 2: Create the field**

```bash
curl -sS -X POST "$DIRECTUS_URL/fields/mp3_items" \
  -H "Authorization: Bearer $DIRECTUS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "field": "parties",
    "type": "json",
    "meta": {"interface": "input-code", "special": ["cast-json"],
             "note": "Who this recordings traffic is between. Written by the parties flow."},
    "schema": {"is_nullable": true}
  }' | tee /tmp/parties-field.json
```

Log the response body. Without `special: ["cast-json"]` the field 400s opaquely on write.

- [ ] **Step 3: Verify round-trip**

```bash
curl -sS -X PATCH "$DIRECTUS_URL/items/mp3_items/<some-id>" \
  -H "Authorization: Bearer $DIRECTUS_TOKEN" -H 'Content-Type: application/json' \
  -d '{"parties": {"tier": "clip", "confidence": "low"}}'
curl -sS "$DIRECTUS_URL/items/mp3_items/<some-id>?fields=parties" \
  -H "Authorization: Bearer $DIRECTUS_TOKEN"
```

Expected: the object comes back as JSON, not a string. Then null it again.

If introspection wedges after the schema op, `kubectl -n rt911 rollout restart deploy/rt911-api`.

---

### Task 6: Filename → title and start_date parser

The 168 uncatalogued objects need `title`, `full_title` and `start_date`. Derivation
differs per folder: clip folders lead with `HHMMSS` local ET; faa_atc tapes encode a
UTC window. **Unparseable names yield `None`, never a guess** — one over-broad regex
is what caused the transcript-timeline contamination incident.

**Files:**
- Create: `video_grabber/catalogue/__init__.py` (empty)
- Create: `video_grabber/catalogue/filenames.py`
- Test: `tests/test_catalogue_filenames.py`

**Interfaces:**
- Produces: `parse_key(key: str) -> ParsedName` with fields `title: str`, `start_utc: datetime | None`

- [ ] **Step 1: Write the failing test**

Create `tests/test_catalogue_filenames.py`:

```python
from datetime import datetime, timezone

from video_grabber.catalogue.filenames import parse_key

SEPT11 = datetime(2001, 9, 11, tzinfo=timezone.utc)


def test_clip_hhmmss_is_local_et_converted_to_utc():
    p = parse_key("audio/AA77/083950 aa77 approach indy .mp3")
    assert p.start_utc == datetime(2001, 9, 11, 12, 39, 50, tzinfo=timezone.utc)
    assert p.title == "approach indy"


def test_clip_hhmm_is_accepted():
    p = parse_key("audio/AA77/0812 aa77 taxi to runway t.mp3")
    assert p.start_utc == datetime(2001, 9, 11, 12, 12, 0, tzinfo=timezone.utc)


def test_faa_atc_tape_window_is_already_utc():
    p = parse_key("audio/faa_atc/zny/tmu/4 ZNY 132 TMU DC 1245-1316 UTC AP.mp3")
    assert p.start_utc == datetime(2001, 9, 11, 12, 45, tzinfo=timezone.utc)


def test_unparseable_name_yields_no_timestamp_rather_than_a_guess():
    p = parse_key("audio/norad/neads/DRM1_DAT2_Channel_3_MCC_TK.mp3")
    assert p.start_utc is None
    assert p.title == "DRM1_DAT2_Channel_3_MCC_TK"


def test_an_hour_of_100_is_not_read_as_midnight():
    # The transcript-contamination bug: '\d{2}' matched '10' out of '100225'
    # and a re-anchored search read hour 100 as 0.
    p = parse_key("audio/AA77/100225 aa77 line 4530 repo.mp3")
    assert p.start_utc == datetime(2001, 9, 11, 14, 2, 25, tzinfo=timezone.utc)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_catalogue_filenames.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'video_grabber.catalogue'`

- [ ] **Step 3: Write the implementation**

Create `video_grabber/catalogue/__init__.py` (empty) and
`video_grabber/catalogue/filenames.py`:

```python
"""Derive mp3_items metadata from a bucket key.

Every rule here refuses rather than guesses. A filename this parser cannot read
yields start_utc=None and the row is created without a timestamp — a wrong
timestamp puts 2001-09-11 audio on the wrong day of the replay, which is exactly
the failure mode of the transcript-timeline contamination incident.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

DAY = datetime(2001, 9, 11, tzinfo=timezone.utc)
ET_OFFSET = timedelta(hours=4)  # EDT on 2001-09-11; UTC = ET + 4

# Anchored at the start and bounded: HHMMSS or HHMM, then a separator.
_CLIP_TIME = re.compile(r"^(\d{2})(\d{2})(\d{2})?(?=\D|$)")
# faa_atc tape windows: '… 1245-1316 UTC …'
_UTC_WINDOW = re.compile(r"\b(\d{2})(\d{2})-(\d{2})(\d{2})\s+UTC\b")


@dataclass(frozen=True)
class ParsedName:
    title: str
    start_utc: datetime | None


def _clip_start(stem: str) -> datetime | None:
    m = _CLIP_TIME.match(stem)
    if not m:
        return None
    hh, mm, ss = int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)
    if hh > 23 or mm > 59 or ss > 59:
        return None
    return DAY + timedelta(hours=hh, minutes=mm, seconds=ss) + ET_OFFSET


def _utc_window_start(stem: str) -> datetime | None:
    m = _UTC_WINDOW.search(stem)
    if not m:
        return None
    hh, mm = int(m.group(1)), int(m.group(2))
    if hh > 23 or mm > 59:
        return None
    return DAY + timedelta(hours=hh, minutes=mm)


def _title(stem: str) -> str:
    """Strip a leading timestamp and the callsign token that follows it."""
    rest = _CLIP_TIME.sub("", stem).strip()
    rest = re.sub(r"^(aa|ua|d|dal|ual)?\s*\d{1,4}\s*", "", rest, flags=re.I).strip()
    return rest or stem


def parse_key(key: str) -> ParsedName:
    stem = Path(key).stem
    start = _utc_window_start(stem)
    if start is not None:
        return ParsedName(title=stem, start_utc=start)
    start = _clip_start(stem)
    if start is not None:
        return ParsedName(title=_title(stem), start_utc=start)
    return ParsedName(title=stem, start_utc=None)
```

- [ ] **Step 4: Run tests**

Run: `pytest tests/test_catalogue_filenames.py -v`
Expected: PASS (5 passed). If `test_clip_hhmm_is_accepted` fails because `0812`
parses as HHMMSS-with-missing-seconds, confirm `_CLIP_TIME`'s optional third group
plus the `(?=\D|$)` lookahead is doing the right thing for both widths.

- [ ] **Step 5: Commit**

```bash
git add video_grabber/catalogue tests/test_catalogue_filenames.py
git commit -m "feat(catalogue): parse mp3_items metadata from bucket keys

Per-folder derivation with an explicit refusal path: an unreadable filename
yields no timestamp rather than a guessed one.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Backfill rows and link subtitles

Creates the 168 missing `mp3_items` rows with `calc_duration` (Task 9 needs it to
tier), then sets `subtitles` on all 789.

**Files:**
- Create: `video_grabber/catalogue/flows.py`
- Modify: `video_grabber/serve.py`

**Interfaces:**
- Produces: `backfill_mp3_catalogue_flow(dry_run: bool = True)`, `link_mp3_subtitles_flow(dry_run: bool = True)`

- [ ] **Step 1: Write the flows**

Create `video_grabber/catalogue/flows.py`:

```python
"""Reconcile mp3_items against the audio/ prefix.

Two flows, both idempotent and both defaulting to dry_run=True: these write to
the live catalogue, and a wrong start_date puts historical audio on the wrong
day of the replay.
"""
import subprocess

import httpx
from prefect import flow, get_run_logger

from video_grabber.catalogue.filenames import parse_key
from video_grabber.config import Config
from video_grabber.directus.writer import _auth_headers, wasabi_public_url
from video_grabber.storage import wasabi


def probe_duration(url: str) -> int | None:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", url],
        capture_output=True, text=True,
    )
    if r.returncode != 0 or not r.stdout.strip():
        return None
    return int(float(r.stdout.strip()))


def _existing_urls(cfg: Config, *, client=httpx) -> set[str]:
    out, offset = set(), 0
    while True:
        r = client.get(f"{cfg.directus_url}/items/mp3_items",
                       params={"fields": "url", "limit": 500, "offset": offset},
                       headers=_auth_headers(cfg))
        r.raise_for_status()
        page = r.json().get("data") or []
        out |= {row["url"] for row in page if row.get("url")}
        if len(page) < 500:
            return out
        offset += 500


@flow(name="backfill-mp3-catalogue")
def backfill_mp3_catalogue_flow(dry_run: bool = True) -> None:
    logger = get_run_logger()
    cfg = Config()
    have = _existing_urls(cfg)
    keys = [k for k in wasabi.list_keys("audio/", cfg) if k.lower().endswith(".mp3")]
    created = 0
    for key in keys:
        url = wasabi_public_url(key)
        if url in have:
            continue
        parsed = parse_key(key)
        duration = probe_duration(url)
        if duration is None:
            logger.warning("backfill: could not probe %s; skipping", key)
            continue
        body = {
            "title": parsed.title,
            "full_title": parsed.title,
            "url": url,
            "format": "mp3",
            "calc_duration": duration,
            "timezone": "EDT",
            "approved": 0,
        }
        if parsed.start_utc is not None:
            body["start_date"] = parsed.start_utc.strftime("%Y-%m-%d %H:%M:%S")
        if dry_run:
            logger.info("DRY RUN would create: %s", body)
        else:
            r = httpx.post(f"{cfg.directus_url}/items/mp3_items",
                           json=body, headers=_auth_headers(cfg))
            r.raise_for_status()
        created += 1
    logger.info("backfill-mp3-catalogue: %d rows %s",
                created, "would be created" if dry_run else "created")


@flow(name="link-mp3-subtitles")
def link_mp3_subtitles_flow(dry_run: bool = True) -> None:
    """Point every mp3_items.subtitles at its SRT. Idempotent."""
    from pathlib import Path
    from video_grabber.transcribe.flows import existing_srt_key

    logger = get_run_logger()
    cfg = Config()
    srt_keys = [k for k in wasabi.list_keys(f"{cfg.subtitles_prefix}/", cfg)
                if k.endswith(".srt")]
    srt_paths, srt_stems = set(srt_keys), {Path(k).stem for k in srt_keys}

    linked = missing = 0
    offset = 0
    while True:
        r = httpx.get(f"{cfg.directus_url}/items/mp3_items",
                      params={"fields": "id,url,subtitles", "limit": 500, "offset": offset},
                      headers=_auth_headers(cfg))
        r.raise_for_status()
        page = r.json().get("data") or []
        for row in page:
            key = row["url"].replace("https://files.911realtime.org/", "")
            from urllib.parse import unquote
            srt_key = existing_srt_key(unquote(key), srt_stems, srt_paths)
            if srt_key is None:
                missing += 1
                continue
            target = wasabi_public_url(srt_key)
            if row.get("subtitles") == target:
                continue
            if not dry_run:
                pr = httpx.patch(f"{cfg.directus_url}/items/mp3_items/{row['id']}",
                                 json={"subtitles": target}, headers=_auth_headers(cfg))
                pr.raise_for_status()
            linked += 1
        if len(page) < 500:
            break
        offset += 500
    logger.info("link-mp3-subtitles: %d linked, %d without an SRT", linked, missing)
```

Register both in `serve.py` as manual-only deployments.

- [ ] **Step 2: Dry run and inspect**

Run `backfill-mp3-catalogue` with `dry_run=True`. Read the log. Confirm roughly 168
creations and that every `start_date` falls on 2001-09-11 between 11:00 and 23:59 UTC
(07:00–19:59 ET). Any date outside 2001-09-11 is a parser bug — stop and fix Task 6.

- [ ] **Step 3: Run for real**

Re-run with `dry_run=False`. Then `link-mp3-subtitles` with `dry_run=True`, inspect,
then `dry_run=False`.

- [ ] **Step 4: Verify**

```sql
SELECT count(*) AS rows, count(subtitles) AS linked FROM mp3_items;
```
Expected: 789 rows, 788 linked (the one untranscribed faa_atc file is the gap).

- [ ] **Step 5: Commit**

```bash
git add video_grabber/catalogue/flows.py video_grabber/serve.py
git commit -m "feat(catalogue): backfill mp3_items rows and link subtitles

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Party identification — pure logic

Everything decidable without a network call: which folders are eligible, how a
recording is tiered, how the prompt is built, how the response is parsed, and the
containment gate.

**Files:**
- Create: `video_grabber/parties/__init__.py` (empty)
- Create: `video_grabber/parties/identify.py`
- Modify: `video_grabber/transcript/summarize.py` (extract `unsupported_words`)
- Test: `tests/test_parties_identify.py`

**Interfaces:**
- Produces: `media_kind(key) -> str | None`, `should_identify(key) -> bool`,
  `tier_for(duration_seconds) -> str`, `build_clip_messages(transcript) -> tuple[str, str]`,
  `parse_parties(raw) -> dict`, `validate_parties(parsed, transcript) -> tuple[dict, list[str]]`
- Consumes: `unsupported_words(text, source)` from `transcript/summarize.py`

- [ ] **Step 1: Extract the shared containment helper**

In `video_grabber/transcript/summarize.py`, add alongside `content_words`:

```python
def unsupported_words(text: str, source: str) -> list[str]:
    """Content words in *text* that no variant of appears in *source*."""
    allowed = content_words(source)
    return sorted({w for w in _WORD.findall(text.lower())
                   if w not in _STOPWORDS and not (_variants(w) & allowed)})
```

Refactor `validate_abstract` to call it. Run `pytest tests/test_transcript_summarize.py -v`
and confirm still green — this refactor must not change behaviour.

- [ ] **Step 2: Write the failing tests**

Create `tests/test_parties_identify.py`:

```python
import pytest

from video_grabber.parties.identify import (
    BROADCAST,
    CONVERSATION,
    TIER_CLIP,
    TIER_TAPE,
    media_kind,
    parse_parties,
    should_identify,
    tier_for,
    validate_parties,
)

TRANSCRIPT = (
    "American dispatch, Jim McDonald. This is Indianapolis Center, "
    "trying to get a hold of American 77."
)


# --- the allow-list -------------------------------------------------------

def test_wins_is_broadcast_and_never_identified():
    assert media_kind("audio/wins1010/2001-09-11_1010_WINS_NEWS_10_AM.mp3") == BROADCAST
    assert should_identify("audio/wins1010/2001-09-11_1010_WINS_NEWS_10_AM.mp3") is False


def test_wcbs_is_broadcast_and_never_identified():
    assert media_kind("audio/wcbs/2001-09-11-08-48-00-wcbs.mp3") == BROADCAST
    assert should_identify("audio/wcbs/2001-09-11-08-48-00-wcbs.mp3") is False


def test_atc_folders_are_conversation():
    assert media_kind("audio/AA77/0812 aa77 taxi.mp3") == CONVERSATION
    assert should_identify("audio/AA77/0812 aa77 taxi.mp3") is True


def test_unknown_folder_is_skipped_not_identified():
    # Fail-closed: a folder nobody classified must not be identified by default.
    assert media_kind("audio/brand_new_collection/x.mp3") is None
    assert should_identify("audio/brand_new_collection/x.mp3") is False


def test_allow_list_is_not_a_deny_list():
    # Mutation guard. If someone rewrites should_identify as
    # `media_kind(key) != BROADCAST`, this turns red.
    assert should_identify("audio/unclassified/x.mp3") is False


# --- tiering --------------------------------------------------------------

def test_short_clip_is_a_clip():
    assert tier_for(43) == TIER_CLIP


def test_long_tape_is_a_tape():
    assert tier_for(24300) == TIER_TAPE


def test_missing_duration_raises_rather_than_defaulting():
    # Defaulting to clip would push a 6.75h transcript through the clip prompt.
    with pytest.raises(ValueError, match="duration"):
        tier_for(None)


# --- the containment gate -------------------------------------------------

GOOD = {
    "tier": "clip",
    "side_a": {"facility": "Indianapolis Center", "position": None, "person": None, "role": "atc"},
    "side_b": {"facility": "American", "position": "dispatch", "person": "Jim McDonald", "role": "airline"},
    "link": "landline", "aircraft": ["AAL77"], "confidence": "high",
    "evidence": "This is Indianapolis Center, trying to get a hold of American 77",
}


def test_gate_accepts_names_the_transcript_contains():
    cleaned, reasons = validate_parties(GOOD, TRANSCRIPT)
    assert reasons == []
    assert cleaned["confidence"] == "high"
    assert cleaned["side_b"]["person"] == "Jim McDonald"


def test_gate_drops_a_facility_the_transcript_never_names():
    # The failure this exists to prevent: the model knows 9/11 and supplies
    # NEADS from memory rather than from the audio.
    bad = {**GOOD, "side_a": {"facility": "NEADS", "position": None, "person": None, "role": "military"}}
    cleaned, reasons = validate_parties(bad, TRANSCRIPT)
    assert cleaned["side_a"]["facility"] is None
    assert cleaned["confidence"] == "low"
    assert any("neads" in r.lower() for r in reasons)


def test_gate_rejects_evidence_that_is_not_verbatim():
    bad = {**GOOD, "evidence": "Indianapolis Center said they lost the aircraft"}
    cleaned, reasons = validate_parties(bad, TRANSCRIPT)
    assert cleaned["confidence"] == "low"
    assert any("verbatim" in r for r in reasons)


def test_gate_tolerates_whitespace_and_case_in_evidence():
    ok = {**GOOD, "evidence": "  this IS indianapolis   center  "}
    _, reasons = validate_parties(ok, TRANSCRIPT)
    assert reasons == []


# --- parsing --------------------------------------------------------------

def test_parse_accepts_a_fenced_json_block():
    raw = '```json\n{"tier":"clip","confidence":"high"}\n```'
    assert parse_parties(raw)["tier"] == "clip"


def test_parse_rejects_non_json():
    with pytest.raises(ValueError):
        parse_parties("I could not determine the parties.")
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pytest tests/test_parties_identify.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'video_grabber.parties'`

- [ ] **Step 4: Write the implementation**

Create `video_grabber/parties/__init__.py` (empty) and
`video_grabber/parties/identify.py`:

```python
"""Decide who a recording's traffic is between. Pure logic only.

The network call is injected, so every rule here is unit-testable without a key —
same split as transcript/summarize.py, and for the same reason: the judgments that
matter must be testable in isolation.

The containment gate is the point of this module. The model knows how September 11
turned out. Asked who is speaking on a garbled tape it will confidently supply
"NEADS" or "Colin Scoggins" from background knowledge rather than from the audio.
Identification has to be a reading task, not a recall task, so every name the model
returns must already be in the transcript and its evidence quote must be verbatim.
"""
from __future__ import annotations

import json
import re

from video_grabber.transcript.summarize import unsupported_words

CONVERSATION = "conversation"
BROADCAST = "broadcast"

TIER_CLIP = "clip"
TIER_TAPE = "tape"
CLIP_MAX_SECONDS = 300

# Keyed on the first path segment under audio/. A module constant rather than an
# env var: this is a property of the corpus, not the deployment, and an env var is
# one more thing that can arrive empty.
MEDIA_KIND: dict[str, str] = {
    "AA11": CONVERSATION, "AA77": CONVERSATION, "UA93": CONVERSATION,
    "UA175": CONVERSATION, "DL1989": CONVERSATION, "NEADS": CONVERSATION,
    "norad": CONVERSATION, "Langley": CONVERSATION, "QUIT": CONVERSATION,
    "GOFER06": CONVERSATION, "ATCSCC": CONVERSATION, "FAA": CONVERSATION,
    "ZBW": CONVERSATION, "ZDC": CONVERSATION, "ZNY": CONVERSATION,
    "ZOB": CONVERSATION, "faa_atc": CONVERSATION, "fdny_dispatch": CONVERSATION,
    "rutgers_audiograph": CONVERSATION,
    # News radio: a broadcast has no counterparty. Excluded by decision.
    "wins1010": BROADCAST, "wcbs": BROADCAST,
}


def media_kind(key: str) -> str | None:
    """'conversation', 'broadcast', or None for a folder nobody has classified."""
    parts = key.split("/")
    if len(parts) < 3 or parts[0] != "audio":
        return None
    return MEDIA_KIND.get(parts[1])


def should_identify(key: str) -> bool:
    """Affirmative allow-list.

    Deliberately not `!= BROADCAST`. A deny-list that fails to load, or a typo in a
    folder name, silently re-admits WINS and WCBS and produces confident nonsense;
    an allow-list that fails to load identifies nothing, which is immediately
    obvious. An unclassified folder is skipped, not identified.
    """
    return media_kind(key) == CONVERSATION


def tier_for(duration_seconds: int | None) -> str:
    if duration_seconds is None:
        raise ValueError(
            "duration is required to tier a recording; refusing to guess "
            "(defaulting to clip would send a 6.75h transcript through the clip prompt)"
        )
    return TIER_CLIP if duration_seconds < CLIP_MAX_SECONDS else TIER_TAPE


_SYSTEM = """\
You identify who is speaking in a transcript of September 11, 2001 air traffic \
control, military, and emergency audio.

Rules you must follow:
- Use ONLY what the transcript says. Do not use anything you know about the events \
of September 11 from any other source.
- If the transcript does not name a facility, position, or person, return null for \
that field. Do not infer it.
- The `evidence` field must be an exact quote copied character-for-character from \
the transcript.
- If you cannot tell who is speaking, say so with confidence "low" and null sides. \
That is a correct answer, not a failure.

Return ONLY a JSON object:
{"tier":"clip",
 "side_a":{"facility":str|null,"position":str|null,"person":str|null,"role":str|null},
 "side_b":{"facility":str|null,"position":str|null,"person":str|null,"role":str|null},
 "link":"air-ground"|"landline"|"internal"|"unknown",
 "aircraft":[str],
 "confidence":"high"|"medium"|"low",
 "evidence":str}

`role` is one of: atc, military, airline, emergency, aircraft, unknown."""


def build_clip_messages(transcript: str) -> tuple[str, str]:
    return _SYSTEM, f"Transcript:\n\n{transcript}"


def build_tape_messages(filename: str, samples: list[str]) -> tuple[str, str]:
    system = _SYSTEM.replace('"tier":"clip"', '"tier":"tape"') + (
        "\n\nThis is a long continuous recording of ONE position. side_a is that "
        "position. side_b represents the many counterparties, so set its facility "
        "to \"various\". Identify the position from the filename and the samples."
    )
    joined = "\n\n---\n\n".join(samples)
    return system, f"Filename: {filename}\n\nSampled excerpts:\n\n{joined}"


_FENCE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.S)


def parse_parties(raw: str) -> dict:
    """Parse the model's reply, tolerating a markdown fence."""
    text = raw.strip()
    m = _FENCE.search(text)
    if m:
        text = m.group(1)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"model did not return JSON: {raw[:200]!r}") from exc
    if not isinstance(parsed, dict):
        raise ValueError(f"model returned {type(parsed).__name__}, not an object")
    return parsed


def _normalise(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip().lower()


def evidence_is_verbatim(evidence: str, transcript: str) -> bool:
    if not (evidence or "").strip():
        return False
    return _normalise(evidence) in _normalise(transcript)


def validate_parties(parsed: dict, transcript: str) -> tuple[dict, list[str]]:
    """Drop every name the transcript does not support; return (cleaned, reasons).

    Any rejection forces confidence to 'low' rather than discarding the whole
    answer: a partly-supported identification is still worth keeping, but it must
    not claim to be certain.
    """
    cleaned = json.loads(json.dumps(parsed))
    reasons: list[str] = []

    if not evidence_is_verbatim(cleaned.get("evidence", ""), transcript):
        reasons.append("evidence is not a verbatim quote from the transcript")
        cleaned["evidence"] = None

    for side in ("side_a", "side_b"):
        block = cleaned.get(side) or {}
        for field in ("facility", "position", "person"):
            value = block.get(field)
            if not value or value == "various":
                continue
            missing = unsupported_words(value, transcript)
            if missing:
                reasons.append(
                    f"{side}.{field}={value!r} names {missing} which the transcript "
                    f"never contains"
                )
                block[field] = None
        cleaned[side] = block

    for name in cleaned.get("aircraft") or []:
        if unsupported_words(str(name), transcript):
            reasons.append(f"aircraft {name!r} not present in transcript")
            cleaned["aircraft"] = [a for a in cleaned["aircraft"] if a != name]

    if reasons:
        cleaned["confidence"] = "low"
    return cleaned, reasons
```

- [ ] **Step 5: Run tests**

Run: `pytest tests/test_parties_identify.py -v && pytest tests/test_transcript_summarize.py -v`
Expected: all PASS

- [ ] **Step 6: Mutation-check the allow-list**

Temporarily change `should_identify` to `return media_kind(key) != BROADCAST`.
Run: `pytest tests/test_parties_identify.py -v`
Expected: `test_unknown_folder_is_skipped_not_identified` and
`test_allow_list_is_not_a_deny_list` both FAIL. **Revert the mutation.** If they
passed, the tests are not guarding the decision and must be strengthened.

- [ ] **Step 7: Commit**

```bash
git add video_grabber/parties video_grabber/transcript/summarize.py tests/test_parties_identify.py
git commit -m "feat(parties): pure identification logic with a containment gate

Allow-list (not deny-list) excludes WINS/WCBS and any unclassified folder.
The gate drops any facility, position, person or aircraft the transcript
does not contain, so the model cannot label from 9/11 background knowledge.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Party identification — flow, validated against AA77

**Files:**
- Create: `video_grabber/parties/flows.py`
- Modify: `video_grabber/config.py`, `video_grabber/serve.py`
- Test: `tests/test_parties_flows.py`

**Interfaces:**
- Consumes: everything from Task 8; `anthropic_completer(cfg)` from `transcript/summarize_flows.py`
- Produces: `identify_parties_flow(limit: int | None = None, force: bool = False, dry_run: bool = True)`

- [ ] **Step 1: Add the model setting**

In `video_grabber/config.py`, beside `summarize_model`:

```python
    parties_model: str = field(
        default_factory=lambda: os.getenv("PARTIES_MODEL", "claude-sonnet-5")
    )
```

- [ ] **Step 2: Write the flow**

Create `video_grabber/parties/flows.py`:

```python
"""Identify who each recording's traffic is between and write mp3_items.parties."""
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote

import httpx
from prefect import flow, get_run_logger

from video_grabber.config import Config
from video_grabber.directus.writer import _auth_headers
from video_grabber.parties.identify import (
    TIER_TAPE,
    build_clip_messages,
    build_tape_messages,
    parse_parties,
    should_identify,
    tier_for,
    validate_parties,
)
from video_grabber.storage import wasabi
from video_grabber.transcript.summarize_flows import anthropic_completer

SAMPLE_WINDOWS = 6
SAMPLE_CHARS = 2000


def srt_text_to_plain(srt: str) -> str:
    return " ".join(
        line.strip() for line in srt.splitlines()
        if line.strip() and not line.strip().isdigit() and "-->" not in line
    )


def sample_windows(text: str, n: int = SAMPLE_WINDOWS, size: int = SAMPLE_CHARS) -> list[str]:
    """Evenly spaced excerpts. A 6.75h transcript does not fit in one prompt."""
    if len(text) <= size:
        return [text]
    step = max(1, (len(text) - size) // max(1, n - 1))
    return [text[i:i + size] for i in range(0, len(text) - size + 1, step)][:n]


@flow(name="identify-parties")
def identify_parties_flow(limit: int | None = None, force: bool = False,
                          dry_run: bool = True) -> None:
    logger = get_run_logger()
    cfg = Config()
    if not cfg.anthropic_api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    complete = anthropic_completer(cfg)

    rows, offset = [], 0
    while True:
        r = httpx.get(f"{cfg.directus_url}/items/mp3_items",
                      params={"fields": "id,url,subtitles,calc_duration,parties",
                              "limit": 500, "offset": offset},
                      headers=_auth_headers(cfg))
        r.raise_for_status()
        page = r.json().get("data") or []
        rows += page
        if len(page) < 500:
            break
        offset += 500

    done = skipped = failed = 0
    for row in rows:
        if limit is not None and done >= limit:
            break
        key = unquote(row["url"].replace("https://files.911realtime.org/", ""))
        if not should_identify(key):
            skipped += 1
            continue
        if row.get("parties") and not force:
            skipped += 1
            continue
        if not row.get("subtitles"):
            logger.warning("identify-parties: %s has no subtitles; skipping", key)
            skipped += 1
            continue

        srt_key = unquote(row["subtitles"].replace("https://files.911realtime.org/", ""))
        transcript = srt_text_to_plain(wasabi.read_text(srt_key, cfg))
        if not transcript.strip():
            skipped += 1
            continue

        tier = tier_for(row.get("calc_duration"))
        if tier == TIER_TAPE:
            system, user = build_tape_messages(Path(key).name, sample_windows(transcript))
            source_for_gate = transcript
        else:
            system, user = build_clip_messages(transcript)
            source_for_gate = transcript

        try:
            parsed = parse_parties(complete(system, user))
        except ValueError as exc:
            logger.warning("identify-parties: %s unparseable: %s", key, exc)
            failed += 1
            continue

        cleaned, reasons = validate_parties(parsed, source_for_gate)
        cleaned["tier"] = tier
        cleaned["model"] = cfg.parties_model
        cleaned["generated_at"] = datetime.now(timezone.utc).isoformat()
        if reasons:
            cleaned["gate_reasons"] = reasons
            logger.info("identify-parties: %s downgraded: %s", key, reasons)

        if dry_run:
            logger.info("DRY RUN %s -> %s", key, cleaned)
        else:
            pr = httpx.patch(f"{cfg.directus_url}/items/mp3_items/{row['id']}",
                             json={"parties": cleaned}, headers=_auth_headers(cfg))
            pr.raise_for_status()
        done += 1

    logger.info("identify-parties: %d identified, %d skipped, %d failed",
                done, skipped, failed)
```

Register in `serve.py` as a manual-only deployment.

- [ ] **Step 3: Write the flow tests**

Create `tests/test_parties_flows.py`:

```python
from video_grabber.parties.flows import sample_windows, srt_text_to_plain

SRT = "1\n00:00:01,000 --> 00:00:02,000\nIndy Center.\n\n2\n00:00:03,000 --> 00:00:04,000\nAmerican 77.\n"


def test_srt_to_plain_drops_indices_and_timestamps():
    assert srt_text_to_plain(SRT) == "Indy Center. American 77."


def test_sample_windows_returns_whole_text_when_short():
    assert sample_windows("short", n=6, size=2000) == ["short"]


def test_sample_windows_spreads_across_a_long_transcript():
    text = "".join(str(i % 10) for i in range(20000))
    got = sample_windows(text, n=6, size=2000)
    assert len(got) == 6
    assert all(len(w) == 2000 for w in got)
    assert got[0] != got[-1]
```

Run: `pytest tests/test_parties_flows.py -v`
Expected: PASS

- [ ] **Step 4: Validate against the AA77 fixture**

Write a throwaway harness (not committed) that runs the real flow logic over
`tests/fixtures/aa77/srt/*.srt` and compares to `tests/fixtures/aa77/parties.csv`:

- The 23 rows with `tier == "A"` must have a non-null `side_a.facility` and
  `side_b.facility` that name the same organisations as the CSV. Judge equivalence
  by hand — "Indy Center" and "Indianapolis Center" agree.
- The 3 rows with `tier == "C"`
  (`093535 …he's descendin`, `093657 …looks like wen`, `100225 …line 4530 repo`)
  must NOT come back `confidence == "high"`. This is the real test of the gate.

Record the pass rate in the commit message. If tier-A agreement is below 18/23,
stop and revise the prompt in Task 8 before running the corpus.

- [ ] **Step 5: Commit**

```bash
git add video_grabber/parties/flows.py video_grabber/config.py video_grabber/serve.py tests/test_parties_flows.py
git commit -m "feat(parties): identification flow, validated against the AA77 fixture

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Run over the corpus

- [ ] **Step 1: Dry run a sample**

Run `identify-parties` with `limit=20, dry_run=True`. Read every one of the 20
logged objects. Confirm no `side_*` names a facility absent from its transcript.

- [ ] **Step 2: Confirm the exclusion holds**

In the log, confirm WINS and WCBS rows appear under `skipped` and never under
`identified`. Then:

```sql
SELECT count(*) FROM mp3_items
WHERE parties IS NOT NULL AND (url LIKE '%/wins1010/%' OR url LIKE '%/wcbs/%');
```
Expected: **0**. Any other result means the allow-list leaked; stop.

- [ ] **Step 3: Run the corpus**

Run with `dry_run=False`, no limit. Expect ~764 identified, ~25 skipped as broadcast.

- [ ] **Step 4: Verify coverage**

```sql
SELECT split_part(url, '/', 5) AS folder,
       count(*) AS rows,
       count(parties) AS identified,
       count(*) FILTER (WHERE parties->>'confidence' = 'high') AS high
FROM mp3_items GROUP BY 1 ORDER BY 2 DESC;
```

Expected: `wins1010` and `wcbs` show `identified = 0`; every other folder is fully
covered.

- [ ] **Step 5: Record the outcome**

Append a short results section to the design doc — counts by folder, confidence
distribution, and how many were downgraded by the gate. That last number is the
useful one: it measures how often the model tried to answer from memory.

```bash
git add plans/2026-08-13-audio-party-identification-design.md
git commit -m "docs: record party-identification corpus run results

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** Piece 0 → Task 1. Piece 1 → Tasks 2, 3, 4. Piece 2 → Tasks 6, 7.
Piece 3 → Tasks 8, 9, 10. Piece 4 → Task 5. Verification → Task 9 Step 4 and
Task 10 Steps 2 and 4. WINS/WCBS exclusion → Task 8 (constant, allow-list, mutation
check) and Task 10 Step 2 (production assertion). No spec requirement is unclaimed.

**Known gap, accepted.** The one untranscribed file
(`audio/faa_atc/zbw/tmu/5 ZBW 179 TMU SVWX 1200-1324 UTC.mp3`) is out of scope per
the spec. After Task 1, `dispatch-transcribe` will pick it up as the only pending
job — that is a safe single-file run, not the 296-hour hazard.

**Type consistency.** `existing_srt_key` (Task 1) is reused verbatim by
`link_mp3_subtitles_flow` (Task 7). `wasabi_public_url` (Task 2) is used in Tasks 1,
7. `unsupported_words` (Task 8 Step 1) is used only inside `validate_parties`.
`tier_for` returns the `TIER_CLIP`/`TIER_TAPE` constants that Task 9 imports by name.
