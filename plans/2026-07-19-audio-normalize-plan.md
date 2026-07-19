# Audio Normalization Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fourth video-grabber Prefect pipeline that measures loudness of every `audio/*.mp3` in Wasabi into a reviewable Postgres report, then — on manual trigger — normalizes each file in place (`dynaudnorm` + two-pass EBU R128 `loudnorm`), archiving originals to `audio-original/` first.

**Architecture:** Mirrors `video_grabber/transcribe/`: Alembic migration `004` adds a `normalize_jobs` state table; flows `scan-normalize` → `dispatch-analyze-normalize` → `analyze-normalize-item` populate measurements, and a **separate, never-scheduled** `dispatch-normalize` → `normalize-item` performs the destructive pass. All S3 work goes through `storage/wasabi.py`; ffmpeg via subprocess; Cloudflare purge is best-effort.

**Tech Stack:** Python 3.12, Prefect 3, SQLAlchemy Core + Alembic, boto3 (moto in tests), httpx (respx in tests), ffmpeg/ffprobe CLI.

**Spec:** `plans/2026-07-19-audio-normalize-design.md` — read it first; decisions there are binding.

## Global Constraints

- Package root: `packages/tools/video-grabber`. Run all commands from there.
- Verify before every commit: `pytest tests/ -v` and `ruff check video_grabber/ tests/` (CI blocks on both). `tests/test_migrations.py` **errors** (not fails) without a live Postgres — that's an environment gap, not a regression.
- Normalization targets are Config-driven, defaults: `NORM_TARGET_I=-16` (LUFS), `NORM_TARGET_TP=-1.5` (dBTP), `NORM_TOLERANCE_LU=1.0`.
- Skip rule: `abs(input_i − target_i) ≤ tolerance` **and** `input_tp ≤ target_tp` → `skipped`.
- Re-encode: `libmp3lame`, source sample rate + channels, bitrate `max(source_kbps, 128)` kbps CBR.
- Archive rule: `audio/<name>.mp3` → `audio-original/<name>.mp3`, **first write wins forever** (never overwrite an existing archive key); normalization input is always downloaded **from the archive key**, never from `audio/`.
- `dispatch-normalize` must never get a schedule.
- Failed-job discriminator: a `failed` row with `input_i IS NULL` failed during analysis (re-claimed by `dispatch-analyze-normalize`); with `input_i IS NOT NULL` it failed during normalization (re-claimed by `dispatch-normalize`). Both respect `retry_count < max_retries`.
- Commits: end messages with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. The repo pre-commit hook bumps `classicy` in the frontend lockfile — an unrelated `pnpm-lock.yaml` change riding along is expected; include it.

---

### Task 1: Migration 004 — `normalize_jobs`

**Files:**
- Create: `video_grabber/db/migrations/versions/004_normalize_jobs.py`

**Interfaces:**
- Produces: table `normalize_jobs` (columns below) + enum `normalize_stage` (`pending`, `analyzing`, `analyzed`, `skipped`, `normalizing`, `done`, `failed`) — every later task's SQL targets these exact names.

- [ ] **Step 1: Write the migration** (mirror `003_transcribe_jobs.py`):

```python
"""normalize_jobs state table

Revision ID: 004
Revises: 003
Create Date: 2026-07-19

One row per audio/ MP3, tracked through pending → analyzing → analyzed|skipped
→ normalizing → done/failed. Mirrors transcribe_jobs. input_i/input_tp/input_lra
are the analyze stage's loudness report (queryable); probe holds ffprobe encode
params; archive_key is set once the original is safely in audio-original/.
'skipped' (already within tolerance) is terminal and distinct from 'done' so
re-tuned tolerances only ever reconsider files that never took a lossy re-encode.
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "004"
down_revision: Union[str, None] = "003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        DO $$ BEGIN
            CREATE TYPE normalize_stage AS ENUM (
                'pending', 'analyzing', 'analyzed', 'skipped',
                'normalizing', 'done', 'failed'
            );
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;
    """)

    op.create_table(
        "normalize_jobs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("source_key", sa.Text(), nullable=False, unique=True),
        sa.Column("stage", postgresql.ENUM(name="normalize_stage", create_type=False),
                  server_default="pending"),
        sa.Column("input_i", sa.Numeric()),     # integrated loudness, LUFS
        sa.Column("input_tp", sa.Numeric()),    # true peak, dBTP
        sa.Column("input_lra", sa.Numeric()),   # loudness range, LU
        sa.Column("probe", postgresql.JSONB()), # {bit_rate, sample_rate, channels, duration}
        sa.Column("archive_key", sa.Text()),    # audio-original/<name>.mp3 once archived
        sa.Column("error_message", sa.Text()),
        sa.Column("retry_count", sa.Integer(), server_default="0"),
        sa.Column("last_transition_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
    )
    op.create_index("idx_normalize_jobs_stage", "normalize_jobs", ["stage"])


def downgrade() -> None:
    op.drop_index("idx_normalize_jobs_stage", table_name="normalize_jobs")
    op.drop_table("normalize_jobs")
    op.execute("DROP TYPE IF EXISTS normalize_stage")
```

- [ ] **Step 2: Verify**

Run: `pytest tests/test_migrations.py -v` — expect PASS with a live Postgres, or the documented environment ERROR without one (not a failure).
Run: `ruff check video_grabber/` — expect clean.

- [ ] **Step 3: Commit**

```bash
git add video_grabber/db/migrations/versions/004_normalize_jobs.py
git commit -m "feat(normalize): migration 004 — normalize_jobs state table"
```

---

### Task 2: Config fields

**Files:**
- Modify: `video_grabber/config.py`
- Test: `tests/test_config.py` (append)

**Interfaces:**
- Produces: `Config.norm_target_i: float`, `Config.norm_target_tp: float`, `Config.norm_tolerance_lu: float`, `Config.cf_api_token: str`, `Config.cf_zone_id: str`.

- [ ] **Step 1: Write failing tests** (append to `tests/test_config.py`):

```python
def test_normalize_defaults():
    cfg = Config()
    assert cfg.norm_target_i == -16.0
    assert cfg.norm_target_tp == -1.5
    assert cfg.norm_tolerance_lu == 1.0
    assert cfg.cf_api_token == ""
    assert cfg.cf_zone_id == ""


def test_normalize_env_overrides(monkeypatch):
    monkeypatch.setenv("NORM_TARGET_I", "-18")
    monkeypatch.setenv("NORM_TOLERANCE_LU", "0.5")
    cfg = Config()
    assert cfg.norm_target_i == -18.0
    assert cfg.norm_tolerance_lu == 0.5
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_config.py -v` — expect the two new tests FAIL with `AttributeError: 'Config' object has no attribute 'norm_target_i'`.

- [ ] **Step 3: Implement** — in `video_grabber/config.py`, add a float helper next to `_int` and a new section before `usenet_collection_list`:

```python
def _float(key: str, default: float) -> float:
    return float(os.getenv(key, str(default)))
```

