# IM Buddies — Plan B: Transcript Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate `chat_transcript_segments` — tier 2 of the IM Buddies knowledge stack — by parsing the already-generated channel-level `.srt` files into ~30-second segments stamped with absolute 2001 wall-clock times.

**Architecture:** A fourth sub-pipeline under `video_grabber/transcript/`, following the shape of the existing `transcribe/` package: pure logic in `segments.py`, a Directus writer in `writer.py`, and Prefect flows in `flows.py`. The heavy lifting already exists — `transcribe/srt.py` parses cues and `build-channel-subtitles` has already stitched one SRT per channel — so this plan reads those artifacts rather than regenerating anything.

**Tech Stack:** Python 3.12, Prefect, `httpx` against the Directus REST API, `pytest` + `respx`, `ruff`.

## Global Constraints

- Reuse `video_grabber.transcribe.srt` (`Cue`, `parse_srt`) — do **not** write a second SRT parser.
- `chat_transcript_segments` is a **Directus** collection, already applied to `api-beta`. Write it over the REST API with `httpx`; do **not** add an Alembic migration.
- **Batch Directus bulk inserts by serialized JSON bytes, not row count.** Directus 413s past ~1MB; the established cap is `_MAX_BATCH_BYTES = 900_000`.
- **Strip NUL bytes** before insert — Postgres text columns reject `\x00` and it 400s the whole batch.
- Use a long read timeout for bulk Directus work: `httpx.Timeout(connect=30.0, read=600.0, write=120.0, pool=30.0)`. The 5s default fails on large server-side operations.
- **Normalize every datetime to naive UTC before arithmetic.** Directus `timestamp` columns come back naive and `timestamptz` come back aware; mixing them raises. This is a tested bug class in this package.
- **A lookup miss is a hard failure, not a skip.** A stale marker once produced a silently-empty "successful" run for CCTV4. Raise rather than write nothing.
- **All times are UTC.**
- New config knobs go in `video_grabber/config.py` as env-var-backed dataclass fields, in a commented section.
- `pytest` and `ruff check video_grabber/ tests/` both gate merge. Run both before every commit.
- Tests live flat in `tests/` as `test_<module>.py`. Flow tests call `flow_fn.fn(...)` to bypass the Prefect engine.

---

### Task 1: Segment builder (pure logic)

**Files:**
- Create: `packages/tools/video-grabber/video_grabber/transcript/__init__.py` (empty)
- Create: `packages/tools/video-grabber/video_grabber/transcript/segments.py`
- Create: `packages/tools/video-grabber/tests/test_segments.py`

**Interfaces:**
- Consumes: `video_grabber.transcribe.srt.Cue` — a frozen dataclass with `start: float`, `end: float`, `text: str`, all seconds relative to the file.
- Produces:
  - `Segment` — frozen dataclass, fields `start: float`, `end: float`, `text: str`
  - `def build_segments(cues: list[Cue], *, max_seconds: float = 30.0, max_gap: float = 3.0) -> list[Segment]`
  - `def to_rows(segments: list[Segment], anchor: datetime, *, channel: int | None, channel_slug: str | None, medium: str) -> list[dict]`

- [ ] **Step 1: Write the failing tests**

Create `packages/tools/video-grabber/tests/test_segments.py`:

