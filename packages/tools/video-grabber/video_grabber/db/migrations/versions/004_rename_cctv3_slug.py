"""rename cctv3 slug to cctv4

Revision ID: 004
Revises: 003
Create Date: 2026-06-27

The IA archive uses CCTV3 identifiers but the canonical channel name is CCTV4.
Update all slug references so existing rows match what the pipeline now produces.
"""
from typing import Sequence, Union
from alembic import op

revision: str = "004"
down_revision: Union[str, None] = "003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("UPDATE channels SET slug = 'cctv4' WHERE slug = 'cctv3'")
    op.execute("UPDATE transcribe_jobs SET channel_slug = 'cctv4' WHERE channel_slug = 'cctv3'")


def downgrade() -> None:
    op.execute("UPDATE transcribe_jobs SET channel_slug = 'cctv3' WHERE channel_slug = 'cctv4'")
    op.execute("UPDATE channels SET slug = 'cctv3' WHERE slug = 'cctv4'")
