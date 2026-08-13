# Audio Enhancement + RadioScanner Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce AI-enhanced versions of the audio for listening, serve them as the default in RadioScanner, and let a listener switch back to the original recording.

**Architecture:** Enhanced renders go to a **new `audio-enhanced/` prefix**, never overwriting `audio/`. `mp3_items.url` **stays canonical** — it keeps pointing at `audio/` — and a new `enhanced_url` field holds the render. RadioScanner defaults to `enhanced_url` and toggles back to `url`. Enhancement is a listening feature only: transcription continues to read `audio/`, so a bad render can never corrupt a transcript. The enhancement chain is chosen by **listening to an A/B audition set**, not by ASR metrics.

**Why `url` is not repointed.** `mp3_items.url` is the join key for the entire audio pipeline. `patch_mp3_subtitles`, `link_mp3_subtitles_flow` and `backfill_mp3_catalogue_flow` all match on it holding an `audio/` URL. Repointing it would make the first fail every future transcribe job, the second report every row unlinked, and the third — because it dedupes new rows against `{row["url"]}` — silently create 789 duplicate catalogue rows. Adding a field alongside `url` gives the listener exactly the same toggle while leaving every one of those joins untouched, and means future code that joins on `url` cannot reintroduce the bug.

**Tech Stack:** DeepFilterNet 3 (masking model) on the Mac Studio via torch/MPS or the standalone `deep-filter` binary, ffmpeg, Prefect 3, Directus REST, React + Classicy for the front end.

**Spec:** [`plans/2026-08-13-audio-enhancement-findings.md`](2026-08-13-audio-enhancement-findings.md)

## Global Constraints

- **Masking models only.** No generative enhancement (resemble-enhance, VoiceFixer, diffusion vocoders). They resynthesize speech and can emit fluent words nobody said, and every quality signal moves the right way while they do it. This is a hard constraint on a primary-source archive, not a preference.
- **Never overwrite `audio/`.** Enhanced output goes to `audio-enhanced/` only.
- **Transcription never reads `audio-enhanced/`.** Enforced by a test in Task 6.
- `audio-enhanced/` needs a Traefik Ingress path rule in `github.com/Keeping-History/infra` before anything is publicly reachable — Kubernetes `pathType: Prefix` matches on path-element boundaries, so the existing `/audio` rule does **not** cover `/audio-enhanced`.
- Deployment is GitOps. Land on `main`; never `kubectl set image`.
- Every commit carries `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- **Ordering against the other two plans is soft, not hard.** Because `url` is never
  modified, nothing here breaks the party-identification or chunked-VAD plans, and
  this plan can run alongside them. Two caveats: (a) run Task 5 *after*
  `backfill-mp3-catalogue` has created the 168 missing rows, or those files render
  but log "no mp3_items row" and go unlinked — re-running Task 5 fixes it, since it
  is idempotent; (b) do not overlap Task 5 with the chunked-VAD corpus run, as both
  push ~296 hours of audio through the Mac Studio.

---

## File Structure

**Modified**
- `video_grabber/config.py` — enhancement prefix, chain selection
- `video_grabber/serve.py` — register the new flows
- `packages/frontend/src/…/RadioScanner/` — the toggle

**Created**
- `video_grabber/enhance/__init__.py`
- `video_grabber/enhance/chains.py` — pure: named filter chains, key mapping
- `video_grabber/enhance/flows.py` — audition and corpus render flows
- `tests/test_enhance_chains.py`

**Infra (separate repo)**
- `Keeping-History/infra` — `/audio-enhanced` Ingress path rule

---

### Task 1: Serve the new prefix

Without this the audition in Task 3 returns 404 and the whole plan stalls at the
first gate.

**Files:**
- Modify (infra repo): the `file-proxy` Ingress

- [ ] **Step 1: Add the path rule**

In `Keeping-History/infra`, add to the `file-proxy` Ingress rules, matching the
existing entries:

```yaml
          - path: /audio-enhanced
            pathType: Prefix
            backend:
              service:
                name: file-proxy
                port:
                  number: 80
