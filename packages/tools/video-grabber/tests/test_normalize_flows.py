from collections import deque
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


class _FakeConn:
    """Stands in for a sqlalchemy Connection; `dead` mimics the server having
    closed the socket (idle_session_timeout). Optional shared `results` deque
    feeds execute(...).first() for the dispatcher claim query."""

    def __init__(self, registry, results=None):
        self.dead = False
        self.executed = []
        self.commits = 0
        self.closed = False
        self._results = results
        registry.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.closed = True
        return False

    def execute(self, stmt, params=None):
        if self.dead:
            raise RuntimeError("server closed the connection unexpectedly")
        self.executed.append((str(stmt), params or {}))
        res = SimpleNamespace(first=lambda: None)
        if self._results is not None:
            res = SimpleNamespace(
                first=lambda: self._results.popleft() if self._results else None
            )
        return res

    def commit(self):
        if self.dead:
            raise RuntimeError("server closed the connection unexpectedly")
        self.commits += 1


def _kill_all(conns):
    """Simulate idle_session_timeout firing during a long stage."""
    for c in conns:
        c.dead = True


def test_dispatch_claims_each_job_on_a_fresh_connection_not_held_across_run_deployment(monkeypatch):
    """_dispatch must not hold its DB connection open across the blocking
    run_deployment call — that connection can be idle-killed
    (idle_session_timeout=10min) while the dispatched flow runs long."""
    rows = deque([SimpleNamespace(id="job-1"), None])
    conns = []

    def blocking_run(*a, **k):
        _kill_all(conns)  # the dispatched job outlives idle_session_timeout

    monkeypatch.setattr(flows, "get_db", lambda: _FakeConn(conns, results=rows))
    monkeypatch.setattr(flows, "run_deployment", blocking_run)
    logger = SimpleNamespace(info=lambda *a: None, warning=lambda *a: None)

    flows._dispatch(
        logger,
        claim_sql="UPDATE normalize_jobs SET stage = 'analyzing' RETURNING id",
        deployment="analyze-normalize-item/analyze-normalize-item",
        label="dispatch-analyze-normalize",
        max_runs=5,
        max_retries=3,
    )

    # two claim attempts (job-1, then empty) each on their own connection,
    # and both survived because the earlier connections were already closed
    # by the time run_deployment killed everything.
    assert len(conns) == 2
    assert all(c.closed for c in conns)
    claims = [s for c in conns for s, _ in c.executed if "UPDATE normalize_jobs" in s]
    assert len(claims) == 2


def test_dispatch_respects_max_runs_cap(monkeypatch):
    rows = deque([SimpleNamespace(id="job-1"), SimpleNamespace(id="job-2"),
                  SimpleNamespace(id="job-3")])
    conns = []
    run_calls = []

    monkeypatch.setattr(flows, "get_db", lambda: _FakeConn(conns, results=rows))
    monkeypatch.setattr(flows, "run_deployment",
                        lambda **kw: run_calls.append(kw))
    logger = SimpleNamespace(info=lambda *a: None, warning=lambda *a: None)

    flows._dispatch(
        logger,
        claim_sql="UPDATE normalize_jobs SET stage = 'analyzing' RETURNING id",
        deployment="analyze-normalize-item/analyze-normalize-item",
        label="dispatch-analyze-normalize",
        max_runs=2,
        max_retries=3,
    )

    assert len(run_calls) == 2


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


# ---- orphan recovery -------------------------------------------------------
#
# A pod roll kills in-flight runs without running their except/finally, leaving
# rows in 'analyzing'/'normalizing'. Neither dispatcher claims those stages, so
# without recovery they are stranded forever. Observed in production: a
# mid-run pod replacement stranded 6 rows in 'analyzing'.


class RecoveryConn:
    def __init__(self, rowcount=0):
        self.rowcount = rowcount
        self.sql = ""
        self.params = {}
        self.commits = 0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, stmt, params=None):
        self.sql = str(stmt)
        self.params = params or {}
        return SimpleNamespace(rowcount=self.rowcount)

    def commit(self):
        self.commits += 1


def test_recover_orphaned_analyzing_goes_back_to_pending(monkeypatch):
    conn = RecoveryConn(rowcount=6)
    monkeypatch.setattr(flows, "get_db", lambda: conn)
    n = flows.recover_orphaned("analyzing", "pending", 30, 3)
    assert n == 6
    assert conn.params["from_stage"] == "analyzing"
    assert conn.params["to_stage"] == "pending"
    assert conn.params["mins"] == 30
    assert conn.commits == 1


def test_recover_orphaned_normalizing_goes_back_to_analyzed(monkeypatch):
    # The measurement survived a normalize crash — only the rewrite must redo,
    # and re-running it is safe because normalize-item is archive-first.
    conn = RecoveryConn(rowcount=2)
    monkeypatch.setattr(flows, "get_db", lambda: conn)
    flows.recover_orphaned("normalizing", "analyzed", 30, 3)
    assert conn.params["from_stage"] == "normalizing"
    assert conn.params["to_stage"] == "analyzed"


def test_recover_orphaned_only_touches_stale_rows(monkeypatch):
    conn = RecoveryConn()
    monkeypatch.setattr(flows, "get_db", lambda: conn)
    flows.recover_orphaned("analyzing", "pending", 30, 3)
    # Guard clause must be present, or a live worker's row gets reclaimed and run twice.
    assert "last_transition_at < now()" in conn.sql
    assert "interval '1 minute'" in conn.sql


def test_recover_orphaned_fails_rows_past_max_retries(monkeypatch):
    conn = RecoveryConn()
    monkeypatch.setattr(flows, "get_db", lambda: conn)
    flows.recover_orphaned("analyzing", "pending", 30, 3)
    assert "retry_count < :max" in conn.sql
    assert "'failed'" in conn.sql
    assert conn.params["max"] == 3


def test_get_db_uses_nullpool_engine_reused_across_calls(monkeypatch):
    # The engine-per-call leak exhausted max_connections at width 6; one shared
    # NullPool engine ties connection count to concurrency, not transition rate.
    created = []

    def fake_create_engine(url, **kw):
        created.append(kw)
        return SimpleNamespace(connect=lambda: "conn")

    monkeypatch.setattr(flows, "_engine", None)
    monkeypatch.setattr(flows.sa, "create_engine", fake_create_engine)
    flows.get_db()
    flows.get_db()
    assert len(created) == 1, "engine must be created once, not per call"
    assert created[0]["poolclass"] is flows.sa.pool.NullPool
