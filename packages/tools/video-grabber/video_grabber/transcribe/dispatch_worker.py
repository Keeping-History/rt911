"""Standalone transcription dispatch worker.

Spawned as a subprocess by serve.main() — one process per concurrent transcription
slot (_TRANSCRIBE_DISPATCH_LIMIT). Claims pending/failed transcribe_jobs one at a
time and calls transcribe_item_flow directly (no Prefect run_deployment round-trip),
then loops until the queue is empty.

Running as a subprocess rather than a thread gives each worker a fully isolated
Python interpreter: its own event loop, connection pool, and signal handlers. This
avoids anyio / asyncio conflicts that arise when multiple threads each try to own
a Prefect flow's event loop."""
import sys

import sqlalchemy as sa

from video_grabber.config import Config
from video_grabber.transcribe.flows import _sync_db_url, transcribe_item_flow

_CLAIM_SQL = sa.text("""
    UPDATE transcribe_jobs SET
        stage = CAST('transcribing' AS transcribe_stage),
        retry_count = retry_count + CASE WHEN stage = 'failed' THEN 1 ELSE 0 END,
        last_transition_at = now()
    WHERE id = (
        SELECT id FROM transcribe_jobs
        WHERE stage = 'pending'
           OR (stage = 'failed' AND retry_count < 3)
        ORDER BY (stage = 'failed'), created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
    )
    RETURNING id
""")

_PREFIX = f"[transcribe-worker-{sys.argv[1] if len(sys.argv) > 1 else '?'}]"


def _log(msg: str) -> None:
    print(f"{_PREFIX} {msg}", flush=True)


def main() -> None:
    cfg = Config()
    url = _sync_db_url(cfg.database_url)
    processed = 0

    while True:
        engine = sa.create_engine(url)
        with engine.connect() as db:
            row = db.execute(_CLAIM_SQL).first()
            db.commit()
        engine.dispose()

        if row is None:
            _log(f"queue empty after {processed} runs")
            break

        job_id = str(row[0])
        _log(f"claimed {job_id} (run {processed + 1})")
        try:
            transcribe_item_flow(job_id=job_id)
        except Exception as exc:  # noqa: BLE001
            _log(f"error on {job_id}: {exc}")
        processed += 1

    _log(f"done after {processed} runs")


if __name__ == "__main__":
    main()
