"""
Tests for Prefect flow orchestration.
Uses @task/@flow directly with mocked pipeline components — no real Prefect server needed.
"""
import pytest
from unittest.mock import MagicMock, patch


# --- _sync_db_url ---

def test_sync_db_url_rewrites_asyncpg_to_psycopg2():
    from video_grabber.pipeline.flows import _sync_db_url

    rewritten = _sync_db_url("postgresql+asyncpg://u:p@h:5432/db")
    assert rewritten == "postgresql+psycopg2://u:p@h:5432/db"


def test_sync_db_url_passes_through_plain_postgresql():
    from video_grabber.pipeline.flows import _sync_db_url

    assert _sync_db_url("postgresql://u:p@h/db") == "postgresql://u:p@h/db"


def test_sync_db_url_passes_through_explicit_psycopg2():
    from video_grabber.pipeline.flows import _sync_db_url

    url = "postgresql+psycopg2://u:p@h/db"
    assert _sync_db_url(url) == url


# --- get_job ---

def _mock_db_returning(mapping):
    """Build a MagicMock db whose execute(...).mappings().fetchone() yields `mapping`."""
    db = MagicMock()
    db.__enter__.return_value = db  # sqlalchemy Connection context manager returns self
    db.execute.return_value.mappings.return_value.fetchone.return_value = mapping
    return db


def test_get_job_flattens_channel_and_program_into_namespaces():
    from video_grabber.pipeline.flows import get_job
    from datetime import datetime, timezone

    row = {
        "id": "job-001",
        "ia_identifier": "cnn-sep11-0800",
        "stage": "uploading",
        "channel_id": "chan-1",
        "program_id": "prog-1",
        "channel_slug": "cnn",
        "channel_display_name": "CNN",
        "channel_timezone": "America/New_York",
        "program_title": "Live Coverage",
        "program_description": "Broadcast",
        "program_air_date": datetime(2001, 9, 11, 12, 0, tzinfo=timezone.utc),
        "program_duration_seconds": 3600,
        "passed_through_review": False,
    }

    with patch("video_grabber.pipeline.flows.get_db", return_value=_mock_db_returning(row)):
        job = get_job("job-001")

    # Nested relationship objects the downstream stages dereference.
    assert job.channel.slug == "cnn"
    assert job.channel.timezone == "America/New_York"
    assert job.program.title == "Live Coverage"
    assert job.program.duration_seconds == 3600
    # Flat video_jobs columns remain at the top level.
    assert job.ia_identifier == "cnn-sep11-0800"
    assert job.id == "job-001"
    assert job.passed_through_review is False
    # Aliased columns must not leak onto the top-level object.
    assert not hasattr(job, "channel_slug")
    assert not hasattr(job, "program_title")


def test_get_job_raises_when_row_missing():
    from video_grabber.pipeline.flows import get_job

    with patch("video_grabber.pipeline.flows.get_db", return_value=_mock_db_returning(None)):
        with pytest.raises(ValueError, match="not found"):
            get_job("nope")


# --- transition_job / per-transition DB connections -------------------------
#
# rt911-db sets idle_session_timeout=10min on the video_grabber database (leak
# protection), but download/encode can hold process-item for far longer, and
# dispatch blocks on run_deployment for the whole job. Any connection opened
# before a long stage is dead afterwards — so every DB touch must open its own
# fresh connection (same fix as transcribe-item, PR #189).


class FakeConn:
    """Stands in for a sqlalchemy Connection; `dead` mimics the server having
    closed the socket (idle_session_timeout). Optional shared `results` deque
    feeds execute(...).first() for dispatcher claim queries."""

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

    def _check(self):
        if self.dead:
            raise RuntimeError("server closed the connection unexpectedly")

    def execute(self, stmt, params=None):
        self._check()
        self.executed.append((str(stmt), params or {}))
        res = MagicMock()
        if self._results is not None:
            # Lazy pop: only a caller that actually calls .first() (the claim
            # query) consumes a row; other queries must not eat the queue.
            res.first = lambda: self._results.popleft() if self._results else None
        return res

    def commit(self):
        self._check()
        self.commits += 1


def _stages(conns):
    return [p["stage"] for c in conns for (_, p) in c.executed if "stage" in p]


def _kill_all(conns):
    """Simulate idle_session_timeout firing during a long stage."""
    for c in conns:
        c.dead = True


