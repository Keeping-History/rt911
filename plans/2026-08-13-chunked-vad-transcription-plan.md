# Chunked + VAD Re-transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-transcribe all 789 audio files using fixed-window chunking with voice-activity detection, so the 125 recordings that currently produce degenerate or sparse transcripts (76% of corpus runtime) yield usable text.

**Architecture:** No new job table. `transcribe-item` stays the unit of work per *file*; inside it, long recordings are transcribed as a sequence of fixed windows using whisper.cpp's native `--offset-t`/`--duration`, each with `--vad`, and the resulting cues are shifted and merged with the `shift`/`merge` helpers that already exist in `transcribe/srt.py`. Parallelism comes from running many files concurrently across the Mac Studio workers, which is ample: the longest single file is 6.75 h.

**Tech Stack:** whisper.cpp (`whisper-cli`) with the silero VAD model, Prefect 3, SQLAlchemy Core, boto3, pytest.

**Spec:** [`plans/2026-08-13-audio-enhancement-findings.md`](2026-08-13-audio-enhancement-findings.md)

## Global Constraints

- Run from `packages/tools/video-grabber/`. Tests `pytest tests/ -v`; lint `ruff check video_grabber/ tests/`.
- **Task 1 of `2026-08-13-audio-party-identification-plan.md` (seeding `transcribe_jobs`) must be complete before anything here.** That plan's guard is what makes re-transcription a deliberate act rather than an accident.
- **Snapshot the existing SRTs before overwriting any of them** (Task 2). They are live production captions for TV and Radio.
- This plan **supersedes** the transcripts the party-identification plan consumes. Run this to completion first, then regenerate the AA77 fixture and re-run party identification.
- Transcription reads from `audio/`, never from `audio-enhanced/`. Enhancement is a listening feature and must never be able to corrupt a transcript.
- Every commit carries `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

## File Structure

**Modified**
- `packages/tools/video-grabber/Dockerfile` — fetch the silero VAD model into `/opt/models`
- `video_grabber/config.py` — `vad_model`, `chunk_seconds`, `chunk_threshold_seconds`
- `video_grabber/transcribe/whisper.py` — pass VAD and offset/duration options
- `video_grabber/transcribe/srt.py` — `strip_nonspeech_cues()`
- `video_grabber/transcribe/flows.py` — chunked transcription inside `transcribe_item_flow`

**Created**
- `video_grabber/transcribe/chunking.py` — pure: window arithmetic
- `tests/test_transcribe_chunking.py`

---

### Task 1: Add the silero VAD model to the image

`whisper-cli` supports `--vad` but requires `--vad-model`; only `ggml-medium.en.bin`
is in `/opt/models` today, so enabling VAD without this fails at runtime.

**Files:**
- Modify: `packages/tools/video-grabber/Dockerfile:58-59`

- [ ] **Step 1: Fetch the VAD model in the whisper-builder stage**

Beside the existing `download-ggml-model.sh medium.en` line:

```dockerfile
RUN cd whisper.cpp && bash ./models/download-vad-model.sh silero-v5.1.2 && \
    cp models/ggml-silero-v5.1.2.bin /opt/models/
```

- [ ] **Step 2: Verify the model lands in the runtime image**

The existing `COPY --from=whisper-builder /opt/models/ /opt/models/` already carries
it. Build and check:

```bash
docker build -t vg-vadtest packages/tools/video-grabber
docker run --rm vg-vadtest ls -la /opt/models/
```
Expected: both `ggml-medium.en.bin` and `ggml-silero-v5.1.2.bin`.

- [ ] **Step 3: Commit**

```bash
git add packages/tools/video-grabber/Dockerfile
git commit -m "build(video-grabber): add silero VAD model to the image

whisper-cli --vad requires an explicit --vad-model; only the medium.en
transcription model was present.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Snapshot the existing subtitles

Full-corpus re-transcription overwrites 1,390 live caption objects. Snapshot first.