```python
from datetime import datetime

import pytest

from video_grabber.transcribe.srt import Cue
from video_grabber.transcript.segments import Segment, build_segments, to_rows


def test_merges_adjacent_cues_into_one_segment():
    cues = [Cue(0.0, 2.0, "the north tower"), Cue(2.0, 4.0, "has been hit")]
    segs = build_segments(cues)
    assert segs == [Segment(0.0, 4.0, "the north tower has been hit")]


def test_splits_when_max_seconds_would_be_exceeded():
    cues = [Cue(float(i) * 10.0, float(i) * 10.0 + 10.0, f"c{i}") for i in range(4)]
    segs = build_segments(cues, max_seconds=30.0)
    assert len(segs) == 2
    assert segs[0].start == 0.0 and segs[0].end == 30.0
    assert segs[0].text == "c0 c1 c2"
    assert segs[1].start == 30.0 and segs[1].end == 40.0


def test_splits_on_a_long_gap_even_when_under_max_seconds():
    # A 30s window spanning a long silence would otherwise produce one segment
    # whose text is two unrelated utterances under a misleading time range.
    cues = [Cue(0.0, 1.0, "before"), Cue(9.0, 10.0, "after")]
    segs = build_segments(cues, max_seconds=30.0, max_gap=3.0)
    assert len(segs) == 2
    assert segs[0].text == "before"
    assert segs[1].text == "after"


def test_gap_exactly_at_the_threshold_does_not_split():
    cues = [Cue(0.0, 1.0, "before"), Cue(4.0, 5.0, "after")]
    segs = build_segments(cues, max_seconds=30.0, max_gap=3.0)
    assert len(segs) == 1


def test_drops_empty_and_whitespace_only_cues():
    cues = [Cue(0.0, 1.0, "kept"), Cue(1.0, 2.0, "   "), Cue(2.0, 3.0, "")]
    segs = build_segments(cues)
    assert segs == [Segment(0.0, 1.0, "kept")]


def test_collapses_internal_whitespace_and_newlines():
    cues = [Cue(0.0, 2.0, "two lines\nof  text")]
    segs = build_segments(cues)
    assert segs[0].text == "two lines of text"


def test_empty_input_yields_no_segments():
    assert build_segments([]) == []


def test_a_single_cue_longer_than_max_seconds_is_kept_whole():
    # Splitting mid-cue would invent a timestamp for text we cannot place.
    cues = [Cue(0.0, 45.0, "a very long uninterrupted statement")]
    segs = build_segments(cues, max_seconds=30.0)
    assert len(segs) == 1
    assert segs[0].end == 45.0


def test_to_rows_offsets_by_the_anchor():
    anchor = datetime(2001, 9, 11, 12, 0, 0)
    segs = [Segment(90.0, 120.0, "text")]
    rows = to_rows(segs, anchor, channel=7, channel_slug="wnbc", medium="tv")
    assert rows == [
        {
            "channel": 7,
            "channel_slug": "wnbc",
            "medium": "tv",
            "start_date": "2001-09-11T12:01:30",
            "end_date": "2001-09-11T12:02:00",
            "text": "text",
        }
    ]


def test_to_rows_rejects_an_aware_anchor():
    # Mixing naive and aware datetimes is a tested bug class in this package;
    # fail loudly at the boundary rather than silently shifting by the offset.
    from datetime import timezone

    with pytest.raises(ValueError, match="naive UTC"):
        to_rows([Segment(0.0, 1.0, "t")], datetime(2001, 9, 11, tzinfo=timezone.utc),
                channel=1, channel_slug=None, medium="tv")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/tools/video-grabber && pytest tests/test_segments.py -v`
Expected: collection error — `ModuleNotFoundError: No module named 'video_grabber.transcript'`.

- [ ] **Step 3: Write the implementation**

Create `packages/tools/video-grabber/video_grabber/transcript/__init__.py` as an empty file, then `packages/tools/video-grabber/video_grabber/transcript/segments.py`:

