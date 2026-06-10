"""
Tests for FFmpeg encoder and gap filler.
subprocess.run is mocked — tests validate argument construction, output dir layout,
no-upscale behavior, and master playlist structure.
"""
import json
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

from video_grabber.video.encoder import encode_to_hls, scale_keep_aspect


def fake_ffmpeg_success(*args, **kwargs):
    """Mock subprocess.run: creates expected output files for each rendition."""
    cmd = args[0]
    # Find the output m3u8 path (last argument)
    out_m3u8 = Path(cmd[-1])
    out_m3u8.parent.mkdir(parents=True, exist_ok=True)
    out_m3u8.write_text("#EXTM3U\n#EXT-X-ENDLIST\n")
    # Create init.mp4 and a segment
    (out_m3u8.parent / "init.mp4").write_bytes(b"fakemp4")
    (out_m3u8.parent / "seg0000.m4s").write_bytes(b"fakeseg")
    return MagicMock(returncode=0, stderr=b"")


def fake_ffprobe_success(*args, **kwargs):
    return MagicMock(
        returncode=0,
        stdout=json.dumps({
            "streams": [{"width": 720, "height": 480}]
        }).encode(),
    )


def fake_ffprobe_small(*args, **kwargs):
    return MagicMock(
        returncode=0,
        stdout=json.dumps({
            "streams": [{"width": 320, "height": 240}]
        }).encode(),
    )


# --- scale_keep_aspect ---

def test_scale_keep_aspect_no_upscale():
    # Source smaller than rung: cap at source
    w, h = scale_keep_aspect(320, 240, 854, 480)
    assert w <= 320 and h <= 240


def test_scale_keep_aspect_downscale():
    # Source larger than rung: scale down
    w, h = scale_keep_aspect(1280, 720, 854, 480)
    assert w <= 854 and h <= 480


def test_scale_keep_aspect_even_dimensions():
    # Output must always be even (H.264 requirement)
    w, h = scale_keep_aspect(321, 241, 854, 480)
    assert w % 2 == 0
    assert h % 2 == 0


def test_scale_keep_aspect_preserves_ratio():
    w, h = scale_keep_aspect(1280, 720, 640, 360)
    ratio_src = 1280 / 720
    ratio_out = w / h
    assert abs(ratio_src - ratio_out) < 0.02


# --- encode_to_hls ---

def test_encode_creates_master_m3u8(tmp_path):
    src = tmp_path / "source.mp4"
    src.write_bytes(b"fake")
    out = tmp_path / "out"

    with patch("subprocess.run", side_effect=fake_ffmpeg_success), \
         patch("video_grabber.video.encoder._probe", side_effect=fake_ffprobe_success):
        master = encode_to_hls(src, out)

    assert master.name == "master.m3u8"
    assert master.exists()


def test_encode_creates_three_rendition_dirs(tmp_path):
    src = tmp_path / "source.mp4"
    src.write_bytes(b"fake")
    out = tmp_path / "out"

    with patch("subprocess.run", side_effect=fake_ffmpeg_success), \
         patch("video_grabber.video.encoder._probe", side_effect=fake_ffprobe_success):
        encode_to_hls(src, out)

    for rend in ("full", "mid", "thumb"):
        assert (out / rend).is_dir(), f"Missing rendition dir: {rend}"
        assert (out / rend / "index.m3u8").exists()
        assert (out / rend / "init.mp4").exists()


def test_encode_no_upscale_small_source(tmp_path):
    """Source at 320x240 must not be upscaled to 854x480 for full rendition."""
    src = tmp_path / "source.mp4"
    src.write_bytes(b"fake")
    out = tmp_path / "out"

    captured_args = []

    def capture_ffmpeg(*args, **kwargs):
        captured_args.append(args[0][:])
        return fake_ffmpeg_success(*args, **kwargs)

    with patch("subprocess.run", side_effect=capture_ffmpeg), \
         patch("video_grabber.video.encoder._probe", side_effect=fake_ffprobe_small):
        encode_to_hls(src, out)

    # Check full rendition ffmpeg call for scale filter
    full_cmd = next(
        (c for c in captured_args if "/full/index.m3u8" in " ".join(str(a) for a in c)),
        None,
    )
    assert full_cmd is not None
    # Find -vf argument
    vf_idx = full_cmd.index("-vf")
    vf_str = full_cmd[vf_idx + 1]
    # Scale target should be <= 320x240
    assert "854" not in vf_str, "Should not upscale 320x240 source to 854 wide"
    assert "320" in vf_str or "scale=" in vf_str


def test_encode_thumb_audio_present(tmp_path):
    """Thumb rendition must include audio flags (not stripped)."""
    src = tmp_path / "source.mp4"
    src.write_bytes(b"fake")
    out = tmp_path / "out"

    captured_args = []

    def capture(*args, **kwargs):
        captured_args.append(args[0][:])
        return fake_ffmpeg_success(*args, **kwargs)

    with patch("subprocess.run", side_effect=capture), \
         patch("video_grabber.video.encoder._probe", side_effect=fake_ffprobe_success):
        encode_to_hls(src, out)

    thumb_cmd = next(
        (c for c in captured_args if "/thumb/index.m3u8" in " ".join(str(a) for a in c)),
        None,
    )
    assert thumb_cmd is not None
    cmd_str = " ".join(str(a) for a in thumb_cmd)
    assert "-c:a" in cmd_str, "Thumb must have audio codec flag"
    assert "-an" not in cmd_str, "Thumb must NOT strip audio"


def test_encode_uses_fmp4_hls_type(tmp_path):
    src = tmp_path / "source.mp4"
    src.write_bytes(b"fake")
    out = tmp_path / "out"

    captured_args = []

    def capture(*args, **kwargs):
        captured_args.append(args[0][:])
        return fake_ffmpeg_success(*args, **kwargs)

    with patch("subprocess.run", side_effect=capture), \
         patch("video_grabber.video.encoder._probe", side_effect=fake_ffprobe_success):
        encode_to_hls(src, out)

    for cmd in captured_args:
        cmd_str = " ".join(str(a) for a in cmd)
        assert "fmp4" in cmd_str, "All renditions must use fMP4 segment type"


def test_encode_master_playlist_has_three_entries(tmp_path):
    src = tmp_path / "source.mp4"
    src.write_bytes(b"fake")
    out = tmp_path / "out"

    with patch("subprocess.run", side_effect=fake_ffmpeg_success), \
         patch("video_grabber.video.encoder._probe", side_effect=fake_ffprobe_success):
        master = encode_to_hls(src, out)

    content = master.read_text()
    assert content.count("EXT-X-STREAM-INF") == 3
    for rend in ("full", "mid", "thumb"):
        assert rend in content


def test_encode_ffmpeg_error_raises(tmp_path):
    src = tmp_path / "source.mp4"
    src.write_bytes(b"fake")
    out = tmp_path / "out"

    with patch("subprocess.run", return_value=MagicMock(returncode=1, stderr=b"error")), \
         patch("video_grabber.video.encoder._probe", side_effect=fake_ffprobe_success):
        with pytest.raises(RuntimeError, match="FFmpeg failed"):
            encode_to_hls(src, out)