```

- [ ] **Step 2: Land it and wait for ArgoCD**

Commit to `main` on the infra repo. Confirm sync:

```bash
kubectl -n file-proxy get ingress file-proxy \
  -o jsonpath='{range .spec.rules[*].http.paths[*]}{.path}{"\n"}{end}'
```
Expected: `/audio-enhanced` present.

- [ ] **Step 3: Verify with a probe object**

Upload one small file to `audio-enhanced/_probe.txt` and fetch
`https://files.911realtime.org/audio-enhanced/_probe.txt`.
Expected: HTTP 200. A 404 means the rule has not synced; do not proceed. Delete the
probe afterwards.

---

### Task 2: Named enhancement chains

Pure module so the chain definitions and key mapping are testable without audio.

**Files:**
- Create: `video_grabber/enhance/__init__.py` (empty), `video_grabber/enhance/chains.py`
- Test: `tests/test_enhance_chains.py`

**Interfaces:**
- Produces: `CHAINS: dict[str, Chain]`, `enhanced_key(audio_key: str) -> str`, `audition_key(audio_key, chain_name) -> str`

- [ ] **Step 1: Write the failing test**

Create `tests/test_enhance_chains.py`:

```python
import pytest

from video_grabber.enhance.chains import CHAINS, audition_key, enhanced_key


def test_enhanced_key_mirrors_the_audio_path_under_the_new_prefix():
    assert enhanced_key("audio/AA77/0812 aa77 taxi.mp3") == \
        "audio-enhanced/AA77/0812 aa77 taxi.mp3"


def test_enhanced_key_refuses_anything_outside_audio():
    # Guards against ever writing an "enhanced" file over a source recording.
    with pytest.raises(ValueError):
        enhanced_key("subtitles/audio/x.srt")


def test_enhanced_key_is_never_the_input_key():
    k = "audio/norad/neads/DRM1_DAT2_Channel_3_MCC_TK.mp3"
    assert enhanced_key(k) != k


def test_audition_keys_are_namespaced_per_chain():
    a = audition_key("audio/AA77/x.mp3", "dfn_moderate")
    b = audition_key("audio/AA77/x.mp3", "dfn_full")
    assert a != b
    assert a.startswith("audio-enhanced/_audition/")


def test_every_chain_declares_whether_it_uses_a_model():
    for name, chain in CHAINS.items():
        assert isinstance(chain.uses_model, bool), name


def test_no_chain_is_generative():
    # Hard constraint: generative enhancement can emit speech nobody said.
    for name, chain in CHAINS.items():
        assert not chain.generative, f"{name} is generative and must not exist here"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_enhance_chains.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'video_grabber.enhance'`

- [ ] **Step 3: Write the implementation**

```python
"""Named audio-enhancement chains for the listening experience.

Every chain here is *discriminative*: it estimates a mask over the real recording
and can only remove energy. Generative restoration is deliberately absent. A model
that resynthesizes speech from a learned prior will produce fluent, confident audio
for a passage that was six seconds of static, and nothing downstream can tell --
it sounds better, ASR confidence rises, and containment checks pass because the
transcript really does contain the words. On a primary-source archive that is a
provenance failure, not a tuning choice.

Enhancement output is for listening only. Transcription always reads audio/.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

AUDIO_PREFIX = "audio/"
ENHANCED_PREFIX = "audio-enhanced/"


@dataclass(frozen=True)
class Chain:
    """One enhancement recipe.

    ffmpeg_pre  filter string applied before the model, or None
    dfn_atten   DeepFilterNet attenuation limit in dB, or None to skip the model
    ffmpeg_post filter string applied after the model, or None
    """
    ffmpeg_pre: str | None
    dfn_atten: int | None
    ffmpeg_post: str | None
    generative: bool = False

    @property
    def uses_model(self) -> bool:
        return self.dfn_atten is not None


BAND = "highpass=f=200,lowpass=f=3400"
SPEECH = "speechnorm=e=12.5:r=0.0001:l=1"

CHAINS: dict[str, Chain] = {
    # DSP only -- the control. Measured best for ASR; included so the audition can
    # tell whether the model earns its place for listening.
    "dsp_only": Chain(ffmpeg_pre=f"{BAND},{SPEECH}", dfn_atten=None, ffmpeg_post=None),
    # Conservative model: mixes enhanced with original, limiting artifacts.
    "dfn_moderate": Chain(ffmpeg_pre=None, dfn_atten=20, ffmpeg_post=SPEECH),
    # Full attenuation. Sounds cleanest, measured worst for ASR -- which does not
    # disqualify it here, because nothing transcribes this output.
    "dfn_full": Chain(ffmpeg_pre=None, dfn_atten=100, ffmpeg_post=SPEECH),
    # Model plus band-limiting and gain staging.
    "dfn_full_band": Chain(ffmpeg_pre=None, dfn_atten=100, ffmpeg_post=f"{BAND},{SPEECH}"),
}


def enhanced_key(audio_key: str) -> str:
    """Destination key for an enhanced render."""
    if not audio_key.startswith(AUDIO_PREFIX):
        raise ValueError(
            f"refusing to derive an enhanced key from {audio_key!r}: "
            f"only keys under {AUDIO_PREFIX!r} can be enhanced"
        )
    return ENHANCED_PREFIX + audio_key[len(AUDIO_PREFIX):]


def audition_key(audio_key: str, chain_name: str) -> str:
    """Destination key for one audition render, namespaced by chain."""
    if chain_name not in CHAINS:
        raise ValueError(f"unknown chain {chain_name!r}")
    stem = Path(audio_key).name
    return f"{ENHANCED_PREFIX}_audition/{chain_name}/{stem}"
```