```python
"""Merge SRT cues into retrieval-sized transcript segments.

Pure logic, no I/O and no Prefect, so the timing arithmetic is unit-testable in
isolation — the same reasoning as transcribe/srt.py.

A cue is roughly a sentence, which is too small to retrieve against: a query
matches a fragment with no surrounding context. A whole program is far too
large. Thirty seconds is about a spoken paragraph, which is what the chat
composer wants to put in a prompt.
"""

from dataclasses import dataclass
from datetime import datetime

from video_grabber.transcribe.srt import Cue


@dataclass(frozen=True)
class Segment:
    start: float
    end: float
    text: str


def build_segments(
    cues: list[Cue], *, max_seconds: float = 30.0, max_gap: float = 3.0
) -> list[Segment]:
    """Group cues into segments of at most max_seconds, breaking on long silences.

    The gap rule matters as much as the duration rule: a window that spans a
    long silence would otherwise join two unrelated utterances under one time
    range, which reads as a single statement to anything retrieving it.

    A cue longer than max_seconds is emitted whole rather than split — there is
    no honest timestamp to split it at.
    """
    out: list[Segment] = []
    start: float | None = None
    end = 0.0
    parts: list[str] = []

    def flush() -> None:
        nonlocal start, end, parts
        if start is not None and parts:
            out.append(Segment(start, end, " ".join(parts)))
        start, parts = None, []

    for cue in cues:
        text = " ".join(cue.text.split())
        if not text:
            continue
        if start is not None and (cue.start - end > max_gap or cue.end - start > max_seconds):
            flush()
        if start is None:
            start = cue.start
        end = cue.end
        parts.append(text)

    flush()
    return out


def to_rows(
    segments: list[Segment],
    anchor: datetime,
    *,
    channel: int | None,
    channel_slug: str | None,
    medium: str,
) -> list[dict]:
    """Stamp segments with absolute 2001 wall-clock times, ready for Directus.

    Cue times are relative to the start of the media file; the anchor is that
    file's own start_date, so absolute = anchor + cue offset. For a channel-level
    SRT the anchor is tv_channels.start_date; for radio it is the mp3_items row's
    start_date.
    """
    if anchor.tzinfo is not None:
        raise ValueError(f"anchor must be a naive UTC datetime, got {anchor!r}")

    rows = []
    for seg in segments:
        rows.append(
            {
                "channel": channel,
                "channel_slug": channel_slug,
                "medium": medium,
                "start_date": _stamp(anchor, seg.start),
                "end_date": _stamp(anchor, seg.end),
                "text": seg.text,
            }
        )
    return rows


def _stamp(anchor: datetime, offset_seconds: float) -> str:
    from datetime import timedelta

    return (anchor + timedelta(seconds=offset_seconds)).isoformat()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/tools/video-grabber && pytest tests/test_segments.py -v`
Expected: 10 passed.

- [ ] **Step 5: Lint and commit**

Run: `cd packages/tools/video-grabber && ruff check video_grabber/ tests/`
Expected: no output.

```bash
git add packages/tools/video-grabber/video_grabber/transcript/ packages/tools/video-grabber/tests/test_segments.py
git commit -m "feat(transcript): add SRT cue segment builder"
```

---

### Task 2: Directus writer

**Files:**
- Create: `packages/tools/video-grabber/video_grabber/transcript/writer.py`
- Create: `packages/tools/video-grabber/tests/test_transcript_writer.py`

**Interfaces:**
- Consumes: `video_grabber.config.Config` (fields `directus_url`, `directus_api_token`).
- Produces:
  - `def list_subtitled_channels(cfg, *, client=httpx) -> list[dict]` — each `{"id": int, "slug": str | None, "start_date": datetime, "subtitles": str}`
  - `def list_subtitled_mp3_items(cfg, *, client=httpx) -> list[dict]` — same shape, `slug` is `None`
  - `def fetch_srt(url: str, *, client=httpx) -> str`
  - `def replace_segments(rows: list[dict], *, medium: str, channel: int | None, channel_slug: str | None, cfg, client=httpx) -> int`

- [ ] **Step 1: Write the failing tests**

Create `packages/tools/video-grabber/tests/test_transcript_writer.py`:

```python
import httpx
import pytest
import respx

from video_grabber.config import Config
from video_grabber.transcript import writer


@pytest.fixture
def cfg():
    return Config(directus_url="https://directus.test", directus_api_token="tok")


@respx.mock
def test_replace_segments_deletes_before_inserting(cfg):
    delete = respx.delete("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(204)
    )
    insert = respx.post("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(200, json={"data": []})
    )

    rows = [{"channel": 7, "channel_slug": "wnbc", "medium": "tv",
             "start_date": "2001-09-11T12:00:00", "end_date": "2001-09-11T12:00:30",
             "text": "hello"}]
    written = writer.replace_segments(rows, medium="tv", channel=7, channel_slug="wnbc", cfg=cfg)

    assert written == 1
    assert delete.called, "existing rows must be cleared before reinserting"
    assert insert.called
    # The delete must be scoped to exactly the identity the rows carry, or it
    # matches nothing and every re-run doubles the data.
    assert '"channel": {"_eq": 7}' in delete.calls[0].request.url.params["filter"]
    assert '"medium": {"_eq": "tv"}' in delete.calls[0].request.url.params["filter"]


@respx.mock
def test_replace_segments_strips_nul_bytes(cfg):
    respx.delete("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(204)
    )
    insert = respx.post("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(200, json={"data": []})
    )

    rows = [{"channel": 1, "channel_slug": None, "medium": "tv",
             "start_date": "2001-09-11T12:00:00", "end_date": "2001-09-11T12:00:30",
             "text": "bad\x00byte"}]
    writer.replace_segments(rows, medium="tv", channel=1, channel_slug=None, cfg=cfg)

    body = insert.calls[0].request.read().decode()
    assert "\\u0000" not in body and "\x00" not in body
    assert "badbyte" in body


@respx.mock
def test_replace_segments_batches_by_serialized_size(cfg, monkeypatch):
    monkeypatch.setattr(writer, "_MAX_BATCH_BYTES", 500)
    respx.delete("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(204)
    )
    insert = respx.post("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(200, json={"data": []})
    )

    rows = [{"channel": 1, "channel_slug": None, "medium": "tv",
             "start_date": "2001-09-11T12:00:00", "end_date": "2001-09-11T12:00:30",
             "text": "x" * 100} for _ in range(10)]
    writer.replace_segments(rows, medium="tv", channel=1, channel_slug=None, cfg=cfg)

    assert insert.call_count > 1, "a payload over the cap must be split into batches"


@respx.mock
def test_replace_segments_with_no_rows_still_clears(cfg):
    # A channel whose transcript became empty must not keep its stale rows.
    delete = respx.delete("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(204)
    )
    insert = respx.post("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(200, json={"data": []})
    )

    written = writer.replace_segments([], medium="tv", channel=3, channel_slug=None, cfg=cfg)

    assert written == 0
    assert delete.called
    assert not insert.called


@respx.mock
def test_replace_segments_raises_on_directus_error(cfg):
    respx.delete("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(204)
    )
    respx.post("https://directus.test/items/chat_transcript_segments").mock(
        return_value=httpx.Response(400, text="bad request")
    )

    rows = [{"channel": 1, "channel_slug": None, "medium": "tv",
             "start_date": "2001-09-11T12:00:00", "end_date": "2001-09-11T12:00:30",
             "text": "t"}]
    with pytest.raises(httpx.HTTPStatusError):
        writer.replace_segments(rows, medium="tv", channel=1, channel_slug=None, cfg=cfg)


@respx.mock
def test_list_subtitled_channels_skips_rows_without_subtitles(cfg):
    respx.get("https://directus.test/items/tv_channels").mock(
        return_value=httpx.Response(200, json={"data": [
            {"id": 1, "start_date": "2001-09-09T00:00:00", "subtitles": "https://f/1.srt",
             "content": '{"channel_stream": "wnbc"}'},
            {"id": 2, "start_date": "2001-09-09T00:00:00", "subtitles": None,
             "content": None},
            {"id": 3, "start_date": "2001-09-09T00:00:00", "subtitles": "",
             "content": None},
        ]})
    )

    got = writer.list_subtitled_channels(cfg)

    assert [c["id"] for c in got] == [1]
    assert got[0]["slug"] == "wnbc"
    assert got[0]["start_date"].tzinfo is None, "anchors must be naive UTC"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/tools/video-grabber && pytest tests/test_transcript_writer.py -v`
Expected: `ImportError: cannot import name 'writer' from 'video_grabber.transcript'`.

- [ ] **Step 3: Write the implementation**

Create `packages/tools/video-grabber/video_grabber/transcript/writer.py`:

```python
"""Directus I/O for chat_transcript_segments.

chat_transcript_segments is a Directus collection, so it is written over the
REST API rather than this package's Alembic-managed schema — the same split as
tv_channels, mp3_items, and usenet_items.
"""

import json
from datetime import datetime

import httpx

from video_grabber.config import Config

_COLLECTION = "chat_transcript_segments"

# Directus 413s past roughly 1MB, so batches are sized by serialized bytes
# rather than row count — a long transcript segment is far bigger than a short one.
_MAX_BATCH_BYTES = 900_000

# The default 5s read timeout fails on large server-side bulk operations.
_TIMEOUT = httpx.Timeout(connect=30.0, read=600.0, write=120.0, pool=30.0)


def _headers(cfg: Config) -> dict:
    return {"Authorization": f"Bearer {cfg.directus_api_token}"}


def _naive_utc(value: str) -> datetime:
    """Parse a Directus timestamp to naive UTC.

    Directus returns `timestamp` columns naive and `timestamptz` aware; mixing
    the two raises on subtraction, which is a tested bug class in this package.
    """
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is not None:
        dt = dt.astimezone(tz=None).replace(tzinfo=None)
    return dt


def _slug_from_content(content) -> str | None:
    """Read the channel_stream marker out of the opaque `content` JSON string."""
    if not content:
        return None
    try:
        return json.loads(content).get("channel_stream")
    except (ValueError, AttributeError):
        return None


def list_subtitled_channels(cfg: Config, *, client=httpx) -> list[dict]:
    r = client.get(
        f"{cfg.directus_url}/items/tv_channels",
        params={"fields": "id,start_date,subtitles,content", "limit": -1},
        headers=_headers(cfg),
        timeout=_TIMEOUT,
    )
    r.raise_for_status()
    out = []
    for row in r.json()["data"]:
        if not row.get("subtitles"):
            continue
        out.append(
            {
                "id": row["id"],
                "slug": _slug_from_content(row.get("content")),
                "start_date": _naive_utc(row["start_date"]),
                "subtitles": row["subtitles"],
            }
        )
    return out


def list_subtitled_mp3_items(cfg: Config, *, client=httpx) -> list[dict]:
    r = client.get(
        f"{cfg.directus_url}/items/mp3_items",
        params={"fields": "id,start_date,subtitles", "limit": -1},
        headers=_headers(cfg),
        timeout=_TIMEOUT,
    )
    r.raise_for_status()
    out = []
    for row in r.json()["data"]:
        if not row.get("subtitles"):
            continue
        out.append(
            {
                "id": row["id"],
                "slug": None,
                "start_date": _naive_utc(row["start_date"]),
                "subtitles": row["subtitles"],
            }
        )
    return out


def fetch_srt(url: str, *, client=httpx) -> str:
    r = client.get(url, timeout=_TIMEOUT)
    r.raise_for_status()
    return r.text


def _clean(value):
    """Strip NUL bytes — Postgres text columns reject them and 400 the batch."""
    if isinstance(value, str):
        return value.replace("\x00", "")
    return value


def _size_batches(payloads: list[dict]):
    batch: list[dict] = []
    size = 2  # the enclosing [] brackets
    for p in payloads:
        psize = len(json.dumps(p)) + 1  # + comma
        if batch and size + psize > _MAX_BATCH_BYTES:
            yield batch
            batch, size = [], 2
        batch.append(p)
        size += psize
    if batch:
        yield batch


def replace_segments(
    rows: list[dict],
    *,
    medium: str,
    channel: int | None,
    channel_slug: str | None,
    cfg: Config,
    client=httpx,
) -> int:
    """Delete this source's existing segments, then insert the fresh set.

    Regenerate-and-replace rather than per-row upsert: it is far faster and
    trivially idempotent, matching how usenet groups and channel subtitles are
    already rebuilt. The delete runs even when there are no rows, so a source
    whose transcript became empty does not keep stale segments.
    """
    where = {"medium": {"_eq": medium}}
    if channel is not None:
        where["channel"] = {"_eq": channel}
    elif channel_slug is not None:
        where["channel_slug"] = {"_eq": channel_slug}
    else:
        raise ValueError("replace_segments needs a channel id or a channel_slug to scope the delete")

    d = client.delete(
        f"{cfg.directus_url}/items/{_COLLECTION}",
        params={"filter": json.dumps(where)},
        headers=_headers(cfg),
        timeout=_TIMEOUT,
    )
    d.raise_for_status()

    cleaned = [{k: _clean(v) for k, v in row.items()} for row in rows]
    written = 0
    for batch in _size_batches(cleaned):
        r = client.post(
            f"{cfg.directus_url}/items/{_COLLECTION}",
            json=batch,
            headers=_headers(cfg),
            timeout=_TIMEOUT,
        )
        r.raise_for_status()
        written += len(batch)
    return written
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/tools/video-grabber && pytest tests/test_transcript_writer.py -v`
Expected: 6 passed.