def test_transition_job_opens_and_closes_its_own_connection():
    from video_grabber.pipeline import flows

    conns = []
    with patch.object(flows, "get_db", lambda: FakeConn(conns)):
        flows.transition_job("job-id-001", "downloading", from_stage="discovered")

    assert len(conns) == 1
    sqls = " ".join(s for s, _ in conns[0].executed)
    assert "UPDATE video_jobs" in sqls
    assert "INSERT INTO pipeline_transitions" in sqls
    assert conns[0].commits == 1
    assert conns[0].closed


def test_get_job_closes_its_connection():
    from video_grabber.pipeline.flows import get_job

    db = _mock_db_returning(None)
    with patch("video_grabber.pipeline.flows.get_db", return_value=db):
        with pytest.raises(ValueError, match="not found"):
            get_job("nope")
    assert db.__exit__.called


def test_process_item_flow_completes_after_connections_die_during_long_stages():
    from video_grabber.pipeline import flows

    job = MagicMock(id="job-001", ia_identifier="cnn-sep11-0800", stage="discovered")
    conns = []

    def slow_stage(*a, **k):
        _kill_all(conns)
        return MagicMock()

    with patch.object(flows, "get_db", lambda: FakeConn(conns)), \
         patch("video_grabber.pipeline.flows.get_job", return_value=job), \
         patch("video_grabber.pipeline.flows.download_item", side_effect=slow_stage), \
         patch("video_grabber.pipeline.flows.resolve_job", return_value=job), \
         patch("video_grabber.pipeline.flows.encode_to_hls", side_effect=slow_stage), \
         patch("video_grabber.pipeline.flows.upload_hls_package", return_value="some/key"), \
         patch("video_grabber.pipeline.flows.write_media_item"), \
         patch("video_grabber.pipeline.flows.shutil.rmtree"), \
         patch("video_grabber.pipeline.flows.get_run_logger", return_value=MagicMock()):
        flows.process_item_flow.fn("job-001")

    stages = _stages(conns)
    assert stages[0] == "downloading"
    assert stages[-1] == "complete"


def test_process_item_flow_marks_failed_on_fresh_connection():
    from video_grabber.pipeline import flows

    job = MagicMock(id="job-001", ia_identifier="cnn-sep11-0800", stage="discovered")
    conns = []

    def dying_download(*a, **k):
        _kill_all(conns)
        raise Exception("download fail")

    with patch.object(flows, "get_db", lambda: FakeConn(conns)), \
         patch("video_grabber.pipeline.flows.get_job", return_value=job), \
         patch("video_grabber.pipeline.flows.download_item", side_effect=dying_download), \
         patch("video_grabber.pipeline.flows.shutil.rmtree"), \
         patch("video_grabber.pipeline.flows.get_run_logger", return_value=MagicMock()):
        with pytest.raises(Exception, match="download fail"):
            flows.process_item_flow.fn("job-001")

    assert _stages(conns)[-1] == "failed"


def test_dispatch_discovered_claims_each_job_on_a_fresh_connection():
    from collections import deque
    from types import SimpleNamespace
    from video_grabber.pipeline import flows

    rows = deque([SimpleNamespace(id="job-1"), None])
    conns = []

    def blocking_run(*a, **k):
        _kill_all(conns)  # the dispatched job outlives idle_session_timeout

    with patch.object(flows, "get_db", lambda: FakeConn(conns, results=rows)), \
         patch("video_grabber.pipeline.flows.run_deployment", side_effect=blocking_run) as mock_run, \
         patch("video_grabber.pipeline.flows.get_run_logger", return_value=MagicMock()):
        flows.dispatch_discovered_flow.fn(max_runs=5)

    assert mock_run.call_count == 1
    claims = [s for c in conns for s, _ in c.executed if "UPDATE video_jobs" in s]
    assert len(claims) == 2  # both claim attempts survived, second returned empty


# --- scan_collections_flow ---

def test_scan_collections_flow_calls_crawl_for_each_collection():
    from video_grabber.pipeline.flows import scan_collections_flow

    with patch("video_grabber.pipeline.flows.crawl_collection") as mock_crawl, \
         patch("video_grabber.pipeline.flows.IASearch") as mock_session_cls, \
         patch("video_grabber.pipeline.flows.get_db") as mock_db, \
         patch("video_grabber.pipeline.flows.get_run_logger", return_value=MagicMock()):

        mock_session = MagicMock()
        mock_session_cls.return_value = mock_session
        mock_db.return_value = MagicMock()

        scan_collections_flow.fn(collections=["col_a", "col_b"])

    assert mock_crawl.call_count == 2
    call_identifiers = [c[0][1] for c in mock_crawl.call_args_list]
    assert "col_a" in call_identifiers
    assert "col_b" in call_identifiers


