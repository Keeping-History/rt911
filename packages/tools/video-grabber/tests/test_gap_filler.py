"""
Tests for the sequenced blue gap pool.

subprocess.run is mocked — tests validate the output layout and ffmpeg flags
the EPG assembler's gap references depend on. The pool is one continuous blue
encode per rendition (seg0000.m4s, seg0001.m4s, … sharing a single init.mp4) so
each tile carries an increasing fMP4 sequence_number/tfdt.
"""
from pathlib import Path
from unittest.mock import patch, MagicMock

from video_grabber.video.gap_filler import generate_gap_pool, POOL_TILES, TILE_SECONDS


def fake_ffmpeg_pool(*args, **kwargs):
    """Emulate ffmpeg's HLS muxer: write init.mp4 + seg0000..segN-1 into cwd."""
    cmd = args[0]
    cwd = Path(kwargs["cwd"])
    init_name = cmd[cmd.index("-hls_fmp4_init_filename") + 1]
    (cwd / init_name).write_bytes(b"gapinit")
    # Pool size is encoded as the -t duration / TILE_SECONDS.
    seconds = int(cmd[cmd.index("-t") + 1])
    for i in range(seconds // TILE_SECONDS):
        (cwd / f"seg{i:04d}.m4s").write_bytes(b"gapseg")
    (cwd / "index.m3u8").write_text("#EXTM3U\n")
    return MagicMock(returncode=0)


def _capturing(captured):
    def capture(*args, **kwargs):
        captured.append(args[0][:])
        return fake_ffmpeg_pool(*args, **kwargs)
    return capture


def test_pool_creates_three_rendition_dirs(tmp_path):
    with patch("subprocess.run", side_effect=fake_ffmpeg_pool):
        n = generate_gap_pool(tmp_path, pool_tiles=10)
    assert n == 10
    for rend in ("full", "mid", "thumb"):
        assert (tmp_path / rend / "init.mp4").exists()


def test_pool_creates_sequenced_segments(tmp_path):
    with patch("subprocess.run", side_effect=fake_ffmpeg_pool):
        generate_gap_pool(tmp_path, pool_tiles=10)
    for rend in ("full", "mid", "thumb"):
        # Tiles are referenced by index (seg0000 … seg0009), in order.
        assert (tmp_path / rend / "seg0000.m4s").exists()
        assert (tmp_path / rend / "seg0009.m4s").exists()


def test_pool_leaves_no_index_playlist(tmp_path):
    """The pool is segments only — the throwaway index.m3u8 is removed."""
    with patch("subprocess.run", side_effect=fake_ffmpeg_pool):
        generate_gap_pool(tmp_path, pool_tiles=10)
    for rend in ("full", "mid", "thumb"):
        assert not (tmp_path / rend / "index.m3u8").exists()


def test_pool_encodes_blue_clean_30fps(tmp_path):
    captured = []
    with patch("subprocess.run", side_effect=_capturing(captured)):
        generate_gap_pool(tmp_path, pool_tiles=10)
    for cmd in captured:
        s = " ".join(str(a) for a in cmd)
        assert "0x0000f5" in s          # blue
        assert "rate=30" in s           # exact frame timing
        assert "-bf 0" in s             # no B-frame reorder
        assert "fmp4" in s


def test_pool_default_size(tmp_path):
    with patch("subprocess.run", side_effect=fake_ffmpeg_pool):
        n = generate_gap_pool(tmp_path)
    assert n == POOL_TILES


def test_pool_thumb_has_audio(tmp_path):
    captured = []
    with patch("subprocess.run", side_effect=_capturing(captured)):
        generate_gap_pool(tmp_path, pool_tiles=10)
    thumb_cmds = [c for c in captured if str(c[-1]).endswith("thumb/index.m3u8")]
    assert thumb_cmds
    for cmd in thumb_cmds:
        s = " ".join(str(a) for a in cmd)
        assert "-c:a" in s
        assert "-an" not in s