- [ ] **Step 4: Run tests**

Run: `pytest tests/test_enhance_chains.py -v`
Expected: PASS (6 passed)

- [ ] **Step 5: Commit**

```bash
git add video_grabber/enhance tests/test_enhance_chains.py
git commit -m "feat(enhance): named discriminative enhancement chains

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Audition flow and the listening gate

**Files:**
- Create: `video_grabber/enhance/flows.py`
- Modify: `video_grabber/config.py`, `video_grabber/serve.py`

**Interfaces:**
- Produces: `render_audition_flow(keys: list[str] | None = None)`, `render_one(audio_key, chain_name, cfg) -> str`

- [ ] **Step 1: Add config**

```python
    enhance_chain: str = field(default_factory=lambda: os.getenv("ENHANCE_CHAIN", ""))
    deep_filter_bin: str = field(
        default_factory=lambda: os.getenv("DEEP_FILTER_BIN", "/usr/local/bin/deep-filter")
    )
```

`enhance_chain` defaults to empty deliberately: the corpus flow in Task 5 refuses to
run until a chain has been chosen by listening.

- [ ] **Step 2: Write the flows**

```python
"""Render enhanced audio. Audition first, corpus second."""
import subprocess
import tempfile
from pathlib import Path

from prefect import flow, get_run_logger

from video_grabber.config import Config
from video_grabber.enhance.chains import CHAINS, audition_key, enhanced_key
from video_grabber.storage import wasabi

# Eight clips spanning the failure modes: three that transcribed badly, three
# mid-quality, two clean controls. Same set used in the findings experiment, so
# the audition is comparable to the measurements already recorded.
AUDITION_CLIPS = [
    "audio/AA77/093535 aa77 he's descendin.mp3",
    "audio/AA77/093657 aa77 looks like wen.mp3",
    "audio/AA77/100225 aa77 line 4530 repo.mp3",
    "audio/AA77/083955 aa77 bobcat or hend.mp3",
    "audio/AA77/093222 aa77 danielle heard.mp3",
    "audio/AA77/093728 aa77 track b032 los.mp3",
    "audio/AA77/084013 aa77 zid checkin mo.mp3",
    "audio/AA77/091836 aa77 summersall to .mp3",
]