# --- process_item_flow: state transitions ---

def test_process_item_retry_delay_is_scalar():
    # The Prefect server stores a flow's retry delay in
    # empirical_policy.retry_delay, which only accepts an int for flows — a list
    # (valid for tasks) 422s at run init and crashes every run. Guard against a
    # regression to the list form.
    from video_grabber.pipeline.flows import process_item_flow

    assert isinstance(process_item_flow.retry_delay_seconds, (int, float))


def test_process_item_flow_transitions_to_complete_on_success():
    from video_grabber.pipeline.flows import process_item_flow

    job = MagicMock()
    job.id = "job-001"
    job.ia_identifier = "cnn-sep11-0800"

    with patch("video_grabber.pipeline.flows.get_job", return_value=job), \
         patch("video_grabber.pipeline.flows.get_db"), \
         patch("video_grabber.pipeline.flows.download_item") as mock_dl, \
         patch("video_grabber.pipeline.flows.resolve_job", return_value=job), \
         patch("video_grabber.pipeline.flows.encode_to_hls") as mock_enc, \
         patch("video_grabber.pipeline.flows.upload_hls_package") as mock_up, \
         patch("video_grabber.pipeline.flows.write_media_item"), \
         patch("video_grabber.pipeline.flows.transition_job") as mock_trans, \
         patch("video_grabber.pipeline.flows.get_run_logger", return_value=MagicMock()):

        mock_dl.return_value = MagicMock()
        mock_enc.return_value = MagicMock()
        mock_up.return_value = "hls/cnn/20010911/cnn-sep11-0800/master.m3u8"

        process_item_flow.fn("job-001")

    stages = [c[0][1] for c in mock_trans.call_args_list]  # transition_job(job_id, to_stage, ...)
    assert "complete" in stages


def test_process_item_flow_transitions_to_failed_on_download_error():
    from video_grabber.pipeline.flows import process_item_flow

    job = MagicMock()
    job.id = "job-001"
    job.ia_identifier = "cnn-sep11-0800"

    with patch("video_grabber.pipeline.flows.get_job", return_value=job), \
         patch("video_grabber.pipeline.flows.get_db"), \
         patch("video_grabber.pipeline.flows.download_item", side_effect=Exception("download fail")), \
         patch("video_grabber.pipeline.flows.transition_job") as mock_trans, \
         patch("video_grabber.pipeline.flows.get_run_logger", return_value=MagicMock()):

        with pytest.raises(Exception, match="download fail"):
            process_item_flow.fn("job-001")

    stages = [c[0][1] for c in mock_trans.call_args_list]  # transition_job(job_id, to_stage, ...)
    assert "failed" in stages


def test_process_item_flow_cleans_scratch_on_success():
    from video_grabber.pipeline import flows

    job = MagicMock(id="job-001", ia_identifier="cnn-sep11-0800")
    with patch("video_grabber.pipeline.flows.get_job", return_value=job), \
         patch("video_grabber.pipeline.flows.get_db"), \
         patch("video_grabber.pipeline.flows.download_item", return_value=MagicMock()), \
         patch("video_grabber.pipeline.flows.resolve_job", return_value=job), \
         patch("video_grabber.pipeline.flows.encode_to_hls", return_value=MagicMock()), \
         patch("video_grabber.pipeline.flows.upload_hls_package", return_value="k"), \
         patch("video_grabber.pipeline.flows.write_media_item"), \
         patch("video_grabber.pipeline.flows.transition_job"), \
         patch("video_grabber.pipeline.flows.shutil.rmtree") as mock_rm, \
         patch("video_grabber.pipeline.flows.get_run_logger", return_value=MagicMock()):
        flows.process_item_flow.fn("job-001")

    assert mock_rm.called
    assert str(mock_rm.call_args[0][0]).endswith("cnn-sep11-0800")