- [ ] **Step 1: Server-side copy `subtitles/` to `subtitles-v1/`**

From a pod with Wasabi credentials:

```python
from video_grabber.config import Config
from video_grabber.storage import wasabi

cfg = Config()
keys = wasabi.list_keys("subtitles/", cfg)
copied = 0
for k in keys:
    if wasabi.copy_object_if_absent(k, "subtitles-v1/" + k[len("subtitles/"):], cfg):
        copied += 1
print("snapshotted", copied, "of", len(keys))
```

- [ ] **Step 2: Verify the count**

```bash
aws --endpoint-url https://s3.us-central-1.wasabisys.com \
  s3 ls s3://files.911realtime.org/subtitles-v1/ --recursive | wc -l
```
Expected: 1,390. Do not proceed until this matches.

---

### Task 3: Window arithmetic

Pure function deciding how a recording is split. Kept separate from the flow so the
boundary maths is testable without whisper, ffmpeg or a database.

**Files:**
- Create: `video_grabber/transcribe/chunking.py`
- Test: `tests/test_transcribe_chunking.py`

**Interfaces:**
- Produces: `windows(duration_s: float, chunk_s: int, overlap_s: int) -> list[tuple[int, int]]`
  returning `(offset_ms, duration_ms)` pairs

- [ ] **Step 1: Write the failing test**

Create `tests/test_transcribe_chunking.py`:

```python
import pytest

from video_grabber.transcribe.chunking import windows


def test_short_recording_is_one_window():
    assert windows(120.0, chunk_s=600, overlap_s=5) == [(0, 120000)]


def test_exact_multiple_produces_no_trailing_sliver():
    got = windows(1200.0, chunk_s=600, overlap_s=0)
    assert got == [(0, 600000), (600000, 600000)]


def test_windows_overlap_so_speech_on_a_boundary_is_not_lost():
    got = windows(1200.0, chunk_s=600, overlap_s=5)
    # second window starts 5s before the first one ends
    assert got[1][0] == 595000


def test_final_window_is_clipped_to_the_real_end():
    got = windows(1300.0, chunk_s=600, overlap_s=0)
    assert sum(d for _, d in got) >= 1300000
    assert got[-1][0] + got[-1][1] <= 1300000 + 1000


def test_a_six_hour_tape_is_split_into_bounded_windows():
    got = windows(24299.0, chunk_s=600, overlap_s=5)
    assert len(got) == 41
    assert all(d <= 600000 for _, d in got)


def test_zero_duration_raises_rather_than_returning_nothing():
    with pytest.raises(ValueError):
        windows(0, chunk_s=600, overlap_s=5)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_transcribe_chunking.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'video_grabber.transcribe.chunking'`

- [ ] **Step 3: Write the implementation**

```python
"""Split a recording into bounded transcription windows.

Whole-file transcription of the long position tapes fails badly: a single
5-minute window of the NEADS MCC tape yields 150 words while the entire 6.67-hour
file yields 84. Bounding the window bounds the decoder state.

Windows overlap slightly so a sentence straddling a boundary is seen whole by at
least one window; the merge step de-duplicates the repeated cues.
"""
from __future__ import annotations


def windows(duration_s: float, chunk_s: int, overlap_s: int) -> list[tuple[int, int]]:
    """Return [(offset_ms, duration_ms), …] covering the whole recording."""
    if duration_s <= 0:
        raise ValueError(f"duration must be positive, got {duration_s!r}")
    total_ms = int(round(duration_s * 1000))
    chunk_ms = chunk_s * 1000
    overlap_ms = overlap_s * 1000
    if total_ms <= chunk_ms:
        return [(0, total_ms)]

    step = chunk_ms - overlap_ms
    if step <= 0:
        raise ValueError("overlap_s must be smaller than chunk_s")

    out: list[tuple[int, int]] = []
    start = 0
    while start < total_ms:
        length = min(chunk_ms, total_ms - start)
        out.append((start, length))
        if start + length >= total_ms:
            break
        start += step
    return out
```

