from types import SimpleNamespace

import video_grabber.normalize.flows as flows

MEASURED = {
    "input_i": "-27.61", "input_tp": "-4.47", "input_lra": "18.06",
    "input_thresh": "-39.20", "target_offset": "0.58",
}
PROBE = {"bit_rate": 64000, "sample_rate": 22050, "channels": 1, "duration": 751.0}


def _patch_common(monkeypatch, job, transitions, calls):
    monkeypatch.setattr(flows, "get_normalize_job", lambda job_id: job)
    monkeypatch.setattr(
        flows, "transition_normalize_job",
        lambda job_id, to_stage, **kw: transitions.append((to_stage, kw)),
    )
    monkeypatch.setattr(flows, "get_run_logger", lambda: SimpleNamespace(
        info=lambda *a: None, warning=lambda *a: None))
    monkeypatch.setattr(flows.wasabi, "download_file",
                        lambda key, dest, cfg, **kw: calls.append(("download", key)) or dest)
    monkeypatch.setattr(flows.shutil, "rmtree", lambda *a, **kw: None)


def test_analyze_within_tolerance_marks_skipped(monkeypatch):
    transitions, calls = [], []
    job = SimpleNamespace(id="j1", source_key="audio/a.mp3")
    _patch_common(monkeypatch, job, transitions, calls)
    monkeypatch.setattr(flows.nf, "probe", lambda p: PROBE)
    monkeypatch.setattr(flows.nf, "measure", lambda p, cfg, with_dynaudnorm:
                        {**MEASURED, "input_i": "-16.2", "input_tp": "-2.0"})
    flows.analyze_normalize_item_flow.fn("j1")
    assert transitions[0][0] == "analyzing"
    assert transitions[-1][0] == "skipped"
    assert transitions[-1][1]["input_i"] == -16.2


def test_analyze_out_of_tolerance_marks_analyzed(monkeypatch):
    transitions, calls = [], []
    job = SimpleNamespace(id="j1", source_key="audio/a.mp3")
    _patch_common(monkeypatch, job, transitions, calls)
    monkeypatch.setattr(flows.nf, "probe", lambda p: PROBE)
    monkeypatch.setattr(flows.nf, "measure",
                        lambda p, cfg, with_dynaudnorm: MEASURED)
    flows.analyze_normalize_item_flow.fn("j1")
    assert transitions[-1][0] == "analyzed"
    assert transitions[-1][1]["probe"] == PROBE


def test_analyze_failure_records_failed_and_reraises(monkeypatch):
    transitions, calls = [], []
    job = SimpleNamespace(id="j1", source_key="audio/a.mp3")
    _patch_common(monkeypatch, job, transitions, calls)
    monkeypatch.setattr(flows.nf, "probe",
                        lambda p: (_ for _ in ()).throw(RuntimeError("ffprobe died")))
    try:
        flows.analyze_normalize_item_flow.fn("j1")
        raise AssertionError("should have raised")
    except RuntimeError:
        pass
    assert transitions[-1][0] == "failed"
    assert "ffprobe died" in transitions[-1][1]["error"]


def test_normalize_archives_first_and_reads_from_archive(monkeypatch):
    transitions, calls = [], []
    job = SimpleNamespace(id="j1", source_key="audio/a.mp3",
                          probe=PROBE, archive_key=None)
    _patch_common(monkeypatch, job, transitions, calls)
    monkeypatch.setattr(flows.wasabi, "copy_object_if_absent",
                        lambda src, dest, cfg, **kw: calls.append(("archive", src, dest)) or True)
    monkeypatch.setattr(flows.wasabi, "head_object",
                        lambda key, cfg, **kw: {"CacheControl": "max-age=99"})
    monkeypatch.setattr(flows.wasabi, "upload_mp3",
                        lambda path, key, cfg, *, cache_control, **kw:
                        calls.append(("upload", key, cache_control)))
    monkeypatch.setattr(flows.nf, "measure", lambda p, cfg, with_dynaudnorm: MEASURED)
    monkeypatch.setattr(flows.nf, "render",
                        lambda src, dest, m, pi, cfg: calls.append(("render",)) or dest)
    monkeypatch.setattr(flows, "purge_urls",
                        lambda urls, cfg, logger: calls.append(("purge", tuple(urls))) or True)
    flows.normalize_item_flow.fn("j1")
    names = [c[0] for c in calls]
    # archive strictly before any download/upload; upload before purge
    assert names.index("archive") < names.index("download")
    assert names.index("upload") < names.index("purge")
    dl = next(c for c in calls if c[0] == "download")
    assert dl[1] == "audio-original/a.mp3"          # input comes from the archive
    up = next(c for c in calls if c[0] == "upload")
    assert up[1] == "audio/a.mp3" and up[2] == "max-age=99"
    assert transitions[-1][0] == "done"
    assert transitions[0] == ("normalizing", {})


def test_scan_inserts_only_mp3_keys(monkeypatch):
    executed = []

    class FakeDB:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def execute(self, stmt, params=None):
            executed.append(params)
            return SimpleNamespace(rowcount=1)
        def commit(self): pass

    monkeypatch.setattr(flows, "get_db", lambda: FakeDB())
    monkeypatch.setattr(flows, "get_run_logger", lambda: SimpleNamespace(
        info=lambda *a: None, warning=lambda *a: None))
    monkeypatch.setattr(flows.wasabi, "list_keys",
                        lambda prefix, cfg: ["audio/a.mp3", "audio/readme.txt", "audio/b.MP3"])
    flows.scan_normalize_flow.fn()
    keys = [p["sk"] for p in executed if p]
    assert keys == ["audio/a.mp3", "audio/b.MP3"]