```python
    # --- Audio loudness normalization (normalize/ pipeline) ---
    # EBU R128 targets for the dynaudnorm+loudnorm chain; tolerance is the
    # analyze stage's "already fine, skip" band around norm_target_i.
    norm_target_i: float = field(default_factory=lambda: _float("NORM_TARGET_I", -16.0))
    norm_target_tp: float = field(default_factory=lambda: _float("NORM_TARGET_TP", -1.5))
    norm_tolerance_lu: float = field(default_factory=lambda: _float("NORM_TOLERANCE_LU", 1.0))
    # Cloudflare purge (best-effort) after in-place overwrite of audio/ objects.
    cf_api_token: str = field(default_factory=lambda: os.getenv("CF_API_TOKEN", ""))
    cf_zone_id: str = field(default_factory=lambda: os.getenv("CF_ZONE_ID", ""))
```

- [ ] **Step 4: Verify**

Run: `pytest tests/test_config.py -v` — expect PASS. `ruff check video_grabber/ tests/` — clean.

- [ ] **Step 5: Commit**

```bash
git add video_grabber/config.py tests/test_config.py
git commit -m "feat(normalize): config seams for loudness targets + CF purge"
```

---

### Task 3: Pure decision/parsing logic — `normalize/analysis.py`

**Files:**
- Create: `video_grabber/normalize/__init__.py` (empty)
- Create: `video_grabber/normalize/analysis.py`
- Test: `tests/test_normalize_analysis.py`

**Interfaces:**
- Produces:
  - `parse_loudnorm_json(stderr: str) -> dict` — parsed loudnorm JSON (string values, e.g. `{"input_i": "-27.61", ...}`); raises `ValueError` if absent.
  - `needs_normalization(input_i: float, input_tp: float, cfg: Config) -> bool`
  - `encode_args(probe: dict) -> list[str]` — ffmpeg output args from `{"bit_rate": int, "sample_rate": int, "channels": int}`.
  - `archive_key_for(source_key: str) -> str` — `audio/x.mp3` → `audio-original/x.mp3`.

- [ ] **Step 1: Write failing tests** (`tests/test_normalize_analysis.py`):

```python
import pytest

from video_grabber.config import Config
from video_grabber.normalize.analysis import (
    archive_key_for,
    encode_args,
    needs_normalization,
    parse_loudnorm_json,
)

# Realistic ffmpeg stderr: progress noise, filter banner, then the JSON block.
FFMPEG_STDERR = """\
size=N/A time=00:12:31.05 bitrate=N/A speed= 214x
video:0KiB audio:70411KiB subtitle:0KiB other streams:0KiB global headers:0KiB
[Parsed_loudnorm_1 @ 0x55d1c3a4b2c0]
{
    "input_i" : "-27.61",
    "input_tp" : "-4.47",
    "input_lra" : "18.06",
    "input_thresh" : "-39.20",
    "output_i" : "-16.58",
    "output_tp" : "-2.22",
    "output_lra" : "14.78",
    "output_thresh" : "-27.71",
    "normalization_type" : "dynamic",
    "target_offset" : "0.58"
}
"""


def test_parse_loudnorm_json_extracts_trailing_block():
    d = parse_loudnorm_json(FFMPEG_STDERR)
    assert d["input_i"] == "-27.61"
    assert d["target_offset"] == "0.58"


def test_parse_loudnorm_json_takes_last_block_when_multiple():
    two = FFMPEG_STDERR + FFMPEG_STDERR.replace('"-27.61"', '"-20.00"')
    assert parse_loudnorm_json(two)["input_i"] == "-20.00"


def test_parse_loudnorm_json_raises_without_block():
    with pytest.raises(ValueError):
        parse_loudnorm_json("frame= 100 fps=25 ...\n")


def test_needs_normalization_boundaries():
    cfg = Config()  # I=-16, TP=-1.5, tol=1.0
    assert needs_normalization(-27.6, -4.5, cfg) is True    # far too quiet
    assert needs_normalization(-16.0, -2.0, cfg) is False   # on target
    assert needs_normalization(-17.0, -2.0, cfg) is False   # exactly at tolerance edge
    assert needs_normalization(-17.01, -2.0, cfg) is True   # just outside
    assert needs_normalization(-16.0, -1.4, cfg) is True    # loudness fine, peak too hot


def test_encode_args_floors_bitrate_and_matches_source():
    args = encode_args({"bit_rate": 64000, "sample_rate": 22050, "channels": 1})
    assert args == ["-ar", "22050", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k"]
    args = encode_args({"bit_rate": 192000, "sample_rate": 44100, "channels": 2})
    assert args[-1] == "192k"


def test_archive_key_for():
    assert archive_key_for("audio/wnyc-am.mp3") == "audio-original/wnyc-am.mp3"
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_normalize_analysis.py -v` — expect FAIL with `ModuleNotFoundError: video_grabber.normalize`.

- [ ] **Step 3: Implement** (`video_grabber/normalize/analysis.py`):

```python
"""Pure decision + parsing logic for the loudness-normalization pipeline.

Break-glass restore (run in the worker pod's python) — copies every archived
original back over its audio/ key; then re-purge Cloudflare and
`kubectl -n file-proxy rollout restart deploy/file-proxy`:

    from video_grabber.config import Config
    from video_grabber.storage.wasabi import _make_s3_client, list_keys
    cfg = Config(); s3 = _make_s3_client(cfg)
    for k in list_keys("audio-original/", cfg):
        dest = "audio/" + k.removeprefix("audio-original/")
        s3.copy_object(Bucket=cfg.wasabi_bucket, Key=dest,
                       CopySource={"Bucket": cfg.wasabi_bucket, "Key": k},
                       MetadataDirective="COPY")
"""
import json
import re

from video_grabber.config import Config

# loudnorm's print_format=json block on stderr: a flat {...} containing
# "input_i". Take the LAST match — a retried/two-input run may print several.
_LOUDNORM_JSON = re.compile(r"\{[^{}]*\"input_i\"[^{}]*\}", re.S)

_MIN_BITRATE_KBPS = 128


def parse_loudnorm_json(stderr: str) -> dict:
    """Extract loudnorm's JSON measurement block from ffmpeg stderr."""
    matches = _LOUDNORM_JSON.findall(stderr)
    if not matches:
        raise ValueError("no loudnorm JSON block found in ffmpeg stderr")
    return json.loads(matches[-1])


def needs_normalization(input_i: float, input_tp: float, cfg: Config) -> bool:
    """Skip rule: within ±tolerance of the loudness target AND peak not above
    the true-peak ceiling → already fine (False)."""
    if abs(input_i - cfg.norm_target_i) > cfg.norm_tolerance_lu:
        return True
    return input_tp > cfg.norm_target_tp


def encode_args(probe: dict) -> list[str]:
    """ffmpeg output args matching the source's params, bitrate floored at 128k CBR."""
    kbps = max(int(probe["bit_rate"]) // 1000, _MIN_BITRATE_KBPS)
    return [
        "-ar", str(int(probe["sample_rate"])),
        "-ac", str(int(probe["channels"])),
        "-c:a", "libmp3lame",
        "-b:a", f"{kbps}k",
    ]


def archive_key_for(source_key: str) -> str:
    return "audio-original/" + source_key.removeprefix("audio/")
```

- [ ] **Step 4: Verify**

Run: `pytest tests/test_normalize_analysis.py -v` — PASS. `ruff check video_grabber/ tests/` — clean.

- [ ] **Step 5: Commit**

```bash
git add video_grabber/normalize/ tests/test_normalize_analysis.py
git commit -m "feat(normalize): loudnorm JSON parsing + skip/encode/archive decisions"
```

