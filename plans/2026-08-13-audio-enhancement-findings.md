# Audio enhancement investigation — findings

**Date:** 2026-08-13
**Question asked:** can we clean radio static off the audio so transcription improves?
**Short answer:** static is not the bottleneck, and blanket AI denoising makes things
worse. The real defect is that long tapes are transcribed as one 6-hour unit.

## Measurement 1 — how bad are the transcripts, and where?

All 695 existing SRTs were fetched and scored against their audio duration.

| | files | share |
|---|---:|---:|
| empty | 0 | — |
| degenerate (`[inaudible]`, `[BLANK_AUDIO]`, `♪♪`) | 13 | 2% |
| sparse (< 25 words per minute of audio) | 112 | 16% |
| **rescue candidates** | **125** | **18% of files, 225.9 h = 76% of runtime** |

Concentrated almost entirely in the long tapes: faa_atc 96, norad 21,
fdny_dispatch 4, Langley 3, AA77 1. **The short clips are largely fine.** The AA77
collection — the material that prompted the question — has exactly one bad
transcript out of 39.

Worst case: `DRM1_DAT2_Channel_3_MCC_TK.mp3`, 6.67 hours of the NEADS Mission Crew
Commander position, produced **84 words**.

## Measurement 2 — does AI enhancement help? (8 AA77 clips × 5 variants)

DeepFilterNet 3 (discriminative masking model), compared against an unprocessed
baseline and a 200–3400 Hz bandpass control. Metric was mean per-token probability
from `whisper-cli --output-json-full`.

| variant | mean Δ vs baseline | clips improved |
|---|---:|---:|
| bandpass (DSP control) | −0.016 | 3 / 8 |
| DeepFilterNet, full attenuation | −0.049 | 3 / 8 |
| DeepFilterNet, −20 dB limit | −0.032 | 3 / 8 |
| DeepFilterNet full + bandpass | −0.017 | 3 / 8 |

**Every variant is net negative.** Aggressive DFN is the worst: it turned
`084013 aa77 zid checkin`, perfectly intelligible unprocessed, into
`(unintelligible radio chatter)`. DFN is trained on wideband speech in
environmental noise; 300–3400 Hz radio with heavy static reads as noise to it, and
it attenuates the speech.

The DSP bandpass control matched or beat the AI model in every configuration. On
audio already band-limited by the radio channel, there is little for a learned
model to add.

### One genuine rescue

`093535 aa77 he's descendin` — one of the three clips I could not identify at all —
transcribed as `[unintelligible]` unprocessed, and **every** processed variant
recovered real content:

> "You see that guy at 5 West?" "Yeah." "It's a 757." "Right."

That is Dulles TRACON identifying the inbound as a 757. So targeted processing does
rescue genuinely unreadable audio. It just must not be applied blanket.

### The metric is not trustworthy on its own

`100225 aa77 line 4530 repo` scored **0.885** and **0.921** under the two DFN-full
variants — the two highest scores in the entire experiment — and both produced
`[Inaudible]`. Mean token probability rewards a model that confidently gives up.
Any future evaluation needs word-level comparison against human-verified reference
text, not model confidence.

## Measurement 3 — why did 6.67 hours yield 84 words?

Two 5-minute windows were pulled from the middle of `DRM1_DAT2_Channel_3_MCC_TK`
and transcribed in isolation.

| window | mean volume | raw words | speechnorm | band+speechnorm |
|---|---:|---:|---:|---:|
| t+60 min | −21.5 dB | 30 (`♪♪` only) | 29 (`[Music]`) | 44 (`[Music]`) |
| t+70 min | −17.3 dB | 150 | 117 | 585 |

The t+70 window contains real content — *"Bravo 112… Bravo American 77… that's the
one right there"* — NEADS tracking the aircraft.

**A single 5-minute window yields 150 words. The whole 6.67-hour file yielded 84.**
Chunked transcription outperforms whole-file transcription by more than the entire
file's output. This is not a noise problem; it is a long-file handling problem.

The mechanism is almost certainly the interaction between whisper.cpp's sliding
window over hours of near-silence and the pipeline's own hallucination cleaner:
`transcribe_item_flow` calls `dedupe_consecutive()` to strip repeated cues, which
collapses thousands of consecutive `[Music]` / `[BLANK_AUDIO]` cues down to one,
leaving a nearly-empty SRT that looks like a clean transcription of a quiet tape.

Note also that the 585-word `band+speechnorm` result is *not* four times more
content — it is a repetition loop ("Level one. Level one. Level one…"). Word count
is as untrustworthy as confidence. The 117-word `speechnorm` output reads the most
coherently of the three.

## Conclusions

1. **Chunked transcription with VAD is the high-value fix**, not denoising. It
   addresses 125 files and 76% of the corpus runtime. VAD gating should also cut the
   compute dramatically, since most of those 225.9 hours is silence on an open mic.
2. **Do not apply blanket enhancement.** It is net negative on clips that already
   work, and aggressive settings destroy intelligible speech.
3. **Targeted enhancement is worth having** for clips whose baseline transcript is
   degenerate — a rescue pass, gated on the existing transcript being bad, not a
   corpus-wide rewrite.
4. **Conservative gain staging (`speechnorm`) beats denoising** for readability on
   the quiet position tapes.
5. **Generative enhancement is disqualified** for this archive. Models that
   resynthesize (resemble-enhance, VoiceFixer, diffusion vocoders) can emit fluent
   speech that was never said, and every quality signal — audible clarity, ASR
   confidence, downstream containment checks — moves the *right* way while the
   archive accumulates fabricated words. Masking models only.

## What this means for the product ask

The request had two goals that turn out to be separable:

- **Better transcripts** → chunking + VAD. Enhancement contributes little.
- **Better listening in RadioScanner** → still a valid, independent goal.
  Conservative enhancement plus the original/enhanced toggle stands on its own
  merits as a listening feature, and should be judged that way rather than on ASR
  metrics.

The storage pattern for the toggle already exists: `normalize-item` does
archive-first in-place replacement, with originals preserved under
`audio-original/` (711 of 789 files today). What is missing is exposing that
archived URL on `mp3_items` so the front end can switch.

## Chain decision (2026-08-13)

`render-audition` produced eight AA77 clips through four chains. Chosen by
listening: **`dsp_only`** — bandpass 200–3400 Hz plus `speechnorm`, no model.

This matches what the ASR experiment measured but could not settle on its own.
DeepFilterNet is trained on wideband speech in environmental noise; radio audio is
already band-limited to roughly 300–3400 Hz, so the model reads the speech itself as
noise and attenuates it. At full attenuation it destroyed `084013 aa77 zid checkin`,
a clip that is perfectly intelligible unprocessed, into `(unintelligible radio
chatter)`.

Set as `ENHANCE_CHAIN` in the worker ConfigMap (infra `8e3bab1`). The corpus render
refuses to start while it is unset.

Worth stating plainly, because it is easy to assume otherwise: this choice has **no
effect on transcripts**. Transcription reads `audio/` and never `audio-enhanced/`,
enforced by a test. Enhancement is a listening feature only.
