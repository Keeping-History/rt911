"""transcribe_jobs state table

Revision ID: 003
Revises: 002
Create Date: 2026-06-25

One row per transcription unit — a TV program (kind='tv') or a radio MP3
(kind='mp3') — tracked through pending → transcribing → done/failed so rescans
are idempotent (source_key UNIQUE) and failures are kept for diagnosis. Mirrors
usenet_jobs. channel_slug + source_url drive the per-channel SRT merge.
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        DO $$ BEGIN
            CREATE TYPE transcribe_stage AS ENUM (
                'pending', 'transcribing', 'done', 'failed'
            );
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;
    """)

    op.create_table(
        "transcribe_jobs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("kind", sa.Text(), nullable=False),            # 'tv' | 'mp3'
        sa.Column("source_key", sa.Text(), nullable=False, unique=True),
        sa.Column("channel_slug", sa.Text()),                    # tv only
        sa.Column("source_url", sa.Text(), nullable=False),      # public URL to transcribe
        sa.Column("srt_key", sa.Text()),                         # produced per-unit SRT key
        sa.Column("stage", postgresql.ENUM(name="transcribe_stage", create_type=False),
                  server_default="pending"),
        sa.Column("error_message", sa.Text()),
        sa.Column("retry_count", sa.Integer(), server_default="0"),
        sa.Column("last_transition_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
    )
    op.create_index("idx_transcribe_jobs_stage", "transcribe_jobs", ["stage"])


def downgrade() -> None:
    op.drop_index("idx_transcribe_jobs_stage", table_name="transcribe_jobs")
    op.drop_table("transcribe_jobs")
    op.execute("DROP TYPE IF EXISTS transcribe_stage")