def render_one(audio_key: str, chain_name: str, cfg: Config, dest_key: str) -> str:
    """Render one file through one chain and upload it to dest_key."""
    chain = CHAINS[chain_name]
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        src = d / "src.mp3"
        wasabi.download_file(audio_key, src, cfg)

        stage = d / "stage.wav"
        cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(src)]
        if chain.ffmpeg_pre:
            cmd += ["-af", chain.ffmpeg_pre]
        cmd += ["-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", str(stage)]
        subprocess.run(cmd, check=True)

        current = stage
        if chain.dfn_atten is not None:
            outdir = d / "dfn"
            outdir.mkdir()
            dfn = [cfg.deep_filter_bin, "-D", "-o", str(outdir), str(stage)]
            if chain.dfn_atten < 100:
                dfn += ["-a", str(chain.dfn_atten)]
            subprocess.run(dfn, check=True)
            produced = sorted(outdir.glob("*.wav"))
            if not produced:
                raise RuntimeError(f"deep-filter produced nothing for {audio_key!r}")
            current = produced[0]

        final = d / "final.mp3"
        cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(current)]
        if chain.ffmpeg_post:
            cmd += ["-af", chain.ffmpeg_post]
        cmd += ["-c:a", "libmp3lame", "-b:a", "128k", str(final)]
        subprocess.run(cmd, check=True)

        wasabi.upload_mp3(final, dest_key, cfg, cache_control="max-age=31536000")
    return dest_key


@flow(name="render-audition")
def render_audition_flow(keys: list[str] | None = None) -> None:
    """Render the audition set through every chain, for a human to listen to."""
    logger = get_run_logger()
    cfg = Config()
    clips = keys or AUDITION_CLIPS
    for key in clips:
        for chain_name in CHAINS:
            dest = audition_key(key, chain_name)
            render_one(key, chain_name, cfg, dest)
            logger.info("audition: https://files.911realtime.org/%s", dest)
```

Register both flows in `serve.py` as manual-only deployments.

- [ ] **Step 3: Run the audition**

Run `render-audition`. Collect the logged URLs.

- [ ] **Step 4: LISTEN — this is a human gate**

Present the URLs grouped by clip, so each clip can be heard unprocessed
(`https://files.911realtime.org/audio/<key>`) against all four chains. Ask which
chain to adopt, and specifically whether `dfn_full` sounds better than `dsp_only`
— that is the question the ASR measurements could not answer.

**Do not proceed to Task 5 without an explicit choice.** Record it in the findings
doc alongside the measurements.

- [ ] **Step 5: Commit**

```bash
git add video_grabber/enhance/flows.py video_grabber/config.py video_grabber/serve.py
git commit -m "feat(enhance): audition flow for choosing a chain by listening

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The `enhanced_url` field

**Files:**
- Directus schema (operational)

- [ ] **Step 1: Check for a running backup**

```sql
SELECT pid, state, query_start, left(query, 60) FROM pg_stat_activity
WHERE query ILIKE '%pg_dump%';
```
Wait if one is running — a queued ALTER stalls live reads.

- [ ] **Step 2: Create the field**

```bash
curl -sS -X POST "$DIRECTUS_URL/fields/mp3_items" \
  -H "Authorization: Bearer $DIRECTUS_TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "field": "enhanced_url",
    "type": "text",
    "meta": {"interface": "input", "note": "Enhanced render for listening. url remains canonical and points at the source audio/ recording; RadioScanner defaults to this field and toggles back to url."},
    "schema": {"is_nullable": true}
  }' | tee /tmp/enhanced-field.json
