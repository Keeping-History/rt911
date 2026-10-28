import os
from logging.config import fileConfig
from sqlalchemy import engine_from_config, pool
from alembic import context

from video_grabber.db.url import sync_db_url

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Override sqlalchemy.url from env if set, pinned to the sync psycopg2 driver
# the same way the app pins it (asyncpg would raise MissingGreenlet here, and a
# bare postgresql:// would let SQLAlchemy 2.1 pick psycopg 3, which is not
# installed) — see video_grabber/db/url.py.
db_url = os.getenv("DATABASE_URL")
if db_url:
    config.set_main_option("sqlalchemy.url", sync_db_url(db_url))

target_metadata = None


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