- [ ] **Step 5: Lint and commit**

Run: `cd packages/tools/video-grabber && ruff check video_grabber/ tests/ && pytest -q`
Expected: no ruff output; the whole suite passes.

```bash
git add packages/tools/video-grabber/video_grabber/transcript/writer.py packages/tools/video-grabber/tests/test_transcript_writer.py
git commit -m "feat(transcript): add Directus writer for chat_transcript_segments"
```

---

### Task 3: The flow

**Files:**
- Create: `packages/tools/video-grabber/video_grabber/transcript/flows.py`
- Create: `packages/tools/video-grabber/tests/test_transcript_flows.py`
- Modify: `packages/tools/video-grabber/video_grabber/serve.py`
- Create: `packages/tools/video-grabber/docs/transcript-segments.md`

**Interfaces:**
- Consumes: everything from Tasks 1 and 2.
- Produces: `@flow(name="build-transcript-segments")` `def build_transcript_segments_flow(medium: str = "all") -> dict`

- [ ] **Step 1: Write the failing tests**

Create `packages/tools/video-grabber/tests/test_transcript_flows.py`:

```python
from datetime import datetime

import pytest

from video_grabber.config import Config
from video_grabber.transcript import flows


SRT = """1
00:00:00,000 --> 00:00:02,000
the north tower

2
00:00:02,000 --> 00:00:04,000
has been hit
"""


@pytest.fixture
def cfg():
    return Config(directus_url="https://directus.test", directus_api_token="tok")


def test_builds_absolute_timestamps_from_the_channel_anchor(cfg, monkeypatch):
    monkeypatch.setattr(flows.writer, "list_subtitled_channels", lambda c, **k: [
        {"id": 7, "slug": "wnbc", "start_date": datetime(2001, 9, 11, 12, 0, 0),
         "subtitles": "https://f/wnbc.srt"}
    ])
    monkeypatch.setattr(flows.writer, "list_subtitled_mp3_items", lambda c, **k: [])
    monkeypatch.setattr(flows.writer, "fetch_srt", lambda url, **k: SRT)

    captured = {}

    def fake_replace(rows, **kwargs):
        captured["rows"] = rows
        captured["kwargs"] = kwargs
        return len(rows)

    monkeypatch.setattr(flows.writer, "replace_segments", fake_replace)

    result = flows.build_transcript_segments_flow.fn(medium="tv", cfg=cfg)

    assert result["channels"] == 1
    assert result["segments"] == 1
    # Cue offsets are relative to the file; the row must be absolute 2001 time.
    assert captured["rows"][0]["start_date"] == "2001-09-11T12:00:00"
    assert captured["rows"][0]["end_date"] == "2001-09-11T12:00:04"
    assert captured["rows"][0]["text"] == "the north tower has been hit"
    assert captured["kwargs"]["channel"] == 7
    assert captured["kwargs"]["medium"] == "tv"


def test_radio_anchors_on_the_mp3_items_start_date(cfg, monkeypatch):
    monkeypatch.setattr(flows.writer, "list_subtitled_channels", lambda c, **k: [])
    monkeypatch.setattr(flows.writer, "list_subtitled_mp3_items", lambda c, **k: [
        {"id": 42, "slug": None, "start_date": datetime(2001, 9, 11, 13, 30, 0),
         "subtitles": "https://f/42.srt"}
    ])
    monkeypatch.setattr(flows.writer, "fetch_srt", lambda url, **k: SRT)

    captured = {}
    monkeypatch.setattr(flows.writer, "replace_segments",
                        lambda rows, **kw: captured.update(rows=rows, kwargs=kw) or len(rows))

    result = flows.build_transcript_segments_flow.fn(medium="radio", cfg=cfg)

    assert result["mp3_items"] == 1
    assert captured["rows"][0]["start_date"] == "2001-09-11T13:30:00"
    assert captured["kwargs"]["medium"] == "radio"
    assert captured["kwargs"]["channel"] is None


def test_raises_when_no_subtitled_sources_are_found(cfg, monkeypatch):
    # A silently-empty successful run is the CCTV4 failure mode: everything
    # reports green while the derived artifact is missing.
    monkeypatch.setattr(flows.writer, "list_subtitled_channels", lambda c, **k: [])
    monkeypatch.setattr(flows.writer, "list_subtitled_mp3_items", lambda c, **k: [])

    with pytest.raises(RuntimeError, match="no subtitled"):
        flows.build_transcript_segments_flow.fn(medium="all", cfg=cfg)


def test_one_failing_source_does_not_abort_the_rest(cfg, monkeypatch):
    monkeypatch.setattr(flows.writer, "list_subtitled_channels", lambda c, **k: [
        {"id": 1, "slug": "a", "start_date": datetime(2001, 9, 11, 12, 0, 0),
         "subtitles": "https://f/a.srt"},
        {"id": 2, "slug": "b", "start_date": datetime(2001, 9, 11, 12, 0, 0),
         "subtitles": "https://f/b.srt"},
    ])
    monkeypatch.setattr(flows.writer, "list_subtitled_mp3_items", lambda c, **k: [])

    def flaky_fetch(url, **k):
        if url.endswith("a.srt"):
            raise RuntimeError("wasabi hiccup")
        return SRT

    monkeypatch.setattr(flows.writer, "fetch_srt", flaky_fetch)
    monkeypatch.setattr(flows.writer, "replace_segments", lambda rows, **kw: len(rows))

    result = flows.build_transcript_segments_flow.fn(medium="tv", cfg=cfg)

    assert result["channels"] == 1
    assert result["failed"] == 1
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/tools/video-grabber && pytest tests/test_transcript_flows.py -v`
Expected: `ImportError: cannot import name 'flows' from 'video_grabber.transcript'`.