```

Log the response body.

- [ ] **Step 3: Grant public read**

The field must be readable by the public policy or RadioScanner cannot see it.
Add `enhanced_url` to the public read permission for `mp3_items`, then verify
unauthenticated:

```bash
curl -sS "$DIRECTUS_URL/items/mp3_items?fields=id,url,enhanced_url&limit=1"
```
Expected: `enhanced_url` present in the response.

---

### Task 5: Corpus render and link

**Files:**
- Modify: `video_grabber/enhance/flows.py`

- [ ] **Step 1: Write the corpus flow**

```python
@flow(name="render-enhanced-corpus")
def render_enhanced_corpus_flow(dry_run: bool = True, limit: int | None = None) -> None:
    """Render every audio/ mp3 through the chosen chain and record the render.

    Writes only mp3_items.enhanced_url. `url` is never touched: it is the join key
    for patch_mp3_subtitles, link_mp3_subtitles_flow and backfill_mp3_catalogue_flow,
    and repointing it would break all three -- the last of them by silently
    creating a duplicate row for every file in the bucket.

    Idempotent: re-running overwrites enhanced_url with the same value.
    """
    import httpx
    from video_grabber.directus.writer import _auth_headers, wasabi_public_url

    logger = get_run_logger()
    cfg = Config()
    if not cfg.enhance_chain:
        raise RuntimeError(
            "ENHANCE_CHAIN is unset. Choose a chain by listening to the audition "
            "output (render-audition) before running the corpus render."
        )
    if cfg.enhance_chain not in CHAINS:
        raise RuntimeError(f"unknown ENHANCE_CHAIN {cfg.enhance_chain!r}")

    keys = [k for k in wasabi.list_keys("audio/", cfg) if k.lower().endswith(".mp3")]
    done = 0
    for key in keys:
        if limit is not None and done >= limit:
            break
        dest = enhanced_key(key)
        if dry_run:
            logger.info("DRY RUN would render %s -> %s", key, dest)
            done += 1
            continue

        render_one(key, cfg.enhance_chain, cfg, dest)

        src_url, enh_url = wasabi_public_url(key), wasabi_public_url(dest)
        r = httpx.get(f"{cfg.directus_url}/items/mp3_items",
                      params={"filter[url][_eq]": src_url, "fields": "id"},
                      headers=_auth_headers(cfg))
        r.raise_for_status()
        rows = r.json().get("data") or []
        if not rows:
            logger.warning("no mp3_items row for %s; rendered but not linked", key)
            done += 1
            continue
        pr = httpx.patch(f"{cfg.directus_url}/items/mp3_items/{rows[0]['id']}",
                         json={"enhanced_url": enh_url},
                         headers=_auth_headers(cfg))
        pr.raise_for_status()
        done += 1
    logger.info("render-enhanced-corpus: %d files (%s)", done,
                "dry run" if dry_run else cfg.enhance_chain)
```

- [ ] **Step 2: Dry run, then a limited real run**

`dry_run=True` first. Then `dry_run=False, limit=5`; fetch both URLs for those five
rows and confirm each plays and that `url` still resolves to the `audio/` original.

- [ ] **Step 3: Full run**

`dry_run=False`, no limit.

- [ ] **Step 4: Verify `url` was never touched**

```sql
SELECT count(*) FROM mp3_items WHERE url LIKE '%/audio-enhanced/%';
```
Expected: **0**. Any row here means the flow wrote to the join key and the
catalogue/linkage flows are now broken.

```sql
SELECT count(*) AS rows, count(enhanced_url) AS rendered FROM mp3_items;
```
Expected: `rendered` equals the number of files actually processed.

- [ ] **Step 5: Confirm the pipeline still joins**

Re-run `link-mp3-subtitles` with `dry_run=True` from the party-identification plan.
Expected: 0 rows reported as missing an SRT. If that number jumped, `url` was
modified somewhere and this task must be rolled back before going further.

- [ ] **Step 5: Commit**

```bash
git add video_grabber/enhance/flows.py
git commit -m "feat(enhance): corpus render and enhanced_url linkage

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Guard that transcription never reads enhanced audio

**Files:**
- Test: `tests/test_transcribe_flows.py`

- [ ] **Step 1: Write the guard test**

```python
def test_scan_transcribe_never_enqueues_enhanced_audio(monkeypatch):
    """Transcripts must come from the source recording, never from a render.

    mp3_items.url now points at audio-enhanced/, so anything deriving transcribe
    work from Directus rows rather than from the audio/ prefix would silently
    start transcribing processed audio.
    """
    seen = []
    monkeypatch.setattr(
        flows, "wasabi",
        SimpleNamespace(
            list_keys=lambda prefix, cfg: seen.append(prefix) or [],
            upload_text=lambda *a, **k: None,
        ),
    )
    monkeypatch.setattr(flows, "get_db", lambda: FakeConn([]))
    monkeypatch.setattr(flows, "get_run_logger", lambda: logging.getLogger("test"))
    flows.scan_transcribe_flow.fn()
    assert "audio/" in seen
    assert not any(p.startswith("audio-enhanced") for p in seen)
```

- [ ] **Step 2: Run it**

Run: `pytest tests/test_transcribe_flows.py -k enhanced -v`
Expected: PASS (the flow already lists `audio/`; this locks it in)

- [ ] **Step 3: Commit**