---

### Task 4: ffmpeg wrappers — `normalize/ffmpeg.py`

**Files:**
- Create: `video_grabber/normalize/ffmpeg.py`
- Test: `tests/test_normalize_ffmpeg.py`

**Interfaces:**
- Consumes: `parse_loudnorm_json`, `encode_args` from Task 3.
- Produces:
  - `probe(path: Path) -> dict` — `{"bit_rate": int, "sample_rate": int, "channels": int, "duration": float}`.
  - `measure(path: Path, cfg: Config, *, with_dynaudnorm: bool) -> dict` — parsed loudnorm JSON. `with_dynaudnorm=False` = analyze stage (raw-file report); `True` = normalize pass 1 (through the render chain).
  - `render(src: Path, dest: Path, measured: dict, probe_info: dict, cfg: Config) -> Path` — pass-2 linear render.

- [ ] **Step 1: Write failing tests** (`tests/test_normalize_ffmpeg.py`) — mock `subprocess.run`; assert on the exact command lines:

```python
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

import video_grabber.normalize.ffmpeg as nf
from video_grabber.config import Config

FFPROBE_JSON = """\
{"streams": [{"codec_type": "audio", "sample_rate": "22050", "channels": 1}],
 "format": {"duration": "751.05", "bit_rate": "64000"}}
"""

MEASURED = {
    "input_i": "-27.61", "input_tp": "-4.47", "input_lra": "18.06",
    "input_thresh": "-39.20", "target_offset": "0.58",
}

LOUDNORM_STDERR = (
    "noise\n[Parsed_loudnorm_1 @ 0x1]\n"
    '{ "input_i" : "-27.61", "input_tp" : "-4.47", "input_lra" : "18.06",\n'
    '  "input_thresh" : "-39.20", "output_i" : "-16.0", "output_tp" : "-2.0",\n'
    '  "output_lra" : "11.0", "output_thresh" : "-27.0",\n'
    '  "normalization_type" : "dynamic", "target_offset" : "0.58" }\n'
)


def fake_run(capture):
    def _run(cmd, **kw):
        capture.append(cmd)
        out = FFPROBE_JSON if cmd[0] == "ffprobe" else ""
        return SimpleNamespace(returncode=0, stdout=out, stderr=LOUDNORM_STDERR)
    return _run


def test_probe_parses_ffprobe_json(monkeypatch):
    calls = []
    monkeypatch.setattr(subprocess, "run", fake_run(calls))
    info = nf.probe(Path("/tmp/x.mp3"))
    assert info == {"bit_rate": 64000, "sample_rate": 22050, "channels": 1, "duration": 751.05}
    assert calls[0][0] == "ffprobe"


def test_measure_analyze_omits_dynaudnorm(monkeypatch):
    calls = []
    monkeypatch.setattr(subprocess, "run", fake_run(calls))
    d = nf.measure(Path("/tmp/x.mp3"), Config(), with_dynaudnorm=False)
    af = calls[0][calls[0].index("-af") + 1]
    assert af.startswith("loudnorm=")
    assert "dynaudnorm" not in af
    assert "print_format=json" in af
    assert d["input_i"] == "-27.61"


def test_measure_chain_includes_dynaudnorm_first(monkeypatch):
    calls = []
    monkeypatch.setattr(subprocess, "run", fake_run(calls))
    nf.measure(Path("/tmp/x.mp3"), Config(), with_dynaudnorm=True)
    af = calls[0][calls[0].index("-af") + 1]
    assert af.startswith("dynaudnorm,loudnorm=")


def test_render_uses_measured_values_linear_and_source_params(monkeypatch):
    calls = []
    monkeypatch.setattr(subprocess, "run", fake_run(calls))
    out = nf.render(Path("/tmp/x.mp3"), Path("/tmp/out.mp3"), MEASURED,
                    {"bit_rate": 64000, "sample_rate": 22050, "channels": 1}, Config())
    cmd = calls[0]
    af = cmd[cmd.index("-af") + 1]
    assert "measured_I=-27.61" in af and "measured_TP=-4.47" in af
    assert "measured_LRA=18.06" in af and "measured_thresh=-39.20" in af
    assert "offset=0.58" in af and "linear=true" in af
    assert af.startswith("dynaudnorm,loudnorm=")
    assert cmd[cmd.index("-b:a") + 1] == "128k"     # 64k floored
    assert cmd[cmd.index("-ar") + 1] == "22050"
    assert out == Path("/tmp/out.mp3")


def test_measure_raises_on_ffmpeg_failure(monkeypatch):
    def _run(cmd, **kw):
        return SimpleNamespace(returncode=1, stdout="", stderr="boom")
    monkeypatch.setattr(subprocess, "run", _run)
    with pytest.raises(RuntimeError):
        nf.measure(Path("/tmp/x.mp3"), Config(), with_dynaudnorm=False)
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_normalize_ffmpeg.py -v` — FAIL with `ModuleNotFoundError` / `AttributeError`.

- [ ] **Step 3: Implement** (`video_grabber/normalize/ffmpeg.py`):

```python
"""ffmpeg/ffprobe subprocess wrappers for loudness normalization.

Two-pass loudnorm: pass 1 measures THROUGH the same dynaudnorm,loudnorm chain
pass 2 renders with (dynaudnorm changes loudness before loudnorm sees it, so
the analyze stage's raw-file numbers can't seed pass 2). Pass 2 uses
linear=true — one constant gain from the measurement, no second layer of
dynamic compression on top of dynaudnorm.
"""
import json
import subprocess
from pathlib import Path

from video_grabber.config import Config
from video_grabber.normalize.analysis import encode_args, parse_loudnorm_json


def _loudnorm_targets(cfg: Config) -> str:
    return f"I={cfg.norm_target_i:g}:TP={cfg.norm_target_tp:g}:LRA=11"


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed ({res.returncode}): {res.stderr[-2000:]}")
    return res


def probe(path: Path) -> dict:
    """Source encode params via ffprobe."""
    res = _run([
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ])
    data = json.loads(res.stdout)
    stream = next(s for s in data["streams"] if s.get("codec_type") == "audio")
    return {
        "bit_rate": int(data["format"]["bit_rate"]),
        "sample_rate": int(stream["sample_rate"]),
        "channels": int(stream["channels"]),
        "duration": float(data["format"]["duration"]),
    }


def measure(path: Path, cfg: Config, *, with_dynaudnorm: bool) -> dict:
    """Measurement pass → parsed loudnorm JSON (values are strings)."""
    chain = ("dynaudnorm," if with_dynaudnorm else "") + \
        f"loudnorm={_loudnorm_targets(cfg)}:print_format=json"
    res = _run([
        "ffmpeg", "-hide_banner", "-nostdin", "-i", str(path),
        "-af", chain, "-f", "null", "-",
    ])
    return parse_loudnorm_json(res.stderr)


def render(src: Path, dest: Path, measured: dict, probe_info: dict, cfg: Config) -> Path:
    """Pass-2 linear render matching the source's encode params."""
    chain = (
        f"dynaudnorm,loudnorm={_loudnorm_targets(cfg)}"
        f":measured_I={measured['input_i']}:measured_TP={measured['input_tp']}"
        f":measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}"
        f":offset={measured['target_offset']}:linear=true"
    )
    dest.parent.mkdir(parents=True, exist_ok=True)
    _run([
        "ffmpeg", "-hide_banner", "-nostdin", "-y", "-i", str(src),
        "-af", chain, *encode_args(probe_info), str(dest),
    ])
    return dest
```

