"""
Tests for FFmpeg encoder and gap filler.

ffmpeg is invoked via subprocess.Popen (so we can stream `-progress pipe:1`
output); ffprobe still uses subprocess.run. Tests mock both at the boundary
and verify argument construction, output-dir layout, no-upscale behavior,
master playlist structure, and the progress-streaming code path.
"""
import json
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

from video_grabber.video.encoder import encode_to_hls, scale_keep_aspect


def _make_fake_popen(
    progress_lines: list[str] | None = None,
    returncode: int = 0,
    stderr_text: str = "",
):
    """Build a fake subprocess.Popen factory that materialises the m3u8
    output file (so encode_to_hls's downstream file checks succeed) and
    streams ``progress_lines`` through its stdout."""
    if progress_lines is None:
        progress_lines = [
            "frame=10\n", "fps=30\n", "out_time_us=10000000\n",
            "speed=1.5x\n", "progress=continue\n",
            "frame=20\n", "progress=end\n",
        ]

    def factory(cmd, **kwargs):
        out_m3u8 = Path(cmd[-1])
        out_m3u8.parent.mkdir(parents=True, exist_ok=True)
        out_m3u8.write_text("#EXTM3U\n#EXT-X-ENDLIST\n")
        (out_m3u8.parent / "init.mp4").write_bytes(b"fakemp4")
        (out_m3u8.parent / "seg0000.m4s").write_bytes(b"fakeseg")

        proc = MagicMock()
        proc.stdout = iter(progress_lines)
        proc.stderr = MagicMock()
        proc.stderr.read.return_value = stderr_text
        proc.returncode = returncode
        proc.wait = MagicMock()
        return proc

    return factory


def fake_ffprobe_success(*args, **kwargs):
    return MagicMock(
        returncode=0,
        stdout=json.dumps({"streams": [{"width": 720, "height": 480}]}).encode(),
    )


def fake_ffprobe_small(*args, **kwargs):
    return MagicMock(
        returncode=0,
        stdout=json.dumps({"streams": [{"width": 320, "height": 240}]}).encode(),
    )


# --- scale_keep_aspect ---

def test_scale_keep_aspect_no_upscale():
    w, h = scale_keep_aspect(320, 240, 854, 480)
    assert w <= 320 and h <= 240


def test_scale_keep_aspect_downscale():
    w, h = scale_keep_aspect(1280, 720, 854, 480)
    assert w <= 854 and h <= 480


def test_scale_keep_aspect_even_dimensions():
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

    with patch("subprocess.Popen", side_effect=_make_fake_popen()), \
         patch("video_grabber.video.encoder._probe", side_effect=fake_ffprobe_success):
        master = encode_to_hls(src, out)

    assert master.name == "master.m3u8"
    assert master.exists()


def test_encode_creates_three_rendition_dirs(tmp_path):
    src = tmp_path / "source.mp4"
    src.write_bytes(b"fake")
    out = tmp_path / "out"

    with patch("subprocess.Popen", side_effect=_make_fake_popen()), \
         patch("video_grabber.video.encoder._probe", side_effect=fake_ffprobe_success):
        encode_to_hls(src, out)

    for rend in ("full", "mid", "thumb"):
        assert (out / rend).is_dir(), f"Missing rendition dir: {rend}"
        assert (out / rend / "index.m3u8").exists()
        assert (out / rend / "init.mp4").exists()


def test_encode_no_upscale_small_source(tmp_path):
    src = tmp_path / "source.mp4"
    src.write_bytes(b"fake")
    out = tmp_path / "out"

    captured_cmds = []
    factory = _make_fake_popen()

    def capture(cmd, **kwargs):
        captured_cmds.append(list(cmd))
        return factory(cmd, **kwargs)

    with patch("subprocess.Popen", side_effect=capture), \
         patch("video_grabber.video.encoder._probe", side_effect=fake_ffprobe_small):
        encode_to_hls(src, out)

    full_cmd = next(
        (c for c in captured_cmds if "/full/index.m3u8" in " ".join(str(a) for a in c)),
        None,
    )
    assert full_cmd is not None
    vf_idx = full_cmd.index("-vf")
    vf_str = full_cmd[vf_idx + 1]
    assert "854" not in vf_str, "Should not upscale 320x240 source to 854 wide"
    assert "scale=" in vf_str


def test_encode_thumb_audio_present(tmp_path):
    src = tmp_path / "source.mp4"
    src.write_bytes(b"fake")
    out = tmp_path / "out"

    captured_cmds = []
    factory = _make_fake_popen()

    def capture(cmd, **kwargs):
        captured_cmds.append(list(cmd))
        return factory(cmd, **kwargs)

    with patch("subprocess.Popen", side_effect=capture), \
         patch("video_grabber.video.encoder._probe", side_effect=fake_ffprobe_success):
        encode_to_hls(src, out)

    thumb_cmd = next(
        (c for c in captured_cmds if "/thumb/index.m3u8" in " ".join(str(a) for a in c)),
        None,
    )
    assert thumb_cmd is not None
    cmd_str = " ".join(str(a) for a in thumb_cmd)
    assert "-c:a" in cmd_str
    assert "-an" not in cmd_str, "Thumb must NOT strip audio (hls.js requires audio in all renditions)"


