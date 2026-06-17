"""Unit tests for usenet flow DB helpers. Imports prefect (CI-only, like test_flows.py)."""
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
    assert "error_message" not in sql and "message_count" not in sql
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