- [ ] **Step 3: Write the implementation**

Create `packages/tools/video-grabber/video_grabber/transcript/flows.py`:

```python
"""Build chat_transcript_segments from the channel-level and per-item SRTs.

This runs downstream of build-channel-subtitles (TV) and transcribe-item
(radio); it reads their output rather than regenerating anything.

The timing is simpler than the subtitle builder's. That flow computes an offset
*into a channel's stitched stream*, because that is what HLS playback needs:

    cue_stream_time = cue_program_time + (air_date - tv_channels.start_date)

Segments need an absolute 2001 wall-clock time instead, and the channel-window
anchor cancels out — for the already-stitched channel SRT it is simply
tv_channels.start_date + cue offset, and for radio the mp3_items row's own
start_date + cue offset.
"""

from prefect import flow, get_run_logger

from video_grabber.config import Config
from video_grabber.transcribe.srt import parse_srt
from video_grabber.transcript import writer
from video_grabber.transcript.segments import build_segments, to_rows


def _ingest_one(source: dict, *, medium: str, cfg: Config, logger) -> int:
    # The identity written into the rows and the identity the delete scopes on
    # MUST be the same, or the delete matches nothing and every re-run doubles
    # the data. Radio has no tv_channels row, so it is identified by a synthetic
    # slug rather than a channel id.
    channel = source["id"] if medium == "tv" else None
    slug = source["slug"] if medium == "tv" else f"mp3:{source['id']}"

    srt = writer.fetch_srt(source["subtitles"])
    segments = build_segments(parse_srt(srt))
    rows = to_rows(
        segments,
        source["start_date"],
        channel=channel,
        channel_slug=slug,
        medium=medium,
    )
    written = writer.replace_segments(
        rows, medium=medium, channel=channel, channel_slug=slug, cfg=cfg
    )
    logger.info("ingested %s %s: %d segments", medium, source["id"], written)
    return written


@flow(name="build-transcript-segments")
def build_transcript_segments_flow(medium: str = "all", cfg: Config | None = None) -> dict:
    """Rebuild chat_transcript_segments for TV, radio, or both.

    Per-source failures are collected rather than raised so one unreachable SRT
    does not cost the whole run; finding *no* sources at all is a hard failure,
    because a silently-empty successful run is how a fully transcribed channel
    once went missing without anyone noticing.
    """
    logger = get_run_logger()
    cfg = cfg or Config()

    channels = writer.list_subtitled_channels(cfg) if medium in ("tv", "all") else []
    mp3_items = writer.list_subtitled_mp3_items(cfg) if medium in ("radio", "all") else []

    if not channels and not mp3_items:
        raise RuntimeError(f"no subtitled sources found for medium={medium!r}")

    result = {"channels": 0, "mp3_items": 0, "segments": 0, "failed": 0}

    for source, kind in [(c, "tv") for c in channels] + [(m, "radio") for m in mp3_items]:
        try:
            written = _ingest_one(source, medium=kind, cfg=cfg, logger=logger)
        except Exception as exc:  # noqa: BLE001 - one bad source must not stop the run
            logger.error("failed %s %s: %s", kind, source["id"], exc)
            result["failed"] += 1
            continue
        result["segments"] += written
        result["channels" if kind == "tv" else "mp3_items"] += 1

    logger.info("transcript segments rebuilt: %s", result)
    return result
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/tools/video-grabber && pytest tests/test_transcript_flows.py -v`
Expected: 4 passed.