- [ ] **Step 4: Verify**

Run: `pytest tests/test_normalize_ffmpeg.py -v` — PASS. `ruff check video_grabber/ tests/` — clean.

- [ ] **Step 5: Commit**

```bash
git add video_grabber/normalize/ffmpeg.py tests/test_normalize_ffmpeg.py
git commit -m "feat(normalize): ffprobe/two-pass loudnorm subprocess wrappers"
```

---

### Task 5: Wasabi primitives — head / archive-if-absent / download / mp3 upload

**Files:**
- Modify: `video_grabber/storage/wasabi.py` (append)
- Test: `tests/test_normalize_wasabi.py`

**Interfaces:**
- Produces (all take `cfg` and optional `s3=` like the existing functions):
  - `head_object(key, cfg, *, s3=None) -> dict | None` — `None` on 404.
  - `copy_object_if_absent(src_key, dest_key, cfg, *, s3=None) -> bool` — server-side copy; **no-op returning False if dest exists**; True if copied.
  - `download_file(key, dest: Path, cfg, *, s3=None) -> Path`
  - `upload_mp3(path: Path, key, cfg, *, cache_control: str, s3=None) -> None` — `ContentType: audio/mpeg` + given `Cache-Control`.

- [ ] **Step 1: Write failing tests** (`tests/test_normalize_wasabi.py`, moto like `tests/test_uploader.py`):

```python
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

from video_grabber.config import Config
from video_grabber.storage import wasabi

BUCKET = "test-bucket"


@pytest.fixture
def cfg(monkeypatch):
    monkeypatch.setenv("WASABI_BUCKET", BUCKET)
    monkeypatch.setenv("WASABI_ACCESS_KEY_ID", "test")
    monkeypatch.setenv("WASABI_SECRET_ACCESS_KEY", "test")
    return Config()


@pytest.fixture
def s3():
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket=BUCKET)
        yield client


def test_head_object_returns_none_for_missing(cfg, s3):
    assert wasabi.head_object("audio/nope.mp3", cfg, s3=s3) is None


def test_head_object_returns_metadata(cfg, s3):
    s3.put_object(Bucket=BUCKET, Key="audio/a.mp3", Body=b"x",
                  CacheControl="max-age=31536000")
    head = wasabi.head_object("audio/a.mp3", cfg, s3=s3)
    assert head["CacheControl"] == "max-age=31536000"


def test_copy_object_if_absent_copies_once(cfg, s3):
    s3.put_object(Bucket=BUCKET, Key="audio/a.mp3", Body=b"original")
    assert wasabi.copy_object_if_absent("audio/a.mp3", "audio-original/a.mp3", cfg, s3=s3) is True
    # Overwrite audio/ (simulating normalization), then retry the archive:
    s3.put_object(Bucket=BUCKET, Key="audio/a.mp3", Body=b"normalized")
    assert wasabi.copy_object_if_absent("audio/a.mp3", "audio-original/a.mp3", cfg, s3=s3) is False
    body = s3.get_object(Bucket=BUCKET, Key="audio-original/a.mp3")["Body"].read()
    assert body == b"original"      # first write won


def test_download_file_roundtrip(cfg, s3, tmp_path):
    s3.put_object(Bucket=BUCKET, Key="audio/a.mp3", Body=b"bytes")
    dest = wasabi.download_file("audio/a.mp3", tmp_path / "a.mp3", cfg, s3=s3)
    assert dest.read_bytes() == b"bytes"


def test_upload_mp3_sets_content_type_and_cache_control(cfg, s3, tmp_path):
    f = tmp_path / "a.mp3"
    f.write_bytes(b"mp3")
    wasabi.upload_mp3(f, "audio/a.mp3", cfg, cache_control="max-age=31536000", s3=s3)
    head = s3.head_object(Bucket=BUCKET, Key="audio/a.mp3")
    assert head["ContentType"] == "audio/mpeg"
    assert head["CacheControl"] == "max-age=31536000"
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_normalize_wasabi.py -v` — FAIL with `AttributeError: module ... has no attribute 'head_object'`.

- [ ] **Step 3: Implement** — append to `video_grabber/storage/wasabi.py`:

```python
def head_object(key: str, cfg: Config, *, s3=None) -> dict | None:
    """HEAD an object; None if it doesn't exist."""
    s3 = s3 or _make_s3_client(cfg)
    try:
        return s3.head_object(Bucket=cfg.wasabi_bucket, Key=key)
    except s3.exceptions.ClientError as exc:
        if exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode") == 404:
            return None
        raise


def copy_object_if_absent(src_key: str, dest_key: str, cfg: Config, *, s3=None) -> bool:
    """Server-side copy src→dest unless dest already exists (first write wins).

    Used to archive audio/ originals: on a retried normalize job the audio/
    object may already be normalized, so an existing archive must NEVER be
    overwritten — it is the only true original. Returns True iff copied."""
    s3 = s3 or _make_s3_client(cfg)
    if head_object(dest_key, cfg, s3=s3) is not None:
        return False
    s3.copy_object(
        Bucket=cfg.wasabi_bucket,
        Key=dest_key,
        CopySource={"Bucket": cfg.wasabi_bucket, "Key": src_key},
        MetadataDirective="COPY",
    )
    return True


def download_file(key: str, dest: Path, cfg: Config, *, s3=None) -> Path:
    s3 = s3 or _make_s3_client(cfg)
    dest.parent.mkdir(parents=True, exist_ok=True)
    s3.download_file(cfg.wasabi_bucket, key, str(dest))
    return dest


def upload_mp3(path: Path, key: str, cfg: Config, *, cache_control: str, s3=None) -> None:
    """Upload one MP3 with explicit audio/mpeg + caller-preserved Cache-Control."""
    s3 = s3 or _make_s3_client(cfg)
    s3.upload_file(
        str(path),
        cfg.wasabi_bucket,
        key,
        Config=_TRANSFER_CONFIG,
        ExtraArgs={"ContentType": "audio/mpeg", "CacheControl": cache_control},
    )
```

- [ ] **Step 4: Verify**

Run: `pytest tests/test_normalize_wasabi.py tests/test_uploader.py -v` — PASS (existing uploader tests must stay green). `ruff check video_grabber/ tests/` — clean.

- [ ] **Step 5: Commit**

```bash
git add video_grabber/storage/wasabi.py tests/test_normalize_wasabi.py
git commit -m "feat(normalize): wasabi head/archive-if-absent/download/mp3-upload primitives"
```

---

### Task 6: Cloudflare purge — `normalize/purge.py`

**Files:**
- Create: `video_grabber/normalize/purge.py`
- Test: `tests/test_normalize_purge.py`

**Interfaces:**
- Produces: `purge_urls(urls: list[str], cfg: Config, logger) -> bool` — best-effort; True on success, False (after a warning log) on any failure or missing credentials. Never raises.

- [ ] **Step 1: Write failing tests** (`tests/test_normalize_purge.py`, respx like `tests/test_directus_writer.py`):