- [ ] **Step 4: Run tests**

Run: `pytest tests/test_transcribe_chunking.py -v`
Expected: PASS (6 passed)

- [ ] **Step 5: Commit**

```bash
git add video_grabber/transcribe/chunking.py tests/test_transcribe_chunking.py
git commit -m "feat(transcribe): bounded transcription windows

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Strip non-speech marker cues

`dedupe_consecutive` collapses runs of identical cues, which left the NEADS tapes
looking like a clean transcription of a quiet room: thousands of `[Music]` cues
became one. Markers should be removed outright, not deduplicated.

**Files:**
- Modify: `video_grabber/transcribe/srt.py`
- Test: `tests/test_srt.py`

**Interfaces:**
- Produces: `strip_nonspeech_cues(cues: list[Cue]) -> list[Cue]`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_srt.py`:

```python
from video_grabber.transcribe.srt import Cue, strip_nonspeech_cues


def test_strips_music_and_blank_audio_markers():
    cues = [Cue(0, 1, "[Music]"), Cue(1, 2, "Bravo 112"),
            Cue(2, 3, "[BLANK_AUDIO]"), Cue(3, 4, "♪♪")]
    assert [c.text for c in strip_nonspeech_cues(cues)] == ["Bravo 112"]


def test_keeps_inaudible_markers_because_they_mark_real_speech():
    # '[unintelligible]' means someone spoke and whisper could not resolve it.
    # That is information; '[Music]' over an open mic is not.
    cues = [Cue(0, 1, "[unintelligible]"), Cue(1, 2, "Bravo 112")]
    assert len(strip_nonspeech_cues(cues)) == 2


def test_leaves_ordinary_speech_untouched():
    cues = [Cue(0, 1, "American 77, Indy Center")]
    assert strip_nonspeech_cues(cues) == cues
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_srt.py -k nonspeech -v`
Expected: FAIL — `ImportError: cannot import name 'strip_nonspeech_cues'`

- [ ] **Step 3: Write the implementation**

In `video_grabber/transcribe/srt.py`:

```python
import re

# Markers whisper emits for non-speech audio. Deliberately excludes
# [unintelligible] / [inaudible]: those mark speech that could not be resolved,
# which is information worth keeping.
_NONSPEECH = re.compile(
    r"^\s*[\[\(]?\s*(music|blank_audio|silence|sound|noise|applause)\s*[\]\)]?\s*$",
    re.I,
)
_MUSIC_GLYPHS = re.compile(r"^[\s♪♫♩♬]+$")


def strip_nonspeech_cues(cues: list[Cue]) -> list[Cue]:
    """Drop cues that carry no speech at all.

    dedupe_consecutive() collapses runs of identical cues, which turned six hours
    of open-mic [Music] into a single cue and made an empty transcript look like a
    clean one. Removing them outright is the honest representation.
    """
    return [c for c in cues
            if not _NONSPEECH.match(c.text) and not _MUSIC_GLYPHS.match(c.text)]
```

- [ ] **Step 4: Run tests**

Run: `pytest tests/test_srt.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add video_grabber/transcribe/srt.py tests/test_srt.py
git commit -m "feat(transcribe): strip non-speech marker cues

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: VAD and window options on the whisper wrapper

**Files:**
- Modify: `video_grabber/config.py`, `video_grabber/transcribe/whisper.py`
- Test: `tests/test_transcribe_whisper.py`

**Interfaces:**
- Produces: `transcribe_wav(wav, out_base, cfg, *, offset_ms=0, duration_ms=0, vad=False, runner=subprocess.run)`

- [ ] **Step 1: Add config**

In `video_grabber/config.py`, beside `whisper_model`:

```python
    vad_model: str = field(
        default_factory=lambda: os.getenv("VAD_MODEL", "/opt/models/ggml-silero-v5.1.2.bin")
    )
    chunk_seconds: int = field(default_factory=lambda: _int("TRANSCRIBE_CHUNK_SECONDS", 600))
    chunk_overlap_seconds: int = field(
        default_factory=lambda: _int("TRANSCRIBE_CHUNK_OVERLAP_SECONDS", 5)
    )
