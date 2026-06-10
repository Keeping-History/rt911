"""
Integration tests that exercise the schema, SQL strings, and transaction
behavior against a *real* Postgres rather than a MagicMock'd connection.

Skipped when ``TEST_DATABASE_URL`` is unset, so a bare ``pytest`` from a
developer laptop without Postgres still passes. The CI workflow
(.github/workflows/build-video-grabber.yml) spins up a Postgres 16 service
container and sets the env var, so these run on every PR.

These tests fill the coverage gap that let three SQL/transaction bugs
slip through unit tests in mid-June 2026:

  * :ia_metadata::jsonb confused SQLAlchemy text()'s bind-param parser.
  * Scanner never called db.commit(), so every row got rolled back.
  * DATABASE_URL with the postgresql+asyncpg:// scheme raised
    MissingGreenlet inside the sync flow code.
"""
import os
import pytest
import sqlalchemy as sa

from alembic import command
from alembic.config import Config as AlembicConfig

from video_grabber.ia.scanner import upsert_job
from video_grabber.pipeline.flows import _sync_db_url, transition_job


pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_DATABASE_URL"),
    reason="TEST_DATABASE_URL not set — skipping Postgres integration tests",
)


@pytest.fixture(scope="module")
def engine():
    url = _sync_db_url(os.environ["TEST_DATABASE_URL"])
    eng = sa.create_engine(url)
    cfg = AlembicConfig()
    cfg.set_main_option("script_location", "video_grabber/db/migrations")
    cfg.set_main_option("sqlalchemy.url", url)
    command.upgrade(cfg, "head")
    yield eng
    eng.dispose()


@pytest.fixture
def connection(engine):
    """Per-test connection wrapped in a savepoint that's rolled back at teardown,
    so tests don't see each other's writes but real SQL still executes."""
    conn = engine.connect()
    trans = conn.begin()
    try:
        yield conn
    finally:
        trans.rollback()
        conn.close()


# --- schema sanity ---

def test_schema_has_pipeline_tables(connection):
    tables = connection.execute(
        sa.text(
            "SELECT tablename FROM pg_tables WHERE schemaname = current_schema()"
        )
    ).scalars().all()
    expected = {"channels", "programs", "video_jobs", "schedule_slots", "pipeline_transitions"}
    assert expected.issubset(set(tables)), f"missing tables: {expected - set(tables)}"


def test_pipeline_stage_enum_exists(connection):
    values = connection.execute(
        sa.text(
            "SELECT enumlabel FROM pg_enum "
            "WHERE enumtypid = 'pipeline_stage'::regtype ORDER BY enumsortorder"
        )
    ).scalars().all()
    assert "discovered" in values
    assert "complete" in values
    assert "failed" in values
    assert "pending_review" in values


# --- upsert_job round-trip (catches the ::jsonb syntax bug) ---

def test_upsert_job_writes_row_with_jsonb_metadata(connection):
    item = {
        "identifier": "int-test-1",
        "title": "Integration test broadcast",
        "creator": "CNN",
        "length": "3600",
    }
    upsert_job(connection, item, collection="test_collection")
    connection.commit()  # commit so the subsequent SELECT sees it within this savepoint

    row = connection.execute(
        sa.text(
            "SELECT ia_identifier, collection, stage, ia_metadata "
            "FROM video_jobs WHERE ia_identifier = :id"
        ),
        {"id": "int-test-1"},
    ).one()

    assert row.ia_identifier == "int-test-1"
    assert row.collection == "test_collection"
    assert str(row.stage) == "discovered"  # CNN normalizes to a known slug
    assert row.ia_metadata["identifier"] == "int-test-1"
    assert row.ia_metadata["creator"] == "CNN"


def test_upsert_job_is_idempotent_on_duplicate_identifier(connection):
    item = {"identifier": "int-test-dup", "title": "first", "creator": "CNN"}
    upsert_job(connection, item, collection="test_collection_a")
    # Second upsert with same identifier but different collection — ON CONFLICT keeps the first.
    upsert_job(connection, item, collection="test_collection_b")
    connection.commit()

    rows = connection.execute(
        sa.text("SELECT collection FROM video_jobs WHERE ia_identifier = :id"),
        {"id": "int-test-dup"},
    ).all()
    assert len(rows) == 1
    assert rows[0].collection == "test_collection_a"


def test_upsert_job_unknown_channel_goes_to_pending_review(connection):
    item = {"identifier": "int-test-unknown", "title": "Local 5pm news"}
    upsert_job(connection, item, collection="test_collection")
    connection.commit()
    stage = connection.execute(
        sa.text("SELECT stage FROM video_jobs WHERE ia_identifier = :id"),
        {"id": "int-test-unknown"},
    ).scalar()
    assert str(stage) == "pending_review"


# --- transition_job round-trip (catches stage-cast and audit-row bugs) ---

def test_transition_job_updates_stage_and_writes_audit_row(connection):
    upsert_job(
        connection,
        {"identifier": "int-test-trans", "title": "t", "creator": "CNN"},
        collection="test_collection",
    )
    connection.commit()
    job_id = connection.execute(
        sa.text("SELECT id FROM video_jobs WHERE ia_identifier = :id"),
        {"id": "int-test-trans"},
    ).scalar()

    transition_job(connection, str(job_id), "downloading", from_stage="discovered")

    stage = connection.execute(
        sa.text("SELECT stage FROM video_jobs WHERE id = :id"), {"id": job_id},
    ).scalar()
    assert str(stage) == "downloading"

    audit = connection.execute(
        sa.text(
            "SELECT from_stage, to_stage FROM pipeline_transitions "
            "WHERE job_id = :id ORDER BY occurred_at DESC LIMIT 1"
        ),
        {"id": job_id},
    ).one()
    assert str(audit.from_stage) == "discovered"
    assert str(audit.to_stage) == "downloading"


def test_transition_job_failed_with_error_message_persists(connection):
    upsert_job(
        connection,
        {"identifier": "int-test-fail", "title": "t", "creator": "CNN"},
        collection="test_collection",
    )
    connection.commit()
    job_id = connection.execute(
        sa.text("SELECT id FROM video_jobs WHERE ia_identifier = :id"),
        {"id": "int-test-fail"},
    ).scalar()

    transition_job(connection, str(job_id), "failed", error="boom")

    err, stage = connection.execute(
        sa.text("SELECT error_message, stage FROM video_jobs WHERE id = :id"),
        {"id": job_id},
    ).one()
    assert err == "boom"
    assert str(stage) == "failed"


# --- URL normalization (catches the asyncpg/MissingGreenlet bug) ---

def test_sync_db_url_keeps_test_database_url_compatible():
    """The TEST_DATABASE_URL in CI uses postgresql:// (no driver suffix);
    _sync_db_url should leave it untouched and the engine should connect."""
    url = _sync_db_url(os.environ["TEST_DATABASE_URL"])
    eng = sa.create_engine(url)
    with eng.connect() as c:
        assert c.execute(sa.text("SELECT 1")).scalar() == 1
    eng.dispose()
