from types import SimpleNamespace
from video_grabber.config import Config
from video_grabber.transcribe.whisper import transcribe_wav


def test_transcribe_wav_builds_whisper_command(tmp_path, monkeypatch):
    monkeypatch.setenv("WHISPER_BIN", "whisper-cli")
    monkeypatch.setenv("WHISPER_MODEL", "/opt/models/ggml-medium.en.bin")
    monkeypatch.setenv("WHISPER_THREADS", "8")
    cfg = Config()
    seen = {}
    def fake_runner(cmd, **kw):
        seen["cmd"] = cmd
        return SimpleNamespace(returncode=0, stderr="")
    wav = tmp_path / "in.wav"
    out_base = tmp_path / "out"
    srt = transcribe_wav(wav, out_base, cfg, runner=fake_runner)
    cmd = seen["cmd"]
    assert cmd[0] == "whisper-cli"
    assert "-m" in cmd and cmd[cmd.index("-m") + 1] == "/opt/models/ggml-medium.en.bin"
    assert "-t" in cmd and cmd[cmd.index("-t") + 1] == "8"
    assert "--output-srt" in cmd and "--output-vtt" in cmd
    assert "--output-file" in cmd and cmd[cmd.index("--output-file") + 1] == str(out_base)
    assert str(wav) in cmd
    assert srt == out_base.with_suffix(".srt")


def test_transcribe_wav_raises_on_failure(tmp_path):
    cfg = Config()
    def fake_runner(cmd, **kw):
        return SimpleNamespace(returncode=2, stderr="vulkan: device lost")
    try:
        transcribe_wav(tmp_path / "in.wav", tmp_path / "out", cfg, runner=fake_runner)
    except RuntimeError as e:
        assert "vulkan" in str(e)
    else:
        raise AssertionError("expected RuntimeError")
