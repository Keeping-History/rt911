"""sync_db_url is the one place that decides which DBAPI the sync code uses.

SQLAlchemy 2.1 changed the default driver behind a bare ``postgresql://`` URL
from psycopg2 to psycopg (3). This project installs only psycopg2-binary, and
the production DATABASE_URL Secret is a bare ``postgresql://``, so relying on
the default broke every engine on the first fresh install after the release
(dependabot PR #622's CI run). Naming the driver makes the choice ours.
"""
import pytest

from video_grabber.db.url import sync_db_url


@pytest.mark.parametrize(
    "url",
    [
        "postgresql://u:p@h:5432/db",
        "postgresql+asyncpg://u:p@h:5432/db",
        "postgresql+psycopg2://u:p@h:5432/db",
    ],
)
def test_every_postgres_spelling_lands_on_psycopg2(url):
    assert sync_db_url(url) == "postgresql+psycopg2://u:p@h:5432/db"


def test_is_idempotent():
    once = sync_db_url("postgresql://u:p@h/db")
    assert sync_db_url(once) == once


def test_leaves_other_schemes_alone():
    assert sync_db_url("sqlite:///x.db") == "sqlite:///x.db"
    assert sync_db_url("") == ""


def test_engine_built_from_it_uses_psycopg2_regardless_of_sqlalchemy_default():
    import sqlalchemy as sa

    eng = sa.create_engine(sync_db_url("postgresql://u:p@h/db"))
    assert eng.dialect.driver == "psycopg2"
