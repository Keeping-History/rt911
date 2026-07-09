"""Unit tests for usenet flow DB helpers. Imports prefect (CI-only, like test_flows.py)."""
import time
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from video_grabber.usenet import flows


class FakeDB:
    def __init__(self):
        self.calls = []
        self.commits = 0

    def execute(self, stmt, params=None):
        self.calls.append((str(stmt), params or {}))
        return MagicMock()

    def commit(self):
        self.commits += 1


def test_transition_sets_stage_only():
    db = FakeDB()
    flows.transition_usenet_job(db, "j1", "processed")
    sql, params = db.calls[0]
    assert "stage = CAST(:stage AS usenet_stage)" in sql
    assert params["stage"] == "processed" and params["job_id"] == "j1"
    assert "error_message = NULL" in sql       # stale error cleared on a clean transition
    assert ":error" not in sql and "message_count" not in sql
    assert db.commits == 1


def test_transition_with_error_and_count():
    db = FakeDB()
    flows.transition_usenet_job(db, "j1", "failed", error="boom", message_count=42)
    sql, params = db.calls[0]
    assert "error_message = :error" in sql and "message_count = :mc" in sql
    assert params["error"] == "boom" and params["mc"] == 42


def test_get_usenet_job_shapes_namespace():
    row = {"id": "j1", "ia_identifier": "usenet-x", "stage": "discovered"}
    fake = MagicMock()
    fake.execute.return_value.mappings.return_value.fetchone.return_value = row
    with patch.object(flows, "get_db", return_value=fake):
        job = flows.get_usenet_job("j1")
    assert job.ia_identifier == "usenet-x" and job.stage == "discovered"


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