```

- [ ] **Step 2: Write the failing test**

Append to `tests/test_transcribe_whisper.py`:

```python
def test_vad_flags_are_passed_when_enabled(tmp_path):
    seen = {}

    def runner(cmd, **kw):
        seen["cmd"] = cmd
        return SimpleNamespace(returncode=0, stderr="")

    cfg = SimpleNamespace(whisper_bin="whisper-cli", whisper_model="/m.bin",
                          whisper_threads=4, vad_model="/vad.bin")
    transcribe_wav(tmp_path / "a.wav", tmp_path / "out", cfg, vad=True, runner=runner)
    assert "--vad" in seen["cmd"]
    assert "/vad.bin" in seen["cmd"]


def test_window_flags_are_passed(tmp_path):
    seen = {}

    def runner(cmd, **kw):
        seen["cmd"] = cmd
        return SimpleNamespace(returncode=0, stderr="")

    cfg = SimpleNamespace(whisper_bin="whisper-cli", whisper_model="/m.bin",
                          whisper_threads=4, vad_model="/vad.bin")
    transcribe_wav(tmp_path / "a.wav", tmp_path / "out", cfg,
                   offset_ms=600000, duration_ms=600000, runner=runner)
    cmd = seen["cmd"]
    assert cmd[cmd.index("-ot") + 1] == "600000"
    assert cmd[cmd.index("-d") + 1] == "600000"


def test_no_window_flags_when_transcribing_whole_file(tmp_path):
    seen = {}

    def runner(cmd, **kw):
        seen["cmd"] = cmd
        return SimpleNamespace(returncode=0, stderr="")

    cfg = SimpleNamespace(whisper_bin="whisper-cli", whisper_model="/m.bin",
                          whisper_threads=4, vad_model="/vad.bin")
    transcribe_wav(tmp_path / "a.wav", tmp_path / "out", cfg, runner=runner)
    assert "-ot" not in seen["cmd"] and "--vad" not in seen["cmd"]
```

Add `from types import SimpleNamespace` at the top if absent.

- [ ] **Step 3: Run test to verify it fails**

Run: `pytest tests/test_transcribe_whisper.py -v`
Expected: FAIL — unexpected keyword argument `vad`

- [ ] **Step 4: Write the implementation**

```python
def transcribe_wav(wav: Path, out_base: Path, cfg: Config, *,
                   offset_ms: int = 0, duration_ms: int = 0, vad: bool = False,
                   runner=subprocess.run) -> Path:
    out_base.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        cfg.whisper_bin,
        "-m", cfg.whisper_model,
        "-t", str(cfg.whisper_threads),
        "-l", "en",
        "--output-srt",
        "--output-vtt",
        "--output-file", str(out_base),
    ]
    if vad:
        # VAD skips the long silences on open-mic position tapes, which is both a
        # large compute saving and the reason the decoder stops collapsing.
        cmd += ["--vad", "--vad-model", cfg.vad_model]
    if offset_ms:
        cmd += ["-ot", str(offset_ms)]
    if duration_ms:
        cmd += ["-d", str(duration_ms)]
    cmd.append(str(wav))
    result = runner(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"whisper-cli failed ({result.returncode}): {result.stderr[-2000:]}")
    return out_base.with_suffix(".srt")
```

- [ ] **Step 5: Run tests**

Run: `pytest tests/test_transcribe_whisper.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add video_grabber/config.py video_grabber/transcribe/whisper.py tests/test_transcribe_whisper.py
git commit -m "feat(transcribe): VAD and window options on the whisper wrapper

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Chunked transcription in the flow

**Files:**
- Modify: `video_grabber/transcribe/flows.py`
- Test: `tests/test_transcribe_flows.py`

