"""
Tests Alembic migrations against a real PostgreSQL test database.
Requires TEST_DATABASE_URL env var pointing to a throwaway Postgres instance.
"""
import os
import pytest
import sqlalchemy as sa
from alembic.config import Config as AlembicConfig
from alembic import command


TEST_DB_URL = os.getenv(
    "TEST_DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/video_grabber_test",
)


@pytest.fixture(scope="module")
def migrated_engine():
    engine = sa.create_engine(TEST_DB_URL)
    alembic_cfg = AlembicConfig()
    alembic_cfg.set_main_option("script_location", "video_grabber/db/migrations")
    alembic_cfg.set_main_option("sqlalchemy.url", TEST_DB_URL)

    with engine.connect() as conn:
        conn.execute(sa.text("DROP SCHEMA public CASCADE"))
        conn.execute(sa.text("CREATE SCHEMA public"))
        conn.commit()

    command.upgrade(alembic_cfg, "head")
    yield engine

    engine.dispose()


def get_table_names(engine):
    insp = sa.inspect(engine)
    return set(insp.get_table_names())


def test_pipeline_stage_enum_exists(migrated_engine):
    with migrated_engine.connect() as conn:
        result = conn.execute(
            sa.text(
                "SELECT typname FROM pg_type WHERE typname = 'pipeline_stage'"
            )
        )
        assert result.fetchone() is not None, "pipeline_stage enum not found"


def test_channels_table_exists(migrated_engine):
    assert "channels" in get_table_names(migrated_engine)


def test_programs_table_exists(migrated_engine):
    assert "programs" in get_table_names(migrated_engine)


def test_video_jobs_table_exists(migrated_engine):
    assert "video_jobs" in get_table_names(migrated_engine)


def test_schedule_slots_table_exists(migrated_engine):
    assert "schedule_slots" in get_table_names(migrated_engine)


def test_pipeline_transitions_table_exists(migrated_engine):
    assert "pipeline_transitions" in get_table_names(migrated_engine)


def test_video_jobs_columns(migrated_engine):
    insp = sa.inspect(migrated_engine)
    cols = {c["name"] for c in insp.get_columns("video_jobs")}
    required = {
        "id", "ia_identifier", "stage", "collection", "channel_id",
        "program_id", "ia_metadata", "local_path", "encoded_path", "wasabi_key",
        "bytes_total", "bytes_downloaded", "error_message", "retry_count",
        "last_transition_at", "created_at",
    }
    assert required <= cols


def test_video_jobs_ia_identifier_unique(migrated_engine):
    insp = sa.inspect(migrated_engine)
    unique_constraints = insp.get_unique_constraints("video_jobs")
    uniq_cols = [
        col
        for uc in unique_constraints
        for col in uc["column_names"]
    ]
    # Also check via indexes
    indexes = insp.get_indexes("video_jobs")
    uniq_index_cols = [
        col
        for idx in indexes
        if idx.get("unique")
        for col in idx["column_names"]
    ]
    assert "ia_identifier" in uniq_cols or "ia_identifier" in uniq_index_cols


def test_stage_index_exists(migrated_engine):
    insp = sa.inspect(migrated_engine)
    indexes = insp.get_indexes("video_jobs")
    index_names = {idx["name"] for idx in indexes}
    assert "idx_jobs_stage" in index_names


def test_schedule_slots_index_exists(migrated_engine):
    insp = sa.inspect(migrated_engine)
    indexes = insp.get_indexes("schedule_slots")
    index_names = {idx["name"] for idx in indexes}
    assert "idx_slots_channel_time" in index_names


def test_pipeline_transitions_index_exists(migrated_engine):
    insp = sa.inspect(migrated_engine)
    indexes = insp.get_indexes("pipeline_transitions")
    index_names = {idx["name"] for idx in indexes}
    assert "idx_transitions_job" in index_names


def test_video_jobs_default_stage(migrated_engine):
    with migrated_engine.connect() as conn:
        conn.execute(sa.text(
            "INSERT INTO channels (slug, display_name, timezone) "
            "VALUES ('test-net', 'Test Network', 'America/New_York')"
        ))
        conn.execute(sa.text(
            "INSERT INTO video_jobs (ia_identifier, collection) "
            "VALUES ('test-id-001', 'sept_11_tv_archive')"
        ))
        conn.commit()
        row = conn.execute(
            sa.text("SELECT stage FROM video_jobs WHERE ia_identifier = 'test-id-001'")
        ).fetchone()
        assert row[0] == "discovered"