def test_process_item_flow_cleans_scratch_on_failure():
    from video_grabber.pipeline import flows

    job = MagicMock(id="job-001", ia_identifier="cnn-sep11-0800")
    with patch("video_grabber.pipeline.flows.get_job", return_value=job), \
         patch("video_grabber.pipeline.flows.get_db"), \
         patch("video_grabber.pipeline.flows.download_item", side_effect=Exception("boom")), \
         patch("video_grabber.pipeline.flows.transition_job"), \
         patch("video_grabber.pipeline.flows.shutil.rmtree") as mock_rm, \
         patch("video_grabber.pipeline.flows.get_run_logger", return_value=MagicMock()):
        with pytest.raises(Exception, match="boom"):
            flows.process_item_flow.fn("job-001")

    assert mock_rm.called  # scratch reclaimed even when the job fails


def test_process_item_flow_transitions_through_all_stages():
    from video_grabber.pipeline.flows import process_item_flow

    job = MagicMock()
    job.id = "job-001"
    job.ia_identifier = "cnn-sep11-0800"

    with patch("video_grabber.pipeline.flows.get_job", return_value=job), \
         patch("video_grabber.pipeline.flows.get_db"), \
         patch("video_grabber.pipeline.flows.download_item", return_value=MagicMock()), \
         patch("video_grabber.pipeline.flows.resolve_job", return_value=job), \
         patch("video_grabber.pipeline.flows.encode_to_hls", return_value=MagicMock()), \
         patch("video_grabber.pipeline.flows.upload_hls_package", return_value="some/key"), \
         patch("video_grabber.pipeline.flows.write_media_item"), \
         patch("video_grabber.pipeline.flows.transition_job") as mock_trans, \
         patch("video_grabber.pipeline.flows.get_run_logger", return_value=MagicMock()):

        process_item_flow.fn("job-001")

    stages = [c[0][1] for c in mock_trans.call_args_list]  # transition_job(job_id, to_stage, ...)
    assert "downloading" in stages
    assert "downloaded" in stages
    assert "encoding" in stages
    assert "encoded" in stages
    assert "uploading" in stages
    assert "complete" in stages


# --- dispatch_discovered_flow ---

def test_requeue_pending_review_promotes_only_resolvable_jobs():
    from video_grabber.pipeline.flows import requeue_pending_review_flow

    rows = [
        # Resolves via identifier-prefix fallback.
        {"id": "j1", "ia_identifier": "ANT1_20010914_010000_x",
         "ia_metadata": {"identifier": "ANT1_20010914_010000_x", "title": "Antenna 1 Greece"}},
        # No leading-letter prefix and no network in fields -> stays parked.
        {"id": "j2", "ia_identifier": "20010911_0900_x",
         "ia_metadata": {"identifier": "20010911_0900_x", "title": ""}},
    ]
    db = MagicMock()
    db.__enter__.return_value = db
    db.execute.return_value.mappings.return_value.all.return_value = rows

    with patch("video_grabber.pipeline.flows.get_db", return_value=db), \
         patch("video_grabber.pipeline.flows.get_run_logger", return_value=MagicMock()):
        result = requeue_pending_review_flow.fn(dry_run=False)

    assert result == {"promoted": 1, "evaluated": 2}
    sql = " ".join(c.args[0].text for c in db.execute.call_args_list if c.args)
    assert "UPDATE video_jobs SET stage = 'discovered'" in sql
    assert "INSERT INTO pipeline_transitions" in sql


def test_requeue_pending_review_dry_run_makes_no_changes():
    from video_grabber.pipeline.flows import requeue_pending_review_flow

    rows = [{"id": "j1", "ia_identifier": "NHK_20010914_010000_x",
             "ia_metadata": {"identifier": "NHK_20010914_010000_x"}}]
    db = MagicMock()
    db.__enter__.return_value = db
    db.execute.return_value.mappings.return_value.all.return_value = rows

    with patch("video_grabber.pipeline.flows.get_db", return_value=db), \
         patch("video_grabber.pipeline.flows.get_run_logger", return_value=MagicMock()):
        result = requeue_pending_review_flow.fn(dry_run=True)

    assert result == {"promoted": 1, "evaluated": 1}
    # dry run: only the SELECT ran, no UPDATE/INSERT, no commit.
    sql = " ".join(c.args[0].text for c in db.execute.call_args_list if c.args)
    assert "UPDATE" not in sql and "INSERT" not in sql
    db.commit.assert_not_called()