**Interfaces:**
- Consumes: `windows()` (Task 3), `strip_nonspeech_cues()` (Task 4), `transcribe_wav(..., offset_ms, duration_ms, vad)` (Task 5), and the existing `parse_srt`, `shift`, `merge`, `dedupe_consecutive`, `render_srt`, `render_vtt` from `transcribe/srt.py`
- Produces: `transcribe_windows(wav, scratch, cfg, duration_s) -> list[Cue]`

- [ ] **Step 1: Write the failing test**

```python
def test_transcribe_windows_shifts_each_window_onto_the_file_timeline(monkeypatch, tmp_path):
    calls = []

    def fake(wav, out_base, cfg, *, offset_ms=0, duration_ms=0, vad=False, runner=None):
        calls.append(offset_ms)
        out_base.parent.mkdir(parents=True, exist_ok=True)
        srt = out_base.with_suffix(".srt")
        srt.write_text("1\n00:00:01,000 --> 00:00:02,000\nword\n")
        return srt

    monkeypatch.setattr(flows, "transcribe_wav", fake)
    cfg = SimpleNamespace(chunk_seconds=600, chunk_overlap_seconds=0,
                          whisper_bin="x", whisper_model="y", whisper_threads=1,
                          vad_model="z")
    cues = flows.transcribe_windows(tmp_path / "a.wav", tmp_path, cfg, duration_s=1200.0)
    assert calls == [0, 600000]
    # the second window's 1s cue lands at 601s on the file timeline
    assert any(abs(c.start - 601.0) < 0.01 for c in cues)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_transcribe_flows.py -k transcribe_windows -v`
Expected: FAIL — `AttributeError: … has no attribute 'transcribe_windows'`

- [ ] **Step 3: Write the implementation**

In `video_grabber/transcribe/flows.py`:

```python
from video_grabber.transcribe.chunking import windows
from video_grabber.transcribe.srt import strip_nonspeech_cues


def transcribe_windows(wav: Path, scratch: Path, cfg, duration_s: float) -> list[Cue]:
    """Transcribe a recording as a sequence of bounded windows, merged onto one
    timeline.

    Whole-file transcription collapses on the long position tapes; see
    plans/2026-08-13-audio-enhancement-findings.md. VAD is enabled for every
    window: on the short clips it costs nothing, and on the tapes it is what stops
    hours of open-mic silence from swamping the decoder.
    """
    blocks: list[list[Cue]] = []
    for i, (offset_ms, length_ms) in enumerate(
        windows(duration_s, cfg.chunk_seconds, cfg.chunk_overlap_seconds)
    ):
        base = scratch / f"w{i:04d}"
        srt_path = transcribe_wav(wav, base, cfg, offset_ms=offset_ms,
                                  duration_ms=length_ms, vad=True)
        blocks.append(shift(parse_srt(srt_path.read_text()), offset_ms / 1000.0))
    return merge(blocks)
```

Then in `transcribe_item_flow`, replace the single `transcribe_wav` call with:

```python
        wav = extract_audio(job.source_url, scratch / "audio.wav")
        duration_s = probe_duration_seconds(wav)
        cues = transcribe_windows(wav, scratch, cfg, duration_s)
        clean_cues = dedupe_consecutive(strip_nonspeech_cues(cues))
        out_base = scratch / "out"
        out_base.parent.mkdir(parents=True, exist_ok=True)
        srt_path = out_base.with_suffix(".srt")
        vtt_path = out_base.with_suffix(".vtt")
        srt_path.write_text(render_srt(clean_cues))
        vtt_path.write_text(render_vtt(clean_cues))
```

Add a local helper:

```python
def probe_duration_seconds(path: Path) -> float:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True,
    )
    if r.returncode != 0 or not r.stdout.strip():
        raise RuntimeError(f"ffprobe could not read a duration from {path}")
    return float(r.stdout.strip())
```

