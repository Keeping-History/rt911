"""The one place that decides which DBAPI the synchronous code talks through.

Every sync engine in this package (pipeline, transcribe, normalize and usenet
flows, serve.py, the dispatch worker, Alembic's env.py and the DB tests) builds
its URL through :func:`sync_db_url`, so the driver choice is made once, here.

Two spellings of a Postgres URL are rewritten to ``postgresql+psycopg2://``:

* ``postgresql+asyncpg://`` — the shared DATABASE_URL Secret is sometimes
  provisioned that way for Prefect's own server, and asyncpg raises
  MissingGreenlet inside sync flow code.
* bare ``postgresql://`` — the production Secret's actual form. With no driver
  named, SQLAlchemy picks its default DBAPI, and SQLAlchemy 2.1 changed that
  default from psycopg2 to psycopg (3). Only psycopg2-binary is installed, so
  the first fresh install after the 2.1 release failed every engine with
  ``ModuleNotFoundError: No module named 'psycopg'`` (dependabot PR #622).
  Naming the driver makes the choice ours instead of the library's.

Anything else (an explicit ``+psycopg2``, sqlite in a test, an empty string)
passes through unchanged, so the function is idempotent.
"""

_SYNC_SCHEME = "postgresql+psycopg2://"
_REWRITTEN_SCHEMES = ("postgresql+asyncpg://", "postgresql://")


def sync_db_url(url: str) -> str:
    """Return ``url`` with the sync psycopg2 driver named explicitly."""
    for prefix in _REWRITTEN_SCHEMES:
        if url.startswith(prefix):
            return _SYNC_SCHEME + url[len(prefix):]
    return url