def test_encode_uses_fmp4_hls_type(tmp_path):
    src = tmp_path / "source.mp4"
    src.write_bytes(b"fake")
    out = tmp_path / "out"

    captured_cmds = []
    factory = _make_fake_popen()

    def capture(cmd, **kwargs):
        captured_cmds.append(list(cmd))
        return factory(cmd, **kwargs)

    with patch("subprocess.Popen", side_effect=capture), \
         patch("video_grabber.video.encoder._probe", side_effect=fake_ffprobe_success):
        encode_to_hls(src, out)

    for cmd in captured_cmds:
        assert "fmp4" in " ".join(str(a) for a in cmd), "All renditions must use fMP4"


def test_encode_master_playlist_has_three_entries(tmp_path):
    src = tmp_path / "source.mp4"
    src.write_bytes(b"fake")
    out = tmp_path / "out"

    with patch("subprocess.Popen", side_effect=_make_fake_popen()), \
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

    fail_factory = _make_fake_popen(returncode=1, stderr_text="ffmpeg blew up")

    with patch("subprocess.Popen", side_effect=fail_factory), \
         patch("video_grabber.video.encoder._probe", side_effect=fake_ffprobe_success):
        with pytest.raises(RuntimeError, match="FFmpeg failed"):
            encode_to_hls(src, out)


# --- progress streaming ---

def test_encode_passes_progress_flags(tmp_path):
    """Every ffmpeg invocation must include -progress pipe:1 so we can stream
    machine-parseable progress events back to the operator."""
    src = tmp_path / "source.mp4"
    src.write_bytes(b"fake")
    out = tmp_path / "out"

    captured_cmds = []
    factory = _make_fake_popen()

    def capture(cmd, **kwargs):
        captured_cmds.append(list(cmd))
        return factory(cmd, **kwargs)

    with patch("subprocess.Popen", side_effect=capture), \
         patch("video_grabber.video.encoder._probe", side_effect=fake_ffprobe_success):
        encode_to_hls(src, out)

    assert len(captured_cmds) == 3
    for cmd in captured_cmds:
        assert "-progress" in cmd
        assert cmd[cmd.index("-progress") + 1] == "pipe:1"
        assert "-nostats" in cmd


def test_encode_logs_progress_at_least_once_per_rendition(tmp_path):
    """The terminal 'progress=end' event must always flush a log line so
    every rendition produces at least one progress entry plus its start/done
    bookends."""
    src = tmp_path / "source.mp4"
    src.write_bytes(b"fake")
    out = tmp_path / "out"

    logger = MagicMock()

    with patch("subprocess.Popen", side_effect=_make_fake_popen()), \
         patch("video_grabber.video.encoder._probe", side_effect=fake_ffprobe_success):
        encode_to_hls(src, out, logger=logger)

    # Render each call's format-string with its args so 'starting rendition %s' + 'full'
    # becomes the literal 'starting rendition full' our substring checks expect.
    rendered = []
    for call in logger.info.call_args_list:
        args = call.args
        if len(args) > 1:
            rendered.append(args[0] % args[1:])
        else:
            rendered.append(args[0])
    joined = " | ".join(rendered)

    assert "starting rendition full" in joined
    assert "starting rendition mid" in joined
    assert "starting rendition thumb" in joined
    # Each rendition's progress=end forces one progress log line.
    assert sum(1 for m in rendered if m.startswith("encode full: t=")) == 1
    assert sum(1 for m in rendered if m.startswith("encode mid: t=")) == 1
    assert sum(1 for m in rendered if m.startswith("encode thumb: t=")) == 1
    assert "rendition full done" in joined
    assert "rendition thumb done" in joined


# --- VAAPI hardware path ---

def test_encode_vaapi_path_when_device_set(tmp_path, monkeypatch):
    """With VAAPI_DEVICE set, renditions encode with h264_vaapi + hwupload."""
    monkeypatch.setenv("VAAPI_DEVICE", "/dev/dri/renderD128")
    src = tmp_path / "source.mp4"
    src.write_bytes(b"fake")
    out = tmp_path / "out"
    captured = []
    factory = _make_fake_popen()

    def capture(cmd, **kwargs):
        captured.append(list(cmd))
        return factory(cmd, **kwargs)

    with patch("subprocess.Popen", side_effect=capture), \
         patch("video_grabber.video.encoder._probe", side_effect=fake_ffprobe_success):
        encode_to_hls(src, out)

    full = next(c for c in captured if "/full/index.m3u8" in " ".join(map(str, c)))
    s = " ".join(map(str, full))
    assert "-vaapi_device /dev/dri/renderD128" in s
    assert "h264_vaapi" in s and "hwupload" in s
    assert "libx264" not in s
    # fMP4 HLS layout unchanged so the stitcher still consumes it
    assert "-hls_segment_type fmp4" in s and "init.mp4" in s


def test_encode_software_path_when_no_device(tmp_path, monkeypatch):
    """Without VAAPI_DEVICE, falls back to libx264 software encode."""
    monkeypatch.delenv("VAAPI_DEVICE", raising=False)
    src = tmp_path / "source.mp4"
    src.write_bytes(b"fake")
    out = tmp_path / "out"
    captured = []
    factory = _make_fake_popen()

    def capture(cmd, **kwargs):
        captured.append(list(cmd))
        return factory(cmd, **kwargs)

    with patch("subprocess.Popen", side_effect=capture), \
         patch("video_grabber.video.encoder._probe", side_effect=fake_ffprobe_success):
        encode_to_hls(src, out)

    s = " ".join(map(str, captured[0]))
    assert "libx264" in s and "h264_vaapi" not in s
