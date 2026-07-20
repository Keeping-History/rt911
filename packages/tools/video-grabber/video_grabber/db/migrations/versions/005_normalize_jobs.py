"""normalize_jobs state table

Revision ID: 005
Revises: 004
Create Date: 2026-07-19

One row per audio/ MP3, tracked through pending → analyzing → analyzed|skipped
→ normalizing → done/failed. Mirrors transcribe_jobs. input_i/input_tp/input_lra
are the analyze stage's loudness report (queryable); probe holds ffprobe encode
params; archive_key is set once the original is safely in audio-original/.
'skipped' (already within tolerance) is terminal and distinct from 'done' so
re-tuned tolerances only ever reconsider files that never took a lossy re-encode.
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "005"
down_revision: Union[str, None] = "004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        DO $$ BEGIN
            CREATE TYPE normalize_stage AS ENUM (
                'pending', 'analyzing', 'analyzed', 'skipped',
                'normalizing', 'done', 'failed'
            );
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;
    """)

    op.create_table(
        "normalize_jobs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("source_key", sa.Text(), nullable=False, unique=True),
        sa.Column("stage", postgresql.ENUM(name="normalize_stage", create_type=False),
                  server_default="pending"),
        sa.Column("input_i", sa.Numeric()),     # integrated loudness, LUFS
        sa.Column("input_tp", sa.Numeric()),    # true peak, dBTP
        sa.Column("input_lra", sa.Numeric()),   # loudness range, LU
        sa.Column("probe", postgresql.JSONB()), # {bit_rate, sample_rate, channels, duration}
        sa.Column("archive_key", sa.Text()),    # audio-original/<name>.mp3 once archived
        sa.Column("error_message", sa.Text()),
        sa.Column("retry_count", sa.Integer(), server_default="0"),
        sa.Column("last_transition_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
    )
    op.create_index("idx_normalize_jobs_stage", "normalize_jobs", ["stage"])


def downgrade() -> None:
    op.drop_index("idx_normalize_jobs_stage", table_name="normalize_jobs")
    op.drop_table("normalize_jobs")
    op.execute("DROP TYPE IF EXISTS normalize_stage")
