"""Unit tests for usenet flow DB helpers. Imports prefect (CI-only, like test_flows.py)."""
import time
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from video_grabber.usenet import flows


class FakeDB:
    """Context-manager connection double; `dead` mimics the server closing the
    socket (rt911-db's idle_session_timeout=10min on the video_grabber DB).
    Optional shared `results` deque feeds execute(...).first() for claims."""

    def __init__(self, registry=None, results=None):
        self.calls = []
        self.commits = 0
        self.dead = False
        self.closed = False
        self._results = results
        if registry is not None:
            registry.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.closed = True
        return False

    def _check(self):
        if self.dead:
            raise RuntimeError("server closed the connection unexpectedly")

    def execute(self, stmt, params=None):
        self._check()
        self.calls.append((str(stmt), params or {}))
        res = MagicMock()
        if self._results is not None:
            # Lazy pop: only a caller that actually calls .first() (the claim
            # query) consumes a row; the reclaim sweep must not eat the queue.
            res.first = lambda: self._results.popleft() if self._results else None
        return res

    def commit(self):
        self._check()
        self.commits += 1


def _stages(conns):
    return [p["stage"] for c in conns for (_, p) in c.calls if "stage" in p]


def test_transition_opens_own_connection_and_sets_stage_only():
    db = FakeDB()
    with patch.object(flows, "get_db", return_value=db):
        flows.transition_usenet_job("j1", "processed")
    sql, params = db.calls[0]
    assert "stage = CAST(:stage AS usenet_stage)" in sql
    assert params["stage"] == "processed" and params["job_id"] == "j1"
    assert "error_message = NULL" in sql       # stale error cleared on a clean transition
    assert ":error" not in sql and "message_count" not in sql
    assert db.commits == 1
    assert db.closed  # short-lived: closed as soon as the transition commits


def test_transition_with_error_and_count():
    db = FakeDB()
    with patch.object(flows, "get_db", return_value=db):
        flows.transition_usenet_job("j1", "failed", error="boom", message_count=42)
    sql, params = db.calls[0]
    assert "error_message = :error" in sql and "message_count = :mc" in sql
    assert params["error"] == "boom" and params["mc"] == 42


def test_get_usenet_job_shapes_namespace_and_closes_connection():
    row = {"id": "j1", "ia_identifier": "usenet-x", "stage": "discovered"}
    fake = MagicMock()
    fake.__enter__.return_value = fake
    fake.execute.return_value.mappings.return_value.fetchone.return_value = row
    with patch.object(flows, "get_db", return_value=fake):
        job = flows.get_usenet_job("j1")
    assert job.ia_identifier == "usenet-x" and job.stage == "discovered"
    assert fake.__exit__.called  # connection not leaked (the pre-fix leak source)


def test_sync_db_url_rewrites_asyncpg():
    assert flows._sync_db_url("postgresql+asyncpg://u:p@h/db") == "postgresql+psycopg2://u:p@h/db"
    assert flows._sync_db_url("postgresql+psycopg2://u:p@h/db") == "postgresql+psycopg2://u:p@h/db"


def test_reclaim_orphaned_requeues_stale_inflight_jobs():
    db = FakeDB()
    flows.reclaim_orphaned_usenet_jobs(db, stale_minutes=10, max_retries=3, logger=None)
    sql, params = db.calls[0]
    # Only in-flight stages, and only when the heartbeat has gone stale.
    assert "stage IN ('downloading', 'downloaded', 'processing')" in sql
    assert "last_transition_at < now() - (:mins * interval '1 minute')" in sql
    # Retry if budget remains, else park in 'failed'; always spend a retry so a
    # perpetually-orphaning job eventually stops.
    assert "CAST('discovered' AS usenet_stage)" in sql
    assert "CAST('failed' AS usenet_stage)" in sql
    assert "retry_count = retry_count + 1" in sql
    assert params == {"max": 3, "mins": 10}
    assert db.commits == 1


