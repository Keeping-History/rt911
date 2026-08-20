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