```bash
git add tests/test_transcribe_flows.py
git commit -m "test(transcribe): lock transcription to the audio/ prefix

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: RadioScanner toggle

**Files:**
- Modify: `packages/frontend/src/` RadioScanner app and its settings
- Test: colocated vitest file

**Interfaces:**
- Consumes: `mp3_items.enhanced_url`

- [ ] **Step 1: Locate the audio source resolution**

```bash
grep -rn "mp3_items\|enhanced\|\.url" packages/frontend/src --include=*.tsx --include=*.ts \
  | grep -i radio | head -20
```

Read the component that resolves a station's playable URL before editing.

- [ ] **Step 2: Write the failing test**

New test file needs explicit cleanup — this project's vitest has no RTL auto-cleanup:

```tsx
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

afterEach(cleanup)

describe('audio source selection', () => {
  it('plays the enhanced render by default', () => {
    expect(resolveAudioUrl({ url: '/o.mp3', enhanced_url: '/e.mp3' }, false))
      .toBe('/e.mp3')
  })

  it('plays the original when the listener asks for it', () => {
    expect(resolveAudioUrl({ url: '/o.mp3', enhanced_url: '/e.mp3' }, true))
      .toBe('/o.mp3')
  })

  it('falls back to url when no enhanced render exists yet', () => {
    // enhanced_url is null until Task 5 has processed that file. The default
    // path must not produce an undefined src and silently break playback.
    expect(resolveAudioUrl({ url: '/o.mp3', enhanced_url: null }, false))
      .toBe('/o.mp3')
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm --filter @rt911/frontend exec vitest run <path>`
Expected: FAIL — `resolveAudioUrl is not defined`

- [ ] **Step 4: Implement**

```ts
export function resolveAudioUrl(
  item: { url: string; enhanced_url?: string | null },
  preferOriginal: boolean,
): string {
  // url is always populated and always points at the source recording, so it is
  // the safe fallback: a file that has not been rendered yet simply plays
  // unenhanced rather than producing an undefined src.
  if (preferOriginal) return item.url
  return item.enhanced_url ?? item.url
}
```

Add the toggle to RadioScanner's existing Settings surface, persisted the same way
its other preferences are, and label it in plain terms — "Play original recording
(more noise)" rather than "disable enhancement".

- [ ] **Step 5: Run the suite**

Run: `pnpm --filter @rt911/frontend exec vitest run && pnpm --filter @rt911/frontend lint`
Expected: PASS

- [ ] **Step 6: Verify in the running app**

Start the dev server and confirm which port it actually bound — stale vites squat
low ports. Play a station, flip the toggle, confirm the network tab switches between
`/audio-enhanced/` and `/audio/`.

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/src
git commit -m "feat(radio): toggle between enhanced and original audio

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** Findings conclusion 5 (no generative models) → Task 2's
`generative` flag and its test. Conclusion 2 (no blanket enhancement without
evidence) → Task 3's listening gate and the empty `ENHANCE_CHAIN` default that makes
Task 5 refuse to run unattended. The "separable goals" conclusion → Task 6, which
enforces the separation in code rather than by convention.

**Deliberate deviation from the spec.** The findings recommend enhancement only as a
*targeted rescue* for degenerate clips. This plan renders the **whole corpus**,
because the goal here is listening quality across RadioScanner rather than transcript
rescue, and a toggle that only works on 125 files would be confusing. The targeted
framing still holds for transcription, which Task 6 keeps entirely separate.

**Type consistency.** `enhanced_key`/`audition_key` both return plain `str` keys
without a leading slash, matching `wasabi.list_keys` output and `wasabi_public_url`
input. `Chain.dfn_atten is None` is the single signal for "skip the model", used by
both `uses_model` and `render_one`.

**Risk accepted.** Task 5 writes a new field on every row and never modifies `url`.
Rollback is `UPDATE mp3_items SET enhanced_url = NULL`, after which every listener
transparently falls back to the source recording — the front end already treats a
null `enhanced_url` as "play `url`", so a rollback needs no front-end change and no
Cloudflare purge. Task 5 Step 4 asserts `url` was never touched, and Step 5 re-runs
the linkage flow to prove the pipeline's joins still resolve.
