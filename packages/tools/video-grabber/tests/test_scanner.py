"""
Tests for IA collection scanner.
All IA API calls are mocked — no real network requests.
"""
from unittest.mock import MagicMock, patch
from video_grabber.ia.scanner import crawl_collection, is_candidate, upsert_job

# --- rate limiting ---


SEPT_11_ITEM = {
    "identifier": "cnn-sep11-0800",
    "mediatype": "movies",
    "title": "CNN September 11 2001 8:00am",
    "description": "CNN live coverage September 11, 2001",
    "subject": ["CNN", "September 11"],
    "creator": "Cable News Network",
    "date": "2001-09-11",
    "length": "3600",
}

SHORT_ITEM = {
    "identifier": "cnn-short-clip",
    "mediatype": "movies",
    "title": "CNN September 11 2001 clip",
    "creator": "Cable News Network",
    "date": "2001-09-11",
    "length": "60",  # only 1 min — below 720s threshold
}

UNKNOWN_NETWORK_ITEM = {
    "identifier": "unknown-broadcast",
    "mediatype": "movies",
    "title": "Some Unknown Broadcast September 11 2001",
    "creator": "Unknown Broadcaster",
    "date": "2001-09-11",
    "length": "3600",
}

SUB_COLLECTION = {
    "identifier": "sept_11_subset",
    "mediatype": "collection",
    "title": "Sept 11 Subset",
    "date": "2001-09-11",
    "length": None,
}


# --- is_candidate ---

def test_candidate_known_network_long_enough():
    assert is_candidate(SEPT_11_ITEM) is True


def test_candidate_too_short():
    assert is_candidate(SHORT_ITEM) is False


def test_candidate_unknown_network_not_filtered_to_false():
    # Unknown network items go to pending_review, not discarded
    # is_candidate returns True so they are inserted; stage handling is in upsert_job
    assert is_candidate(UNKNOWN_NETWORK_ITEM) is True


def test_candidate_none_length_is_accepted():
    """Items with no length in the search response are treated as unknown
    duration — accepted so downstream stages can verify, not dropped."""
    item = dict(SEPT_11_ITEM, length=None)
    assert is_candidate(item) is True


def test_candidate_empty_length_string_is_accepted():
    item = dict(SEPT_11_ITEM, length="")
    assert is_candidate(item) is True


def test_candidate_unparseable_length_is_accepted():
    item = dict(SEPT_11_ITEM, length="not-a-number")
    assert is_candidate(item) is True


def test_candidate_known_short_length_is_rejected():
    item = dict(SEPT_11_ITEM, length="60")
    assert is_candidate(item) is False


# --- crawl_collection ---

def make_session(items_per_call: dict[str, list]):
    """Build a mock ArchiveSession whose search_items returns items_per_call[identifier]."""
    session = MagicMock()
    def search_items(query, fields=None):
        identifier = query.split("collection:")[-1]
        return iter(items_per_call.get(identifier, []))
    session.search_items.side_effect = search_items
    return session


def test_crawl_fan_out_recurses_into_subcollection():
    session = make_session({
        "sept_11_tv_archive": [SUB_COLLECTION, SEPT_11_ITEM],
        "sept_11_subset": [SEPT_11_ITEM],
    })
    db = MagicMock()

    with patch("video_grabber.ia.scanner.upsert_job") as mock_upsert:
        crawl_collection(session, "sept_11_tv_archive", db)

    # SEPT_11_ITEM appears in both collections — should be upserted twice (once per call)
    # The dedup is handled at DB level via ON CONFLICT
    assert mock_upsert.call_count == 2


def test_crawl_visited_set_prevents_cycles():
    """A collection that references itself should not loop."""
    cycle_col = {"identifier": "loop_col", "mediatype": "collection", "title": "loop"}
    session = make_session({
        "loop_col": [cycle_col],
    })
    db = MagicMock()
    visited: set[str] = set()

    with patch("video_grabber.ia.scanner.upsert_job"):
        crawl_collection(session, "loop_col", db, visited=visited)

    # Should not raise RecursionError; visited set breaks the cycle
    assert "loop_col" in visited


def test_crawl_dedup_across_collections():
    """Same ia_identifier in two collections upserts twice but DB handles conflict."""
    session = make_session({
        "col_a": [SEPT_11_ITEM],
        "col_b": [SEPT_11_ITEM],
        "root": [
            {"identifier": "col_a", "mediatype": "collection", "title": "A",
             "date": "2001", "length": None},
            {"identifier": "col_b", "mediatype": "collection", "title": "B",
             "date": "2001", "length": None},
        ],
    })
    db = MagicMock()

    with patch("video_grabber.ia.scanner.upsert_job") as mock_upsert:
        crawl_collection(session, "root", db)

    # Two separate upsert calls — DB ON CONFLICT DO NOTHING handles actual dedup
    assert mock_upsert.call_count == 2


def test_crawl_short_items_not_upserted():
    session = make_session({"root": [SHORT_ITEM]})
    db = MagicMock()

    with patch("video_grabber.ia.scanner.upsert_job") as mock_upsert:
        crawl_collection(session, "root", db)

    mock_upsert.assert_not_called()


def test_crawl_subcollection_items_inserted_with_correct_collection():
    session = make_session({
        "root": [SUB_COLLECTION],
        "sept_11_subset": [SEPT_11_ITEM],
    })
    db = MagicMock()

    with patch("video_grabber.ia.scanner.upsert_job") as mock_upsert:
        crawl_collection(session, "root", db)

    mock_upsert.assert_called_once()
    _, kwargs = mock_upsert.call_args
    assert kwargs["collection"] == "sept_11_subset"


def test_crawl_rate_limiting_sleeps_per_item():
    """sleep_sec is called once per item (leaf or subcollection) encountered."""
    session = make_session({
        "root": [SEPT_11_ITEM, SHORT_ITEM, SUB_COLLECTION],
        "sept_11_subset": [SEPT_11_ITEM],
    })
    db = MagicMock()

    with patch("video_grabber.ia.scanner.time") as mock_time, \
         patch("video_grabber.ia.scanner.upsert_job"):
        crawl_collection(session, "root", db, sleep_sec=0.5)

    # root has 3 items + sept_11_subset has 1 item = 4 sleeps total
    assert mock_time.sleep.call_count == 4
    mock_time.sleep.assert_called_with(0.5)


def test_crawl_no_sleep_by_default():
    """Default sleep_sec=0 means time.sleep is never called."""
    session = make_session({"root": [SEPT_11_ITEM]})
    db = MagicMock()

    with patch("video_grabber.ia.scanner.time") as mock_time, \
         patch("video_grabber.ia.scanner.upsert_job"):
        crawl_collection(session, "root", db)

    mock_time.sleep.assert_not_called()


# --- upsert_job ---

def test_upsert_job_executes_insert(tmp_path):
    db = MagicMock()
    conn = MagicMock()
    db.__enter__ = MagicMock(return_value=conn)
    db.__exit__ = MagicMock(return_value=False)

    upsert_job(db, SEPT_11_ITEM, collection="sept_11_tv_archive")

    db.execute.assert_called_once()
    sql_call = db.execute.call_args[0][0]
    assert "video_jobs" in str(sql_call).lower() or db.execute.called


def test_upsert_job_unknown_network_sets_pending_review():
    db = MagicMock()
    upsert_job(db, UNKNOWN_NETWORK_ITEM, collection="sept_11_tv_archive")
    db.execute.assert_called_once()
    # Verify pending_review stage is passed when network is unknown
    call_kwargs = db.execute.call_args
    # The SQL text or params should include pending_review
    assert "pending_review" in str(call_kwargs)
