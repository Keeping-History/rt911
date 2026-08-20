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


def _cfg():
    return SimpleNamespace(whisper_bin="whisper-cli", whisper_model="/m.bin",
                           whisper_threads=4, vad_model="/vad.bin")


def _capture(tmp_path, **kw):
    seen = {}

    def runner(cmd, **_):
        seen["cmd"] = cmd
        return SimpleNamespace(returncode=0, stderr="")

    transcribe_wav(tmp_path / "a.wav", tmp_path / "out", _cfg(), runner=runner, **kw)
    return seen["cmd"]


def test_vad_flags_are_passed_when_enabled(tmp_path):
    cmd = _capture(tmp_path, vad=True)
    assert "--vad" in cmd
    assert cmd[cmd.index("--vad-model") + 1] == "/vad.bin"


def test_window_flags_are_passed(tmp_path):
    cmd = _capture(tmp_path, offset_ms=600000, duration_ms=600000)
    assert cmd[cmd.index("-ot") + 1] == "600000"
    assert cmd[cmd.index("-d") + 1] == "600000"


def test_no_window_flags_when_transcribing_whole_file(tmp_path):
    cmd = _capture(tmp_path)
    assert "-ot" not in cmd and "--vad" not in cmd


def test_wav_path_stays_last_so_flags_are_never_swallowed(tmp_path):
    cmd = _capture(tmp_path, vad=True, offset_ms=1000, duration_ms=2000)
    assert cmd[-1].endswith("a.wav")