Note the ordering: `strip_nonspeech_cues` runs **before** `dedupe_consecutive`, so
markers are removed rather than collapsed to one.

- [ ] **Step 4: Run the full suite**

Run: `pytest tests/ -v && ruff check video_grabber/ tests/`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add video_grabber/transcribe/flows.py tests/test_transcribe_flows.py
git commit -m "feat(transcribe): chunked windows with VAD

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Validate on the known-bad tape before the corpus run

- [ ] **Step 1: Re-transcribe one file end to end**

Reset a single job and let a worker take it:

```sql
UPDATE transcribe_jobs SET stage = 'pending', error_message = NULL
WHERE source_key = 'audio/norad/neads/DRM1_DAT2_Channel_3_MCC_TK.mp3';
```

Run `dispatch-transcribe`.

- [ ] **Step 2: Check the result against the baseline**

The old transcript was **84 words** for 6.67 hours. Count the new one:

```bash
aws --endpoint-url https://s3.us-central-1.wasabisys.com s3 cp \
  "s3://files.911realtime.org/subtitles/audio/norad/neads/DRM1_DAT2_Channel_3_MCC_TK.srt" - \
  | grep -v '^[0-9]*$' | grep -v -- '-->' | wc -w
```

Expected: several thousand. The 5-minute probe alone produced 150 words, so anything
under ~1,000 means the chunking is not taking effect — stop and diagnose rather than
launching the corpus run.

- [ ] **Step 3: Spot-check a short clip for regression**

Re-transcribe `audio/AA77/091654 aa77 johnson zdc th.mp3` and diff against
`tests/fixtures/aa77/srt/091654 aa77 johnson zdc th.srt`. The named parties
(Kerry Johnson, John Thomas, Washington Center) must still appear. Chunking must not
degrade material that already worked.

---

### Task 8: Corpus run

- [ ] **Step 1: Reset every mp3 job**

```sql
UPDATE transcribe_jobs SET stage = 'pending', error_message = NULL, srt_key = NULL
WHERE kind = 'mp3';
```

- [ ] **Step 2: Run and monitor**

Run `dispatch-transcribe`. Monitor with:

```sql
SELECT stage, count(*) FROM transcribe_jobs WHERE kind = 'mp3' GROUP BY 1;
```

- [ ] **Step 3: Re-measure transcript quality**

Re-run the scoring from the findings doc — words per minute of audio across all 789
transcripts. The 125 rescue candidates should drop sharply. Record the new number.

- [ ] **Step 4: Regenerate the party-identification fixture**

The AA77 fixture at `tests/fixtures/aa77/srt/` came from the old whole-file method.
Replace those 39 files with the new transcripts and re-check the hand-classified
`parties.csv` against them — a clip that was undeterminable may now be readable, in
which case update its row and note the change.

- [ ] **Step 5: Commit the results**

```bash
git add plans/2026-08-13-audio-enhancement-findings.md packages/tools/video-grabber/tests/fixtures/aa77
git commit -m "docs: record chunked/VAD re-transcription results

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** Findings conclusion 1 (chunking + VAD) → Tasks 1, 3, 5, 6.
Conclusion 4 (`speechnorm` gain staging) is **deliberately deferred** — it belongs to
the enhancement plan, and mixing it in here would confound the measurement of what
chunking alone achieves. The `dedupe_consecutive` mechanism identified in
Measurement 3 → Task 4.

**Type consistency.** `windows()` returns `(offset_ms, duration_ms)` integer pairs,
consumed only by `transcribe_windows`. `transcribe_wav`'s new keyword arguments are
keyword-only, so the existing TV call site is unaffected. `strip_nonspeech_cues`
takes and returns `list[Cue]`, matching `dedupe_consecutive`.

**Risk accepted.** Task 8 overwrites all 789 transcripts. Task 2's `subtitles-v1/`
snapshot is the rollback, and Task 7 gates the corpus run on one known-bad and one
known-good file.
