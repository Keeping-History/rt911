"""usenet_jobs state table

Revision ID: 002
Revises: 001
Create Date: 2026-06-17

One row per Internet Archive newsgroup item, tracking it through the
scan → download → process pipeline so rescans are idempotent and failures are
kept for diagnosis (see plans/usenet-archive-ingestion.md, decision #2). Mirrors
video_jobs but for the mbox ingestion flow.
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql  # noqa: F401 — used for JSONB column type

revision: str = "002"
down_revision: Union[str, None] = "001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        DO $$ BEGIN
            CREATE TYPE usenet_stage AS ENUM (
                'discovered', 'downloading', 'downloaded',
                'processing', 'processed', 'failed'
            );
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;
    """)

    op.create_table(
        "usenet_jobs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("ia_identifier", sa.Text(), nullable=False, unique=True),
        sa.Column("collection", sa.Text(), nullable=False),
        sa.Column("stage", postgresql.ENUM(name="usenet_stage", create_type=False),
                  server_default="discovered"),
        sa.Column("mbox_format", sa.Text()),          # zip / gz / unknown
        sa.Column("ia_metadata", postgresql.JSONB()),
        sa.Column("local_path", sa.Text()),
        sa.Column("message_count", sa.Integer()),     # messages written after cutoff
        sa.Column("error_message", sa.Text()),
        sa.Column("retry_count", sa.Integer(), server_default="0"),
        sa.Column("last_transition_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
    )
    op.create_index("idx_usenet_jobs_stage", "usenet_jobs", ["stage"])


def downgrade() -> None:
    op.drop_index("idx_usenet_jobs_stage", table_name="usenet_jobs")
    op.drop_table("usenet_jobs")
    op.execute("DROP TYPE IF EXISTS usenet_stage")
