"""Add subtitles column to tv_channels, mp3_items, news_items

Revision ID: 004
Revises: 003
Create Date: 2026-06-25

The streamer's postgres.go SELECTs mi.subtitles from all three media tables so
that the frontend can display captions. This migration adds the nullable TEXT
column so a fresh database works without manual ALTER TABLE.

Already applied to production on 2026-06-25 via direct psql.
"""
from typing import Sequence, Union
from alembic import op

revision: str = "004"
down_revision: Union[str, None] = "003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    for table in ("tv_channels", "mp3_items", "news_items"):
        op.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS subtitles TEXT")


def downgrade() -> None:
    for table in ("tv_channels", "mp3_items", "news_items"):
        op.execute(f"ALTER TABLE {table} DROP COLUMN IF EXISTS subtitles")
