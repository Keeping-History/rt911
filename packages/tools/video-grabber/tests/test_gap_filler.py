"""
Tests for the blue gap-filler package.

subprocess.run is mocked — tests validate the output layout and ffmpeg flags
that the EPG assembler's gap references depend on. The package is a set of
standalone fMP4 segments (no master/index playlist): one canonical 6s segment
plus 1–5s remainders per rendition, sharing a single init.mp4.
"""
from pathlib import Path
from unittest.mock import patch, MagicMock

from video_grabber.video.gap_filler import generate_gap_fmp4, REMAINDER_SECONDS


def fake_ffmpeg_gap(*args, **kwargs):
    """Emulate ffmpeg: write seg0000.m4s + the requested init file into cwd."""
    cmd = args[0]
    cwd = Path(kwargs["cwd"])
    init_name = cmd[cmd.index("-hls_fmp4_init_filename") + 1]
    (cwd / init_name).write_bytes(b"gapinit")
    (cwd / "seg0000.m4s").write_bytes(b"gapseg")
    return MagicMock(returncode=0)


def _capturing(captured):
    def capture(*args, **kwargs):
        captured.append(args[0][:])
        return fake_ffmpeg_gap(*args, **kwargs)
    return capture


def test_gap_creates_three_rendition_dirs(tmp_path):
    with patch("subprocess.run", side_effect=fake_ffmpeg_gap):
        out = generate_gap_fmp4(tmp_path)
    assert out == tmp_path
    for rend in ("full", "mid", "thumb"):
        assert (tmp_path / rend).is_dir()
        assert (tmp_path / rend / "init.mp4").exists()


def test_gap_creates_canonical_and_remainder_segments(tmp_path):
    with patch("subprocess.run", side_effect=fake_ffmpeg_gap):
        generate_gap_fmp4(tmp_path)
    for rend in ("full", "mid", "thumb"):
        assert (tmp_path / rend / "seg_gap_6s.m4s").exists()
        for n in REMAINDER_SECONDS:
            assert (tmp_path / rend / f"seg_gap_{n}s.m4s").exists()


def test_gap_leaves_no_playlist_or_temp_init(tmp_path):
    """The gap package is segments only — no index/master playlist, and the
    throwaway per-segment init copies are cleaned up (one shared init.mp4)."""
    with patch("subprocess.run", side_effect=fake_ffmpeg_gap):
        generate_gap_fmp4(tmp_path)
    for rend in ("full", "mid", "thumb"):
        d = tmp_path / rend
        assert not (d / "index.m3u8").exists()
        assert not (d / "init_tmp.mp4").exists()
        assert not (d / "seg0000.m4s").exists()
    assert not (tmp_path / "master.m3u8").exists()


def test_gap_uses_blue_color(tmp_path):
    captured = []
    with patch("subprocess.run", side_effect=_capturing(captured)):
        generate_gap_fmp4(tmp_path)
    for cmd in captured:
        assert "0x0000f5" in " ".join(str(a) for a in cmd)


def test_gap_uses_fmp4(tmp_path):
    captured = []
    with patch("subprocess.run", side_effect=_capturing(captured)):
        generate_gap_fmp4(tmp_path)
    for cmd in captured:
        assert "fmp4" in " ".join(str(a) for a in cmd)


def test_gap_forces_keyframe_at_frame_zero(tmp_path):
    """Sub-2s segments must start on an IDR to decode independently."""
    captured = []
    with patch("subprocess.run", side_effect=_capturing(captured)):
        generate_gap_fmp4(tmp_path)
    for cmd in captured:
        cmd_str = " ".join(str(a) for a in cmd)
        assert "-force_key_frames" in cmd_str
        assert "eq(n,0)" in cmd_str


def test_gap_thumb_has_audio(tmp_path):
    captured = []
    with patch("subprocess.run", side_effect=_capturing(captured)):
        generate_gap_fmp4(tmp_path)
    thumb_cmds = [c for c in captured if str(c[-1]).endswith("thumb/index.m3u8")]
    assert thumb_cmds
    for cmd in thumb_cmds:
        cmd_str = " ".join(str(a) for a in cmd)
        assert "-c:a" in cmd_str
        assert "-an" not in cmd_str
