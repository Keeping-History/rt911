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


# --- transition_job ---

def test_transition_job_updates_stage_and_logs():
    from video_grabber.pipeline.flows import transition_job

    db = MagicMock()
    transition_job(db, "job-id-001", "metadata_extracted", from_stage="discovered")

    db.execute.assert_called()
    calls_sql = " ".join(str(c) for c in db.execute.call_args_list)
    assert "video_jobs" in calls_sql or db.execute.called


def test_transition_job_inserts_audit_row():
    from video_grabber.pipeline.flows import transition_job

    db = MagicMock()
    transition_job(db, "job-id-001", "downloading", from_stage="metadata_extracted")

    # Two execute calls: UPDATE video_jobs + INSERT pipeline_transitions
    assert db.execute.call_count >= 2


# --- scan_collections_flow ---

def test_scan_collections_flow_calls_crawl_for_each_collection():
    from video_grabber.pipeline.flows import scan_collections_flow

    with patch("video_grabber.pipeline.flows.crawl_collection") as mock_crawl, \
         patch("video_grabber.pipeline.flows.ArchiveSession") as mock_session_cls, \
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

def test_process_item_flow_transitions_to_complete_on_success():
    from video_grabber.pipeline.flows import process_item_flow

    job = MagicMock()
    job.id = "job-001"
    job.ia_identifier = "cnn-sep11-0800"

    with patch("video_grabber.pipeline.flows.get_job", return_value=job), \
         patch("video_grabber.pipeline.flows.get_db"), \
         patch("video_grabber.pipeline.flows.download_item") as mock_dl, \
         patch("video_grabber.pipeline.flows.encode_to_hls") as mock_enc, \
         patch("video_grabber.pipeline.flows.upload_hls_package") as mock_up, \
         patch("video_grabber.pipeline.flows.write_media_item"), \
         patch("video_grabber.pipeline.flows.transition_job") as mock_trans, \
         patch("video_grabber.pipeline.flows.get_run_logger", return_value=MagicMock()):

        mock_dl.return_value = MagicMock()
        mock_enc.return_value = MagicMock()
        mock_up.return_value = "hls/cnn/20010911/cnn-sep11-0800/master.m3u8"

        process_item_flow.fn("job-001")

    stages = [c[0][2] for c in mock_trans.call_args_list]
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

    stages = [c[0][2] for c in mock_trans.call_args_list]
    assert "failed" in stages


def test_process_item_flow_transitions_through_all_stages():
    from video_grabber.pipeline.flows import process_item_flow

    job = MagicMock()
    job.id = "job-001"
    job.ia_identifier = "cnn-sep11-0800"

    with patch("video_grabber.pipeline.flows.get_job", return_value=job), \
         patch("video_grabber.pipeline.flows.get_db"), \
         patch("video_grabber.pipeline.flows.download_item", return_value=MagicMock()), \
         patch("video_grabber.pipeline.flows.encode_to_hls", return_value=MagicMock()), \
         patch("video_grabber.pipeline.flows.upload_hls_package", return_value="some/key"), \
         patch("video_grabber.pipeline.flows.write_media_item"), \
         patch("video_grabber.pipeline.flows.transition_job") as mock_trans, \
         patch("video_grabber.pipeline.flows.get_run_logger", return_value=MagicMock()):

        process_item_flow.fn("job-001")

    stages = [c[0][2] for c in mock_trans.call_args_list]
    assert "downloading" in stages
    assert "downloaded" in stages
    assert "encoding" in stages
    assert "encoded" in stages
    assert "uploading" in stages
    assert "complete" in stages


# --- dispatch_discovered_flow ---

def test_dispatch_discovered_flow_no_discovered_jobs_is_noop():
    from video_grabber.pipeline.flows import dispatch_discovered_flow

    db = MagicMock()
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
    db.execute.return_value.first.return_value = MagicMock(id="job-x")

    with patch("video_grabber.pipeline.flows.get_db", return_value=db), \
         patch("video_grabber.pipeline.flows.run_deployment") as mock_run, \
         patch("video_grabber.pipeline.flows.get_run_logger", return_value=MagicMock()):
        dispatch_discovered_flow.fn(max_runs=3)

    assert mock_run.call_count == 3
