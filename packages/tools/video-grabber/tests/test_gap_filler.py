"""
Tests for blue gap filler generation.
subprocess.run is mocked — tests validate output dir layout and playlist structure.
"""
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

from video_grabber.video.gap_filler import generate_gap_fmp4


def fake_ffmpeg_gap(*args, **kwargs):
    cmd = args[0]
    out_m3u8 = Path(cmd[-1])
    out_m3u8.parent.mkdir(parents=True, exist_ok=True)
    out_m3u8.write_text("#EXTM3U\n#EXT-X-ENDLIST\n")
    (out_m3u8.parent / "init.mp4").write_bytes(b"gapinit")
    (out_m3u8.parent / "seg0000.m4s").write_bytes(b"gapseg")
    return MagicMock(returncode=0)


def test_gap_creates_master_m3u8(tmp_path):
    with patch("subprocess.run", side_effect=fake_ffmpeg_gap):
        master = generate_gap_fmp4(30, tmp_path)
    assert master.name == "master.m3u8"
    assert master.exists()


def test_gap_creates_three_rendition_dirs(tmp_path):
    with patch("subprocess.run", side_effect=fake_ffmpeg_gap):
        generate_gap_fmp4(30, tmp_path)
    for rend in ("full", "mid", "thumb"):
        assert (tmp_path / rend).is_dir()
        assert (tmp_path / rend / "index.m3u8").exists()
        assert (tmp_path / rend / "init.mp4").exists()
        assert (tmp_path / rend / "seg0000.m4s").exists()


def test_gap_uses_blue_color(tmp_path):
    captured = []

    def capture(*args, **kwargs):
        captured.append(args[0][:])
        return fake_ffmpeg_gap(*args, **kwargs)

    with patch("subprocess.run", side_effect=capture):
        generate_gap_fmp4(30, tmp_path)

    for cmd in captured:
        cmd_str = " ".join(str(a) for a in cmd)
        assert "0x0000f5" in cmd_str or "0000f5" in cmd_str, \
            f"Gap filler must use blue #0000f5, cmd: {cmd_str}"


def test_gap_uses_fmp4(tmp_path):
    captured = []

    def capture(*args, **kwargs):
        captured.append(args[0][:])
        return fake_ffmpeg_gap(*args, **kwargs)

    with patch("subprocess.run", side_effect=capture):
        generate_gap_fmp4(30, tmp_path)

    for cmd in captured:
        assert "fmp4" in " ".join(str(a) for a in cmd)


def test_gap_thumb_has_audio(tmp_path):
    captured = []

    def capture(*args, **kwargs):
        captured.append(args[0][:])
        return fake_ffmpeg_gap(*args, **kwargs)

    with patch("subprocess.run", side_effect=capture):
        generate_gap_fmp4(30, tmp_path)

    thumb_cmd = next(
        (c for c in captured if "/thumb/index.m3u8" in " ".join(str(a) for a in c)),
        None,
    )
    assert thumb_cmd is not None
    cmd_str = " ".join(str(a) for a in thumb_cmd)
    assert "-c:a" in cmd_str
    assert "-an" not in cmd_str


def test_gap_master_has_three_streams(tmp_path):
    with patch("subprocess.run", side_effect=fake_ffmpeg_gap):
        master = generate_gap_fmp4(30, tmp_path)
    content = master.read_text()
    assert content.count("EXT-X-STREAM-INF") == 3
