# Testing

Tests live under [`tests/`](../tests). One test module per source module, named `test_<module>.py`. Run everything from the package root:

```bash
pip install -e ".[dev]"
pytest
```

`pytest.ini_options.testpaths = ["tests"]` is set in `pyproject.toml`, so the bare `pytest` command works from anywhere inside the package.

## What the tests cover

| Test file | Exercises |
| --- | --- |
| `test_config.py` | `Config()` env-var reads and defaults. |
| `test_scanner.py` | `is_candidate()`, `upsert_job()`, recursive `crawl_collection()` with mocked `ArchiveSession`. |
| `test_metadata.py` | Air-date parsing across ISO and named-month formats, AM/PM, TZ resolution, default-EDT fallback. |
| `test_downloader.py` | `select_best_file()` priority, skip-pattern filtering, byte-range `Range` header on resume. |
| `test_encoder.py` | `scale_keep_aspect()` math, `probe_resolution()` with mocked ffprobe, the per-rendition ffmpeg command shape. |
| `test_gap_filler.py` | Gap segment dimensions per rendition, audio retention on the thumb rung. |
| `test_uploader.py` | Wasabi `upload_hls_package()` with `moto[s3]`: key layout, `Content-Type` and `Cache-Control` per extension. |
| `test_directus_writer.py` | Idempotency check (early return on existing item), payload shape, source-id resolution, approved-flag logic. |
| `test_flows.py` | `transition_job()` writes both UPDATE and INSERT; `scan_collections_flow()` and `process_item_flow()` orchestration with all components patched. |
| `test_epg.py`, `test_epg_json.py` | EPG assembler with mock slots: gap insertion, discontinuity tags, EPG JSON grid shape. |
| `test_migrations.py` | Alembic revision sanity. |

## Mocking strategy

The pipeline talks to four external systems (IA, Postgres, Wasabi, Directus) plus a heavyweight local binary (ffmpeg/ffprobe). The tests mock each at the boundary closest to the unit under test:

- **IA SDK** — `unittest.mock.patch("video_grabber.pipeline.flows.ArchiveSession")` and stubbed `session.search_items()` returning canned dicts.
- **IA HTTP API** — `respx` mocks `httpx` calls for the downloader and the Directus writer.
- **Postgres** — `MagicMock` for the SQLAlchemy connection. Tests assert on `db.execute.call_args_list` rather than spinning up a real Postgres. Migration tests use a SQLite stub or a `pytest-postgresql` fixture, depending on the test.
- **Wasabi S3** — `moto[s3]` provides a fake S3 endpoint. The uploader's `boto3.client("s3", endpoint_url=…)` is pointed at the moto server.
- **Directus HTTP API** — `respx` mocks all four calls (the idempotency GET, the source-resolve GET, the create POST, error branches).
- **ffmpeg / ffprobe** — `subprocess.run` is patched. Tests assert on the constructed argv rather than on encoded output.

The flow tests illustrate the pattern (`tests/test_flows.py`):

```python
with patch("video_grabber.pipeline.flows.crawl_collection") as mock_crawl, \
     patch("video_grabber.pipeline.flows.ArchiveSession") as mock_session_cls, \
     patch("video_grabber.pipeline.flows.get_db") as mock_db, \
     patch("video_grabber.pipeline.flows.get_run_logger", return_value=MagicMock()):
    …
```

The `@flow` decorator is consumed at import time, but Prefect lets a flow run synchronously in-process during tests without a Prefect server.

## Postgres integration tests

[`tests/test_postgres_integration.py`](../tests/test_postgres_integration.py) runs real SQL against a live Postgres — the schema is applied via `alembic upgrade head` once per module and every test executes inside a savepoint that's rolled back at teardown, so tests don't see each other's writes.

The whole file is skipped when `TEST_DATABASE_URL` is unset, so a bare `pytest` from a developer laptop without Postgres still passes. CI's `build-video-grabber.yml` spins up a Postgres 16 service container and sets the env var, so these run on every PR.

What this suite catches that the MagicMock'd unit tests can't:

- **SQL syntax errors.** The `:ia_metadata::jsonb` bug from June 2026 — SQLAlchemy's `text()` bind-parser broke on the Postgres `::` cast operator and left the colon-prefixed name in the rendered SQL. MagicMock'd connections happily accepted the malformed string; Postgres did not. `test_upsert_job_writes_row_with_jsonb_metadata` round-trips a real insert + select.
- **Missing commits.** Scanner upserts were silently rolled back because `SQLAlchemy 2.0`'s `engine.connect()` autobegins a transaction without auto-commit. Round-trip tests fail the moment a write doesn't reach disk.
- **Driver scheme issues.** `test_sync_db_url_keeps_test_database_url_compatible` proves `_sync_db_url()` produces a connectable URL — guards against the `postgresql+asyncpg://` MissingGreenlet regression.
- **Enum cast bugs.** Pipeline stage transitions exercise the `CAST(... AS pipeline_stage)` path against the live enum.

## Why no IA / Wasabi / Directus / ffmpeg integration suite

The external integrations still mock at the boundary:

- An IA item we can re-download (slow, fragile).
- A real Wasabi bucket with cleanup (costs money, leaks state on failure).
- A real Directus instance (deployment-specific schema drift risk).
- A real ffmpeg run on real footage (minutes per test).

The Postgres suite covers the highest-risk boundary (schema + SQL) without those trade-offs. If you add live tests for the others later, gate them with a `pytest.mark.integration` marker that's deselected by default and only run on `main`.

## Adding a test

Style matches surrounding tests:

- Use `from unittest.mock import MagicMock, patch` for everything except HTTP and S3.
- Use `respx` for `httpx` mocks, `moto` for S3.
- Assert on the **shape** of arguments rather than re-implementing the function's logic.
- For new modules under `video_grabber/`, add a matching `tests/test_<module>.py` rather than extending an existing test file.
