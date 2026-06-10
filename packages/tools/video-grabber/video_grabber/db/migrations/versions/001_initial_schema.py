"""initial schema

Revision ID: 001
Revises:
Create Date: 2026-06-10

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql  # noqa: F401 — used for UUID/JSONB column types

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        DO $$ BEGIN
            CREATE TYPE pipeline_stage AS ENUM (
                'discovered', 'metadata_extracted', 'pending_review',
                'downloading', 'downloaded', 'encoding', 'encoded',
                'uploading', 'complete', 'failed'
            );
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;
    """)

    op.create_table(
        "channels",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("slug", sa.Text(), nullable=False, unique=True),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("timezone", sa.Text(), nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
    )

    op.create_table(
        "programs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("channel_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("channels.id"), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("air_date", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("duration_seconds", sa.Integer(), nullable=False),
        sa.Column("ia_identifier", sa.Text(), nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
    )

    op.create_table(
        "video_jobs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("ia_identifier", sa.Text(), nullable=False, unique=True),
        sa.Column("stage", postgresql.ENUM(name="pipeline_stage", create_type=False),
                  server_default="discovered"),
        sa.Column("collection", sa.Text(), nullable=False),
        sa.Column("channel_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("channels.id")),
        sa.Column("program_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("programs.id")),
        sa.Column("ia_metadata", postgresql.JSONB()),
        sa.Column("local_path", sa.Text()),
        sa.Column("encoded_path", sa.Text()),
        sa.Column("wasabi_key", sa.Text()),
        sa.Column("bytes_total", sa.BigInteger()),
        sa.Column("bytes_downloaded", sa.BigInteger(), server_default="0"),
        sa.Column("error_message", sa.Text()),
        sa.Column("retry_count", sa.Integer(), server_default="0"),
        sa.Column("last_transition_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
    )

    op.create_index("idx_jobs_stage", "video_jobs", ["stage"])

    op.create_table(
        "schedule_slots",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("channel_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("channels.id"), nullable=False),
        sa.Column("program_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("programs.id")),
        sa.Column("starts_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("ends_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("segment_url", sa.Text()),
        sa.Column("is_gap", sa.Boolean(), server_default="false"),
    )

    op.create_index("idx_slots_channel_time", "schedule_slots",
                    ["channel_id", "starts_at", "ends_at"])

    op.create_table(
        "pipeline_transitions",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("job_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("video_jobs.id"), nullable=False),
        sa.Column("from_stage", postgresql.ENUM(name="pipeline_stage", create_type=False)),
        sa.Column("to_stage", postgresql.ENUM(name="pipeline_stage", create_type=False),
                  nullable=False),
        sa.Column("worker_id", sa.Text()),
        sa.Column("occurred_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
    )

    op.create_index("idx_transitions_job", "pipeline_transitions", ["job_id"])


def downgrade() -> None:
    op.drop_table("pipeline_transitions")
    op.drop_index("idx_slots_channel_time", table_name="schedule_slots")
    op.drop_table("schedule_slots")
    op.drop_index("idx_jobs_stage", table_name="video_jobs")
    op.drop_table("video_jobs")
    op.drop_table("programs")
    op.drop_table("channels")
    op.execute("DROP TYPE IF EXISTS pipeline_stage")