def test_dispatch_discovered_flow_no_discovered_jobs_is_noop():
    from video_grabber.pipeline.flows import dispatch_discovered_flow

    db = MagicMock()
    db.__enter__.return_value = db
    db.execute.return_value.first.return_value = None

    with patch("video_grabber.pipeline.flows.get_db", return_value=db), \
         patch("video_grabber.pipeline.flows.run_deployment") as mock_run, \
         patch("video_grabber.pipeline.flows.get_run_logger", return_value=MagicMock()):
        dispatch_discovered_flow.fn(max_runs=10)

    mock_run.assert_not_called()


def test_dispatch_discovered_flow_dispatches_one_per_iteration():
    from video_grabber.pipeline.flows import dispatch_discovered_flow

    # Two discovered rows, then empty — flow should dispatch twice then exit.
    rows = [MagicMock(id="job-a"), MagicMock(id="job-b"), None]
    db = MagicMock()
    db.__enter__.return_value = db
    db.execute.return_value.first.side_effect = rows

    with patch("video_grabber.pipeline.flows.get_db", return_value=db), \
         patch("video_grabber.pipeline.flows.run_deployment") as mock_run, \
         patch("video_grabber.pipeline.flows.get_run_logger", return_value=MagicMock()):
        dispatch_discovered_flow.fn(max_runs=10)

    assert mock_run.call_count == 2
    assert mock_run.call_args_list[0].kwargs["parameters"] == {"job_id": "job-a"}
    assert mock_run.call_args_list[1].kwargs["parameters"] == {"job_id": "job-b"}


def test_dispatch_discovered_flow_respects_max_runs_cap():
    from video_grabber.pipeline.flows import dispatch_discovered_flow

    # Endless supply of rows — flow must still stop at max_runs.
    db = MagicMock()
    db.__enter__.return_value = db
    db.execute.return_value.first.return_value = MagicMock(id="job-x")

    with patch("video_grabber.pipeline.flows.get_db", return_value=db), \
         patch("video_grabber.pipeline.flows.run_deployment") as mock_run, \
         patch("video_grabber.pipeline.flows.get_run_logger", return_value=MagicMock()):
        dispatch_discovered_flow.fn(max_runs=3)

    assert mock_run.call_count == 3


def test_dispatch_claims_atomically_and_bumps_failed_retry():
    from video_grabber.pipeline.flows import dispatch_discovered_flow

    # One claimable job, then empty. The dispatcher claims atomically and
    # dispatches it; the claim bumps retry_count for failed jobs via a CASE.
    claimed = MagicMock(id="job-f")
    db = MagicMock()
    db.__enter__.return_value = db
    db.execute.return_value.first.side_effect = [claimed, None]

    with patch("video_grabber.pipeline.flows.get_db", return_value=db), \
         patch("video_grabber.pipeline.flows.run_deployment") as mock_run, \
         patch("video_grabber.pipeline.flows.get_run_logger", return_value=MagicMock()):
        dispatch_discovered_flow.fn(max_runs=10, max_retries=3)

    assert mock_run.call_count == 1
    assert mock_run.call_args_list[0].kwargs["parameters"] == {"job_id": "job-f"}
    # The claim is a single atomic UPDATE with row locking + the failed-retry bump.
    all_sql = " ".join(c.args[0].text for c in db.execute.call_args_list)
    assert "FOR UPDATE SKIP LOCKED" in all_sql
    assert "retry_count = retry_count" in all_sql
    assert "WHEN stage = 'failed'" in all_sql


def test_dispatch_skips_failed_jobs_over_retry_budget():
    from video_grabber.pipeline.flows import dispatch_discovered_flow

    # The SELECT itself filters out failed jobs at/over the retry cap, so an
    # exhausted job is simply never returned — modeled here as an empty queue.
    db = MagicMock()
    db.__enter__.return_value = db
    db.execute.return_value.first.return_value = None

    with patch("video_grabber.pipeline.flows.get_db", return_value=db), \
         patch("video_grabber.pipeline.flows.run_deployment") as mock_run, \
         patch("video_grabber.pipeline.flows.get_run_logger", return_value=MagicMock()):
        dispatch_discovered_flow.fn(max_runs=10, max_retries=3)

    mock_run.assert_not_called()
    # The selecting query must carry the retry-budget guard.
    select_sql = " ".join(c.args[0].text for c in db.execute.call_args_list)
    assert "retry_count < :max_retries" in select_sql