```python
import logging

import respx
from httpx import Response

from video_grabber.config import Config
from video_grabber.normalize.purge import purge_urls


def _cfg(monkeypatch):
    monkeypatch.setenv("CF_API_TOKEN", "tok")
    monkeypatch.setenv("CF_ZONE_ID", "zone1")
    return Config()


@respx.mock
def test_purge_posts_urls(monkeypatch):
    cfg = _cfg(monkeypatch)
    route = respx.post("https://api.cloudflare.com/client/v4/zones/zone1/purge_cache").mock(
        return_value=Response(200, json={"success": True})
    )
    assert purge_urls(["https://files.911realtime.org/audio/a.mp3"], cfg,
                      logging.getLogger("t")) is True
    body = route.calls[0].request.content
    assert b"audio/a.mp3" in body
    assert route.calls[0].request.headers["authorization"] == "Bearer tok"


@respx.mock
def test_purge_failure_is_swallowed(monkeypatch, caplog):
    cfg = _cfg(monkeypatch)
    respx.post("https://api.cloudflare.com/client/v4/zones/zone1/purge_cache").mock(
        return_value=Response(500, json={"success": False})
    )
    with caplog.at_level(logging.WARNING):
        assert purge_urls(["https://x/a.mp3"], cfg, logging.getLogger("t")) is False
    assert "purge" in caplog.text.lower()


def test_purge_without_credentials_warns_and_skips(monkeypatch, caplog):
    monkeypatch.delenv("CF_API_TOKEN", raising=False)
    monkeypatch.delenv("CF_ZONE_ID", raising=False)
    with caplog.at_level(logging.WARNING):
        assert purge_urls(["https://x/a.mp3"], Config(), logging.getLogger("t")) is False
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_normalize_purge.py -v` — FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement** (`video_grabber/normalize/purge.py`):

```python
"""Best-effort Cloudflare cache purge after in-place audio/ overwrites.

audio/ objects carry a long immutable Cache-Control, so without a purge CF
keeps serving pre-normalization bytes indefinitely. Purge failure must never
fail the job — origin bytes are already correct; we log and move on. The
nginx-s3-gateway (file-proxy) layer is handled operationally instead:
`kubectl -n file-proxy rollout restart deploy/file-proxy` after the batch.
"""
import httpx

from video_grabber.config import Config

_API = "https://api.cloudflare.com/client/v4/zones/{zone}/purge_cache"


def purge_urls(urls: list[str], cfg: Config, logger) -> bool:
    if not cfg.cf_api_token or not cfg.cf_zone_id:
        logger.warning("CF purge skipped: CF_API_TOKEN/CF_ZONE_ID not set (%d url(s))", len(urls))
        return False
    try:
        resp = httpx.post(
            _API.format(zone=cfg.cf_zone_id),
            headers={"Authorization": f"Bearer {cfg.cf_api_token}"},
            json={"files": urls},
            timeout=30,
        )
        if resp.status_code == 200 and resp.json().get("success"):
            return True
        logger.warning("CF purge failed: HTTP %d %s", resp.status_code, resp.text[:500])
        return False
    except httpx.HTTPError as exc:
        logger.warning("CF purge failed: %s", exc)
        return False
```

- [ ] **Step 4: Verify**

Run: `pytest tests/test_normalize_purge.py -v` — PASS. `ruff check video_grabber/ tests/` — clean.

- [ ] **Step 5: Commit**

```bash
git add video_grabber/normalize/purge.py tests/test_normalize_purge.py
git commit -m "feat(normalize): best-effort Cloudflare purge helper"
```

---

### Task 7: Flows — `normalize/flows.py`

**Files:**
- Create: `video_grabber/normalize/flows.py`
- Test: `tests/test_normalize_flows.py`

