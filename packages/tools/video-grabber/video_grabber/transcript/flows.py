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

import logging

from prefect import flow, get_run_logger
from prefect.exceptions import MissingContextError

from video_grabber.config import Config
from video_grabber.transcribe.srt import parse_srt
from video_grabber.transcript import writer
from video_grabber.transcript.segments import build_segments, to_rows


def _logger():
    # Tests call the flow via `.fn()` to run it synchronously, outside any
    # Prefect flow-run context, where get_run_logger() raises. Fall back to a
    # stdlib logger rather than forcing every test to stub Prefect's logging.
    try:
        return get_run_logger()
    except MissingContextError:
        return logging.getLogger(__name__)


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
    logger = _logger()
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