class _NoHeartbeat:
    def __init__(self, *a, **k):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _flow_env(monkeypatch, tmp_path, conns):
    monkeypatch.setattr(flows, "get_db", lambda: FakeDB(conns))
    monkeypatch.setattr(flows, "get_usenet_job",
                        lambda jid: SimpleNamespace(id=jid, ia_identifier="usenet-alt.test"))
    monkeypatch.setattr(flows, "_JobHeartbeat", _NoHeartbeat)
    monkeypatch.setattr(flows, "get_run_logger", lambda: MagicMock())
    monkeypatch.setattr(flows, "_SCRATCH", tmp_path)


def _killer(conns, ret=None, raise_exc=None):
    """A long stage during which idle_session_timeout kills every open conn."""
    def _f(*a, **k):
        for c in conns:
            c.dead = True
        if raise_exc is not None:
            raise raise_exc
        return ret
    return _f


def test_process_usenet_item_marks_processed_after_connections_die(monkeypatch, tmp_path):
    conns = []
    _flow_env(monkeypatch, tmp_path, conns)
    monkeypatch.setattr(flows, "download_mbox", _killer(conns, ret=tmp_path / "a.mbox"))
    monkeypatch.setattr(flows, "process_archive", _killer(conns, ret={"alt.test": [1, 2]}))
    monkeypatch.setattr(flows, "write_group", lambda g, r, cfg: (g, len(r)))

    flows.process_usenet_item_flow.fn("j1")

    assert _stages(conns) == ["downloading", "downloaded", "processing", "processed"]
    done = [p for c in conns for (_, p) in c.calls if p.get("stage") == "processed"]
    assert done[0]["mc"] == 2


def test_process_usenet_item_marks_failed_on_fresh_connection(monkeypatch, tmp_path):
    import pytest

    conns = []
    _flow_env(monkeypatch, tmp_path, conns)
    monkeypatch.setattr(flows, "download_mbox",
                        _killer(conns, raise_exc=RuntimeError("mbox download died")))

    with pytest.raises(RuntimeError, match="mbox download died"):
        flows.process_usenet_item_flow.fn("j1")

    assert _stages(conns)[-1] == "failed"


def test_dispatch_usenet_claims_each_job_on_a_fresh_connection(monkeypatch):
    from collections import deque

    rows = deque([SimpleNamespace(id="j1"), None])
    conns = []
    monkeypatch.setattr(flows, "get_db", lambda: FakeDB(conns, results=rows))
    monkeypatch.setattr(flows, "get_run_logger", lambda: MagicMock())
    monkeypatch.setattr(flows, "Config",
                        lambda: SimpleNamespace(usenet_orphan_stale_minutes=10))
    run_dep = MagicMock(side_effect=_killer(conns))  # the run outlives the idle timeout
    monkeypatch.setattr(flows, "run_deployment", run_dep)

    flows.dispatch_usenet_flow.fn(max_runs=5)

    assert run_dep.call_count == 1
    claims = [s for c in conns for s, _ in c.calls if "UPDATE usenet_jobs SET" in s and "stage = 'downloading'" in s]
    assert len(claims) == 2  # both claims survived; second saw an empty queue


def test_job_heartbeat_refreshes_last_transition(monkeypatch):
    """The heartbeat thread bumps last_transition_at for its job while running."""
    calls = []

    class _Ctx:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def execute(self, stmt, params=None):
            calls.append((str(stmt), params))

    class _Engine:
        def begin(self):
            return _Ctx()

        def dispose(self):
            pass

    monkeypatch.setattr(flows.sa, "create_engine", lambda url: _Engine())
    monkeypatch.setattr(flows, "Config", lambda: SimpleNamespace(database_url="postgresql+psycopg2://u:p@h/db"))

    with flows._JobHeartbeat("job-1", interval=0.01, logger=None):
        time.sleep(0.05)

    assert calls, "heartbeat issued no update"
    sql, params = calls[0]
    assert "last_transition_at = now()" in sql
    assert "stage IN" in sql and params == {"id": "job-1"}
