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
