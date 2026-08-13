"""Render enhanced audio. Audition first, corpus second.

Writes only to audio-enhanced/ and only to mp3_items.enhanced_url. `url` is never
touched: it is the join key for patch_mp3_subtitles, link_mp3_subtitles_flow and
backfill_mp3_catalogue_flow, and repointing it would break all three -- the last
of them by silently creating a duplicate row for every file in the bucket.
"""
import subprocess
import tempfile
from pathlib import Path

import httpx
from prefect import flow, get_run_logger

from video_grabber.catalogue.flows import _page_mp3_items
from video_grabber.config import Config
from video_grabber.directus.writer import _auth_headers, wasabi_public_url
from video_grabber.enhance.chains import CHAINS, audition_key, enhanced_key
from video_grabber.storage import wasabi

# Eight clips spanning the failure modes: three that transcribed badly, three
# mid-quality, two clean controls. The same set used in the findings experiment,
# so the audition is comparable to the measurements already recorded.
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


def _run(cmd: list[str]) -> None:
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed ({r.returncode}): {r.stderr[-600:]}")


def render_one(audio_key: str, chain_name: str, cfg: Config, dest_key: str) -> str:
    """Render one file through one chain and upload it to dest_key."""
    chain = CHAINS[chain_name]
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        src = d / "src.mp3"
        wasabi.download_file(audio_key, src, cfg)

        # DeepFilterNet operates at 48 kHz; stage there even for the DSP-only
        # chain so every variant differs by filtering alone, not resampling.
        stage = d / "stage.wav"
        cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(src)]
        if chain.ffmpeg_pre:
            cmd += ["-af", chain.ffmpeg_pre]
        cmd += ["-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", str(stage)]
        _run(cmd)

        current = stage
        if chain.dfn_atten is not None:
            outdir = d / "dfn"
            outdir.mkdir()
            dfn = [cfg.deep_filter_bin, "-D", "-o", str(outdir), str(stage)]
            if chain.dfn_atten < 100:
                dfn += ["-a", str(chain.dfn_atten)]
            _run(dfn)
            produced = sorted(outdir.glob("*.wav"))
            if not produced:
                raise RuntimeError(f"deep-filter produced nothing for {audio_key!r}")
            current = produced[0]

        final = d / "final.mp3"
        cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(current)]
        if chain.ffmpeg_post:
            cmd += ["-af", chain.ffmpeg_post]
        cmd += ["-c:a", "libmp3lame", "-b:a", "128k", str(final)]
        _run(cmd)

        wasabi.upload_mp3(final, dest_key, cfg, cache_control="max-age=31536000")
    return dest_key


@flow(name="render-audition")
def render_audition_flow(keys: list[str] | None = None) -> None:
    """Render the audition set through every chain, for a human to listen to.

    ASR metrics cannot answer whether enhanced audio *sounds* better, so the
    chain is chosen by ear. This flow only produces the candidates.
    """
    logger = get_run_logger()
    cfg = Config()
    clips = keys or AUDITION_CLIPS
    for key in clips:
        logger.info("original: %s", wasabi_public_url(key))
        for chain_name in CHAINS:
            dest = audition_key(key, chain_name)
            try:
                render_one(key, chain_name, cfg, dest)
            except Exception as exc:  # noqa: BLE001 - one bad chain must not stop the set
                logger.warning("audition %s/%s failed: %s", chain_name, key, exc)
                continue
            logger.info("  %-14s %s", chain_name, wasabi_public_url(dest))


@flow(name="render-enhanced-corpus")
def render_enhanced_corpus_flow(dry_run: bool = True, limit: int | None = None) -> None:
    """Render every audio/ mp3 through the chosen chain and record the render.

    Writes only mp3_items.enhanced_url. Idempotent: re-running overwrites it
    with the same value.
    """
    logger = get_run_logger()
    cfg = Config()
    if not cfg.enhance_chain:
        raise RuntimeError(
            "ENHANCE_CHAIN is unset. Choose a chain by listening to the audition "
            "output (render-audition) before running the corpus render."
        )
    if cfg.enhance_chain not in CHAINS:
        raise RuntimeError(
            f"unknown ENHANCE_CHAIN {cfg.enhance_chain!r}; known: {sorted(CHAINS)}"
        )

    by_url = {row["url"]: row["id"] for row in _page_mp3_items(cfg, "id,url")
              if row.get("url")}
    keys = [k for k in wasabi.list_keys("audio/", cfg) if k.lower().endswith(".mp3")]

    done = unlinked = 0
    for key in keys:
        if limit is not None and done >= limit:
            break
        dest = enhanced_key(key)
        if dry_run:
            logger.info("DRY RUN would render %s -> %s", key, dest)
            done += 1
            continue

        render_one(key, cfg.enhance_chain, cfg, dest)

        item_id = by_url.get(wasabi_public_url(key))
        if item_id is None:
            logger.warning("no mp3_items row for %s; rendered but not linked", key)
            unlinked += 1
            done += 1
            continue
        pr = httpx.patch(f"{cfg.directus_url}/items/mp3_items/{item_id}",
                         json={"enhanced_url": wasabi_public_url(dest)},
                         headers=_auth_headers(cfg))
        pr.raise_for_status()
        done += 1
    logger.info("render-enhanced-corpus: %d files (%s), %d unlinked",
                done, "dry run" if dry_run else cfg.enhance_chain, unlinked)
