"""record which commit each transcribe job ran on

Revision ID: 006
Revises: 005
Create Date: 2026-08-14

Issue #379: the cluster pod and the Mac Studio both serve `transcribe-item` and
silently ran different code for five weeks. Nothing recorded which executor —
let alone which commit — produced a given transcript, so the divergence only
surfaced when the same job, dispatched twice, wrote two different SRT keys.

`code_version` is stamped at claim time, so "which commit transcribed this?"
becomes one query instead of a hunt through per-run logs. Nullable with no
default: existing rows genuinely predate the mechanism, and back-filling them
with anything would be inventing evidence about the very thing this column
exists to record.
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "006"
down_revision: Union[str, None] = "005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("transcribe_jobs", sa.Column("code_version", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("transcribe_jobs", "code_version")