**Interfaces:**
- Consumes: Tasks 3-6 (`analysis`, `ffmpeg`, `wasabi` additions, `purge`), plus `_WASABI_BASE` from `video_grabber.directus.writer` and the `get_db`/`_sync_db_url` idiom from `transcribe/flows.py` (re-implemented locally; do not import transcribe's — the modules stay independent).
- Produces flows: `scan_normalize_flow`, `dispatch_analyze_normalize_flow`, `analyze_normalize_item_flow(job_id)`, `dispatch_normalize_flow`, `normalize_item_flow(job_id)` — deployment names in Task 8.

- [ ] **Step 1: Write failing tests** (`tests/test_normalize_flows.py`). Test the two per-item flows' logic with monkeypatched I/O; run flows as plain functions via `.fn()`:

```python
from pathlib import Path
from types import SimpleNamespace

import video_grabber.normalize.flows as flows

MEASURED = {
    "input_i": "-27.61", "input_tp": "-4.47", "input_lra": "18.06",
    "input_thresh": "-39.20", "target_offset": "0.58",
}
PROBE = {"bit_rate": 64000, "sample_rate": 22050, "channels": 1, "duration": 751.0}


def _patch_common(monkeypatch, job, transitions, calls):
    monkeypatch.setattr(flows, "get_normalize_job", lambda job_id: job)
    monkeypatch.setattr(
        flows, "transition_normalize_job",
        lambda job_id, to_stage, **kw: transitions.append((to_stage, kw)),
    )
    monkeypatch.setattr(flows, "get_run_logger", lambda: SimpleNamespace(
        info=lambda *a: None, warning=lambda *a: None))
    monkeypatch.setattr(flows.wasabi, "download_file",
                        lambda key, dest, cfg, **kw: calls.append(("download", key)) or dest)
    monkeypatch.setattr(flows.shutil, "rmtree", lambda *a, **kw: None)


def test_analyze_within_tolerance_marks_skipped(monkeypatch):
    transitions, calls = [], []
    job = SimpleNamespace(id="j1", source_key="audio/a.mp3")
    _patch_common(monkeypatch, job, transitions, calls)
    monkeypatch.setattr(flows.nf, "probe", lambda p: PROBE)
    monkeypatch.setattr(flows.nf, "measure", lambda p, cfg, with_dynaudnorm:
                        {**MEASURED, "input_i": "-16.2", "input_tp": "-2.0"})
    flows.analyze_normalize_item_flow.fn("j1")
    assert transitions[0][0] == "analyzing"
    assert transitions[-1][0] == "skipped"
    assert transitions[-1][1]["input_i"] == -16.2


def test_analyze_out_of_tolerance_marks_analyzed(monkeypatch):
    transitions, calls = [], []
    job = SimpleNamespace(id="j1", source_key="audio/a.mp3")
    _patch_common(monkeypatch, job, transitions, calls)
    monkeypatch.setattr(flows.nf, "probe", lambda p: PROBE)
    monkeypatch.setattr(flows.nf, "measure",
                        lambda p, cfg, with_dynaudnorm: MEASURED)
    flows.analyze_normalize_item_flow.fn("j1")
    assert transitions[-1][0] == "analyzed"
    assert transitions[-1][1]["probe"] == PROBE


def test_analyze_failure_records_failed_and_reraises(monkeypatch):
    transitions, calls = [], []
    job = SimpleNamespace(id="j1", source_key="audio/a.mp3")
    _patch_common(monkeypatch, job, transitions, calls)
    monkeypatch.setattr(flows.nf, "probe",
                        lambda p: (_ for _ in ()).throw(RuntimeError("ffprobe died")))
    try:
        flows.analyze_normalize_item_flow.fn("j1")
        raise AssertionError("should have raised")
    except RuntimeError:
        pass
    assert transitions[-1][0] == "failed"
    assert "ffprobe died" in transitions[-1][1]["error"]


def test_normalize_archives_first_and_reads_from_archive(monkeypatch):
    transitions, calls = [], []
    job = SimpleNamespace(id="j1", source_key="audio/a.mp3",
                          probe=PROBE, archive_key=None)
    _patch_common(monkeypatch, job, transitions, calls)
    monkeypatch.setattr(flows.wasabi, "copy_object_if_absent",
                        lambda src, dest, cfg, **kw: calls.append(("archive", src, dest)) or True)
    monkeypatch.setattr(flows.wasabi, "head_object",
                        lambda key, cfg, **kw: {"CacheControl": "max-age=99"})
    monkeypatch.setattr(flows.wasabi, "upload_mp3",
                        lambda path, key, cfg, *, cache_control, **kw:
                        calls.append(("upload", key, cache_control)))
    monkeypatch.setattr(flows.nf, "measure", lambda p, cfg, with_dynaudnorm: MEASURED)
    monkeypatch.setattr(flows.nf, "render",
                        lambda src, dest, m, pi, cfg: calls.append(("render",)) or dest)
    monkeypatch.setattr(flows, "purge_urls",
                        lambda urls, cfg, logger: calls.append(("purge", tuple(urls))) or True)
    flows.normalize_item_flow.fn("j1")
    names = [c[0] for c in calls]
    # archive strictly before any download/upload; upload before purge
    assert names.index("archive") < names.index("download")
    assert names.index("upload") < names.index("purge")
    dl = next(c for c in calls if c[0] == "download")
    assert dl[1] == "audio-original/a.mp3"          # input comes from the archive
    up = next(c for c in calls if c[0] == "upload")
    assert up[1] == "audio/a.mp3" and up[2] == "max-age=99"
    assert transitions[-1][0] == "done"
    assert transitions[0] == ("normalizing", {})


def test_scan_inserts_only_mp3_keys(monkeypatch):
    executed = []

    class FakeDB:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def execute(self, stmt, params=None):
            executed.append(params)
            return SimpleNamespace(rowcount=1)
        def commit(self): pass

    monkeypatch.setattr(flows, "get_db", lambda: FakeDB())
    monkeypatch.setattr(flows, "get_run_logger", lambda: SimpleNamespace(
        info=lambda *a: None, warning=lambda *a: None))
    monkeypatch.setattr(flows.wasabi, "list_keys",
                        lambda prefix, cfg: ["audio/a.mp3", "audio/readme.txt", "audio/b.MP3"])
    flows.scan_normalize_flow.fn()
    keys = [p["sk"] for p in executed if p]
    assert keys == ["audio/a.mp3", "audio/b.MP3"]
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_normalize_flows.py -v` — FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement** (`video_grabber/normalize/flows.py`):

```python
"""Prefect flows for the audio loudness-normalization pipeline.

Mirrors the transcribe pipeline's scan → dispatch → per-item shape over
normalize_jobs:

- scan-normalize             enumerate audio/*.mp3 into pending rows
- dispatch-analyze-normalize drain pending (+ failed-in-analysis) via blocking runs
- analyze-normalize-item     ffprobe + raw loudnorm measurement → analyzed|skipped
- dispatch-normalize         drain analyzed (+ failed-in-normalize). MANUAL ONLY —
                             the analyze→normalize gap is the operator review gate;
                             never give this deployment a schedule.
- normalize-item             archive-first in-place normalization (see below)

Failed rows are disambiguated by input_i: NULL → failed in analysis,
NOT NULL → failed in normalization. See plans/2026-07-19-audio-normalize-design.md.
"""
import os
import shutil
from pathlib import Path
from types import SimpleNamespace

import sqlalchemy as sa
from prefect import flow, get_run_logger
from prefect.deployments import run_deployment

import video_grabber.normalize.ffmpeg as nf
from video_grabber.config import Config
from video_grabber.directus.writer import _WASABI_BASE
from video_grabber.normalize.analysis import archive_key_for, needs_normalization
from video_grabber.normalize.purge import purge_urls
from video_grabber.storage import wasabi

_SCRATCH = Path(os.getenv("SCRATCH_DIR", "/tmp/vg-scratch"))
_ASYNCPG_PREFIX = "postgresql+asyncpg://"
_PSYCOPG2_PREFIX = "postgresql+psycopg2://"
_DEFAULT_CACHE_CONTROL = "max-age=31536000"


def _sync_db_url(url: str) -> str:
    if url.startswith(_ASYNCPG_PREFIX):
        return _PSYCOPG2_PREFIX + url[len(_ASYNCPG_PREFIX):]
    return url


def get_db():
    cfg = Config()
    engine = sa.create_engine(_sync_db_url(cfg.database_url))
    return engine.connect()


def get_normalize_job(job_id: str):
    with get_db() as db:
        row = db.execute(
            sa.text("SELECT * FROM normalize_jobs WHERE id = :id"), {"id": job_id}
        ).mappings().fetchone()
        if row is None:
            raise ValueError(f"normalize_jobs row not found: {job_id}")
        return SimpleNamespace(**dict(row))


def transition_normalize_job(job_id, to_stage, *, error=None, input_i=None,
                             input_tp=None, input_lra=None, probe=None,
                             archive_key=None) -> None:
    """Move a normalize_jobs row to *to_stage* on a fresh, short-lived connection
    (idle_session_timeout=10min on this DB; same rationale as transcribe)."""
    import json as _json
    sets = ["stage = CAST(:stage AS normalize_stage)", "last_transition_at = now()"]
    params = {"stage": to_stage, "job_id": job_id}
    if error is not None:
        sets.append("error_message = :error")
        params["error"] = error
    else:
        sets.append("error_message = NULL")
    for col, val in (("input_i", input_i), ("input_tp", input_tp),
                     ("input_lra", input_lra), ("archive_key", archive_key)):
        if val is not None:
            sets.append(f"{col} = :{col}")
            params[col] = val
    if probe is not None:
        sets.append("probe = CAST(:probe AS jsonb)")
        params["probe"] = _json.dumps(probe)
    with get_db() as db:
        db.execute(sa.text(f"UPDATE normalize_jobs SET {', '.join(sets)} WHERE id = :job_id"), params)
        db.commit()


# ---- flows ----------------------------------------------------------------

@flow(name="scan-normalize")
def scan_normalize_flow() -> None:
    """Enumerate audio/*.mp3 into normalize_jobs. Idempotent (source_key UNIQUE)."""
    logger = get_run_logger()
    cfg = Config()
    keys = [k for k in wasabi.list_keys("audio/", cfg) if k.lower().endswith(".mp3")]
    n = 0
    with get_db() as db:
        for key in keys:
            res = db.execute(sa.text("""
                INSERT INTO normalize_jobs (source_key, stage)
                VALUES (:sk, 'pending')
                ON CONFLICT (source_key) DO NOTHING
            """), {"sk": key})
            n += res.rowcount or 0
        db.commit()
    logger.info("scan-normalize: %d audio keys, +%d new jobs", len(keys), n)


@flow(name="analyze-normalize-item", retries=1, retry_delay_seconds=60)
def analyze_normalize_item_flow(job_id: str) -> None:
    """Measure one file's raw loudness into the report columns; decide skip/analyzed."""
    logger = get_run_logger()
    cfg = Config()
    job = get_normalize_job(job_id)
    scratch = _SCRATCH / "normalize" / str(job.id)
    try:
        transition_normalize_job(job_id, "analyzing")
        src = wasabi.download_file(job.source_key, scratch / "in.mp3", cfg)
        probe_info = nf.probe(src)
        measured = nf.measure(src, cfg, with_dynaudnorm=False)
        input_i = float(measured["input_i"])
        input_tp = float(measured["input_tp"])
        input_lra = float(measured["input_lra"])
        stage = "analyzed" if needs_normalization(input_i, input_tp, cfg) else "skipped"
        transition_normalize_job(job_id, stage, input_i=input_i, input_tp=input_tp,
                                 input_lra=input_lra, probe=probe_info)
        logger.info("analyze-normalize-item: %s I=%.1f TP=%.1f LRA=%.1f → %s",
                    job.source_key, input_i, input_tp, input_lra, stage)
    except Exception as exc:  # noqa: BLE001 — record failure then re-raise for retry
        transition_normalize_job(job_id, "failed", error=str(exc)[:2000])
        raise
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


@flow(name="normalize-item", retries=1, retry_delay_seconds=60)
def normalize_item_flow(job_id: str) -> None:
    """Normalize one analyzed file in place, archive-first.

    Order is load-bearing:
      1. copy_object_if_absent → audio-original/ (first write wins FOREVER — on a
         retry the audio/ object may already be normalized; the archive is the
         only true original and must never be overwritten)
      2. download FROM THE ARCHIVE key (guaranteed original → idempotent re-runs)
      3. two-pass dynaudnorm+loudnorm render matching source encode params
      4. upload over audio/ preserving prior Cache-Control
      5. best-effort Cloudflare purge
    """
    logger = get_run_logger()
    cfg = Config()
    job = get_normalize_job(job_id)
    scratch = _SCRATCH / "normalize" / str(job.id)
    try:
        transition_normalize_job(job_id, "normalizing")
        arch_key = archive_key_for(job.source_key)
        wasabi.copy_object_if_absent(job.source_key, arch_key, cfg)

        head = wasabi.head_object(job.source_key, cfg) or {}
        cache_control = head.get("CacheControl") or _DEFAULT_CACHE_CONTROL

        src = wasabi.download_file(arch_key, scratch / "in.mp3", cfg)
        measured = nf.measure(src, cfg, with_dynaudnorm=True)
        out = nf.render(src, scratch / "out.mp3", measured, job.probe, cfg)
        wasabi.upload_mp3(out, job.source_key, cfg, cache_control=cache_control)
        purge_urls([f"{_WASABI_BASE}/{job.source_key}"], cfg, logger)

        transition_normalize_job(job_id, "done", archive_key=arch_key)
        logger.info("normalize-item: %s normalized in place (original → %s)",
                    job.source_key, arch_key)
    except Exception as exc:  # noqa: BLE001 — record failure then re-raise for retry
        transition_normalize_job(job_id, "failed", error=str(exc)[:2000])
        raise
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def _dispatch(logger, *, claim_sql: str, deployment: str, label: str,
              max_runs: int, max_retries: int) -> None:
    """Shared atomic-claim drain loop (transcribe idiom: UPDATE…SELECT…SKIP LOCKED)."""
    processed = 0
    with get_db() as db:
        while processed < max_runs:
            row = db.execute(sa.text(claim_sql), {"max_retries": max_retries}).first()
            db.commit()
            if row is None:
                logger.info("%s: queue empty after %d runs", label, processed)
                return
            job_id = str(row.id)
            logger.info("%s: claimed + dispatching job_id=%s", label, job_id)
            run_deployment(name=deployment, parameters={"job_id": job_id})
            processed += 1
    logger.info("%s: hit max_runs=%d cap", label, max_runs)


@flow(name="dispatch-analyze-normalize")
def dispatch_analyze_normalize_flow(max_runs: int = 10000, max_retries: int = 3) -> None:
    """Drain pending analysis (+ failed-in-analysis: input_i IS NULL)."""
    _dispatch(
        get_run_logger(),
        claim_sql="""
            UPDATE normalize_jobs SET
                stage = 'analyzing',
                retry_count = retry_count + CASE WHEN stage = 'failed' THEN 1 ELSE 0 END,
                last_transition_at = now()
            WHERE id = (
                SELECT id FROM normalize_jobs
                WHERE stage = 'pending'
                   OR (stage = 'failed' AND input_i IS NULL AND retry_count < :max_retries)
                ORDER BY (stage = 'failed'), created_at
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            RETURNING id
        """,
        deployment="analyze-normalize-item/analyze-normalize-item",
        label="dispatch-analyze-normalize",
        max_runs=max_runs,
        max_retries=max_retries,
    )


@flow(name="dispatch-normalize")
def dispatch_normalize_flow(max_runs: int = 10000, max_retries: int = 3) -> None:
    """Drain analyzed (+ failed-in-normalize: input_i IS NOT NULL). MANUAL ONLY —
    triggering this flow is the operator's go-ahead to rewrite bytes."""
    _dispatch(
        get_run_logger(),
        claim_sql="""
            UPDATE normalize_jobs SET
                stage = 'normalizing',
                retry_count = retry_count + CASE WHEN stage = 'failed' THEN 1 ELSE 0 END,
                last_transition_at = now()
            WHERE id = (
                SELECT id FROM normalize_jobs
                WHERE stage = 'analyzed'
                   OR (stage = 'failed' AND input_i IS NOT NULL AND retry_count < :max_retries)
                ORDER BY (stage = 'failed'), created_at
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            RETURNING id
        """,
        deployment="normalize-item/normalize-item",
        label="dispatch-normalize",
        max_runs=max_runs,
        max_retries=max_retries,
    )
```

- [ ] **Step 4: Verify**

Run: `pytest tests/test_normalize_flows.py -v` — PASS. Then the full suite: `pytest tests/ -v` and `ruff check video_grabber/ tests/` — clean.

- [ ] **Step 5: Commit**

```bash
git add video_grabber/normalize/flows.py tests/test_normalize_flows.py
git commit -m "feat(normalize): scan/analyze/dispatch/normalize Prefect flows"
```

---

### Task 8: Register deployments in `serve.py`

**Files:**
- Modify: `video_grabber/serve.py`

**Interfaces:**
- Consumes: the five flows from Task 7.
- Produces deployment names (used by the dispatchers' `run_deployment` calls — must match exactly): `scan-normalize/scan-normalize`, `dispatch-analyze-normalize/dispatch-analyze-normalize`, `analyze-normalize-item/analyze-normalize-item`, `dispatch-normalize/dispatch-normalize`, `normalize-item/normalize-item`.

- [ ] **Step 1: Add imports + limits** — in `video_grabber/serve.py`, after the usenet import block:

```python
from video_grabber.normalize.flows import (
    analyze_normalize_item_flow,
    dispatch_analyze_normalize_flow,
    dispatch_normalize_flow,
    normalize_item_flow,
    scan_normalize_flow,
)
```

After `_THUMBNAIL_LIMIT`:

```python
# Loudness normalization: mp3 decode/encode is cheap next to the video encodes
# sharing this pod — 2 concurrent per-item flows, serial scan. Dispatchers are
# blocking (one item at a time each), so 2 keeps both item slots fed. NONE of
# these get a schedule; dispatch-normalize in particular is the operator's
# review gate — triggering it manually IS the go-ahead to rewrite audio/ bytes.
_NORMALIZE_SCAN_LIMIT = 1
_NORMALIZE_ITEM_LIMIT = 2
_NORMALIZE_DISPATCH_LIMIT = 2
```

- [ ] **Step 2: Register** — append inside the `serve(...)` call, after `batch_thumbnails_flow.to_deployment(...)`:

```python
        scan_normalize_flow.to_deployment(
            name="scan-normalize",
            concurrency_limit=_NORMALIZE_SCAN_LIMIT,
        ),
        dispatch_analyze_normalize_flow.to_deployment(
            name="dispatch-analyze-normalize",
            concurrency_limit=_NORMALIZE_DISPATCH_LIMIT,
        ),
        analyze_normalize_item_flow.to_deployment(
            name="analyze-normalize-item",
            concurrency_limit=_NORMALIZE_ITEM_LIMIT,
        ),
        # MANUAL ONLY — never add an interval/schedule here (destructive pass).
        dispatch_normalize_flow.to_deployment(
            name="dispatch-normalize",
            concurrency_limit=_NORMALIZE_DISPATCH_LIMIT,
        ),
        normalize_item_flow.to_deployment(
            name="normalize-item",
            concurrency_limit=_NORMALIZE_ITEM_LIMIT,
        ),
```

- [ ] **Step 3: Verify**

Run: `python -c "import video_grabber.serve"` — imports clean.
Run: `pytest tests/ -v` and `ruff check video_grabber/ tests/` — clean.

- [ ] **Step 4: Commit**

```bash
git add video_grabber/serve.py
git commit -m "feat(normalize): register normalization deployments in serve.py"
```

---

### Task 9: Docs — `docs/normalization.md` + CLAUDE.md layout entry

**Files:**
- Create: `packages/tools/video-grabber/docs/normalization.md`
- Modify: `packages/tools/video-grabber/CLAUDE.md` (Layout section, after the `transcribe/` bullet)

- [ ] **Step 1: Write `docs/normalization.md`** — condense the spec into an operator doc containing exactly: the flow table (5 flows + triggers), the stage diagram (`pending → analyzing → analyzed|skipped → normalizing → done|failed`), the failed-row discriminator (`input_i` NULL/NOT NULL), the archive-first/first-write-wins rule with the retry rationale, the review SQL (`SELECT stage, count(*), round(avg(input_i),1), min(input_i), max(input_i) FROM normalize_jobs GROUP BY stage;`), the runbook (scan → dispatch-analyze → review → dispatch-normalize → `kubectl -n file-proxy rollout restart deploy/file-proxy` → RadioScanner spot-check), the CF env vars (`CF_API_TOKEN`/`CF_ZONE_ID`), and the break-glass restore snippet (copy verbatim from `normalize/analysis.py`'s docstring). Link to `plans/2026-07-19-audio-normalize-design.md` for rationale.

- [ ] **Step 2: Add the CLAUDE.md layout bullet:**

```markdown
- `video_grabber/normalize/` — a **fourth pipeline**: measure loudness of every
  `audio/*.mp3` (report in `normalize_jobs`, migration `004`), then — via the
  manually-triggered `dispatch-normalize` only — normalize files in place
  (dynaudnorm + two-pass EBU R128 loudnorm), archiving originals to
  `audio-original/` first (first-write-wins). See [`docs/normalization.md`](docs/normalization.md).
```

- [ ] **Step 3: Verify + commit**

Run: `ruff check video_grabber/ tests/` — clean (docs don't affect it, sanity only).

```bash
git add docs/normalization.md CLAUDE.md
git commit -m "docs(normalize): operator doc + CLAUDE.md layout entry"
```

---

### Task 10: Infra repo — CF purge Secret/env + migrate-Job bump

**Files (separate repo, `/home/robbiebyrd/infra`):**
- Create: `apps/video-grabber/cf-purge-secret.yaml` (or add via existing secret mechanism — check how `WASABI_ACCESS_KEY_ID` is provided in `apps/video-grabber/worker.yaml` and follow that exact pattern)
- Modify: `apps/video-grabber/worker.yaml` (env), `apps/video-grabber/kustomization.yaml` (if a new file is added), `apps/video-grabber/migrate-job.yaml` (image SHA bump after the code lands)

- [ ] **Step 1: Inspect the existing secret pattern**

Run: `grep -n -A4 "WASABI_ACCESS_KEY_ID" /home/robbiebyrd/infra/apps/video-grabber/worker.yaml` — mirror exactly how that value is sourced (secretKeyRef name/key style).

- [ ] **Step 2: Add `CF_API_TOKEN` + `CF_ZONE_ID`** to the worker container env using that same pattern. The token needs only the `Zone → Cache Purge → Purge` permission for the `911realtime.org` zone; the user creates the token in the CF dashboard and provides it — **ask, don't guess**. If the token isn't available yet, ship without it: the purge helper degrades to a logged warning.

- [ ] **Step 3: After the video-grabber code lands on `main`** (Task 11), bump `apps/video-grabber/migrate-job.yaml` to the new image SHA so `alembic upgrade head` applies migration `004`, commit + push infra `main` (self-merge OK per repo convention), and verify:

```bash
kubectl -n argocd get application video-grabber -o jsonpath='{.status.sync.status} {.status.health.status}{"\n"}'
kubectl -n video-grabber get jobs   # migrate job completed
```

---

### Task 11: Ship + first run

- [ ] **Step 1: Push the branch, open a PR** against `main` with the full pipeline. CI must be green (`test` job: pytest + ruff). Note in the PR body that the image build runs only after merge (build job skips PRs).

- [ ] **Step 2: Merge; wait for GitOps** (image SHA bump commit in infra + ArgoCD sync), verify the worker image SHA per the video-grabber CLAUDE.md.

- [ ] **Step 3: Apply migration** (Task 10 Step 3), then from the Prefect UI: trigger `scan-normalize`, then `dispatch-analyze-normalize` (trigger it twice to use both item slots).

- [ ] **Step 4: Review the report:**

```sql
SELECT stage, count(*), round(avg(input_i),1) AS avg_i,
       min(input_i) AS min_i, max(input_i) AS max_i
FROM normalize_jobs GROUP BY stage;
```

- [ ] **Step 5: Pilot before the full batch** — normalize a small sample first: temporarily trigger `dispatch-normalize` with `max_runs=5`, spot-check those five URLs in the RadioScanner (listen for pumping artifacts from dynaudnorm; retune `NORM_*` env on the worker if needed — env change requires a pod restart via infra), then trigger the full drain.

- [ ] **Step 6: After the batch:** `kubectl -n file-proxy rollout restart deploy/file-proxy`, spot-check a few stations in the app, and confirm `SELECT count(*) FROM normalize_jobs WHERE stage NOT IN ('done','skipped');` is 0 (or investigate `failed` rows via `error_message`).
