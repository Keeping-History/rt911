import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

import video_grabber.normalize.ffmpeg as nf
from video_grabber.config import Config

FFPROBE_JSON = """\
{"streams": [{"codec_type": "audio", "sample_rate": "22050", "channels": 1}],
 "format": {"duration": "751.05", "bit_rate": "64000"}}
"""

MEASURED = {
    "input_i": "-27.61", "input_tp": "-4.47", "input_lra": "18.06",
    "input_thresh": "-39.20", "target_offset": "0.58",
}

LOUDNORM_STDERR = (
    "noise\n[Parsed_loudnorm_1 @ 0x1]\n"
    '{ "input_i" : "-27.61", "input_tp" : "-4.47", "input_lra" : "18.06",\n'
    '  "input_thresh" : "-39.20", "output_i" : "-16.0", "output_tp" : "-2.0",\n'
    '  "output_lra" : "11.0", "output_thresh" : "-27.0",\n'
    '  "normalization_type" : "dynamic", "target_offset" : "0.58" }\n'
)


def fake_run(capture):
    def _run(cmd, **kw):
        capture.append(cmd)
        out = FFPROBE_JSON if cmd[0] == "ffprobe" else ""
        return SimpleNamespace(returncode=0, stdout=out, stderr=LOUDNORM_STDERR)
    return _run


def test_probe_parses_ffprobe_json(monkeypatch):
    calls = []
    monkeypatch.setattr(subprocess, "run", fake_run(calls))
    info = nf.probe(Path("/tmp/x.mp3"))
    assert info == {"bit_rate": 64000, "sample_rate": 22050, "channels": 1, "duration": 751.05}
    assert calls[0][0] == "ffprobe"


def test_measure_analyze_omits_dynaudnorm(monkeypatch):
    calls = []
    monkeypatch.setattr(subprocess, "run", fake_run(calls))
    d = nf.measure(Path("/tmp/x.mp3"), Config(), with_dynaudnorm=False)
    af = calls[0][calls[0].index("-af") + 1]
    assert af.startswith("loudnorm=")
    assert "dynaudnorm" not in af
    assert "print_format=json" in af
    assert d["input_i"] == "-27.61"


def test_measure_chain_includes_dynaudnorm_first(monkeypatch):
    calls = []
    monkeypatch.setattr(subprocess, "run", fake_run(calls))
    nf.measure(Path("/tmp/x.mp3"), Config(), with_dynaudnorm=True)
    af = calls[0][calls[0].index("-af") + 1]
    assert af.startswith("dynaudnorm,loudnorm=")


def test_render_uses_measured_values_linear_and_source_params(monkeypatch):
    calls = []
    monkeypatch.setattr(subprocess, "run", fake_run(calls))
    out = nf.render(Path("/tmp/x.mp3"), Path("/tmp/out.mp3"), MEASURED,
                    {"bit_rate": 64000, "sample_rate": 22050, "channels": 1}, Config())
    cmd = calls[0]
    af = cmd[cmd.index("-af") + 1]
    assert "measured_I=-27.61" in af and "measured_TP=-4.47" in af
    assert "measured_LRA=18.06" in af and "measured_thresh=-39.20" in af
    assert "offset=0.58" in af and "linear=true" in af
    assert af.startswith("dynaudnorm,loudnorm=")
    assert cmd[cmd.index("-b:a") + 1] == "128k"     # 64k floored
    assert cmd[cmd.index("-ar") + 1] == "22050"
    assert out == Path("/tmp/out.mp3")


def test_measure_raises_on_ffmpeg_failure(monkeypatch):
    def _run(cmd, **kw):
        return SimpleNamespace(returncode=1, stdout="", stderr="boom")
    monkeypatch.setattr(subprocess, "run", _run)
    with pytest.raises(RuntimeError):
        nf.measure(Path("/tmp/x.mp3"), Config(), with_dynaudnorm=False)