- [ ] **Step 5: Register the flow**

In `packages/tools/video-grabber/video_grabber/serve.py`, add the import alongside the other flow imports:

```python
from video_grabber.transcript.flows import build_transcript_segments_flow
```

and inside `serve()`, alongside the other `.to_deployment(...)` calls:

```python
        build_transcript_segments_flow.to_deployment(
            name="build-transcript-segments",
            # Manual-trigger only. The source SRTs are immutable historical
            # artifacts, so this is a re-run-on-demand backfill, not a poller.
            concurrency_limit=1,
        ),
```

Do not give it an `interval` — it has nothing to poll for.

- [ ] **Step 6: Document it**

Create `packages/tools/video-grabber/docs/transcript-segments.md` covering: what the flow produces and why (tier 2 of the IM Buddies knowledge stack), the anchor arithmetic and how it differs from `build-channel-subtitles`, the delete-then-insert re-run behaviour, and the manual trigger recipe:

```python
from prefect.deployments import run_deployment
run_deployment(name="build-transcript-segments/build-transcript-segments",
               parameters={"medium": "all"})
```

- [ ] **Step 7: Full verification and commit**

Run: `cd packages/tools/video-grabber && ruff check video_grabber/ tests/ && pytest -q`
Expected: no ruff output; the whole suite passes.

```bash
git add packages/tools/video-grabber/video_grabber/transcript/flows.py \
        packages/tools/video-grabber/tests/test_transcript_flows.py \
        packages/tools/video-grabber/video_grabber/serve.py \
        packages/tools/video-grabber/docs/transcript-segments.md
git commit -m "feat(transcript): add build-transcript-segments flow"
```

---

## What Plan B deliberately leaves out

- **No jobs table.** This is a regenerate-from-source backfill like `build-channel-subtitles`, not a per-item pipeline needing retry bookkeeping. If per-source failures turn out to need retries, the `transcribe_jobs` table in `db/migrations/versions/003_transcribe_jobs.py` is the template.
- **No new Directus collection.** `chat_transcript_segments` was applied to `api-beta` during Plan A.
- **No schedule.** The source SRTs are immutable historical artifacts; there is nothing to poll for.
- **No retrieval.** Querying these segments is Plan C's job.
