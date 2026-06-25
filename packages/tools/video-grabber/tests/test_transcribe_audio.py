from types import SimpleNamespace
from video_grabber.transcribe.audio import extract_audio


def test_extract_audio_builds_16k_mono_wav_command(tmp_path):
    calls = {}
    def fake_runner(cmd, **kw):
        calls["cmd"] = cmd
        return SimpleNamespace(returncode=0, stderr="")
    out = tmp_path / "a.wav"
    extract_audio("https://files.911realtime.org/audio/x.mp3", out, runner=fake_runner)
    cmd = calls["cmd"]
    assert cmd[0] == "ffmpeg"
    assert "-ar" in cmd and cmd[cmd.index("-ar") + 1] == "16000"
    assert "-ac" in cmd and cmd[cmd.index("-ac") + 1] == "1"
    assert str(out) == cmd[-1]
    assert "https://files.911realtime.org/audio/x.mp3" in cmd


def test_extract_audio_raises_on_failure(tmp_path):
    def fake_runner(cmd, **kw):
        return SimpleNamespace(returncode=1, stderr="boom")
    try:
        extract_audio("u", tmp_path / "a.wav", runner=fake_runner)
    except RuntimeError as e:
        assert "boom" in str(e)
    else:
        raise AssertionError("expected RuntimeError")
