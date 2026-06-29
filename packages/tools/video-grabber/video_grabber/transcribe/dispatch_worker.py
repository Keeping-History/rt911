"""Standalone transcription dispatch worker.

Spawned as a subprocess by serve.main() — one process per concurrent transcription
slot (_TRANSCRIBE_DISPATCH_LIMIT). Claims pending/failed transcribe_jobs one at a
time and calls transcribe_item_flow directly (no Prefect run_deployment round-trip),
then loops forever.

Running as a subprocess rather than a thread gives each worker a fully isolated
Python interpreter: its own event loop, connection pool, and signal handlers. This
avoids anyio / asyncio conflicts that arise when multiple threads each try to own
a Prefect flow's event loop. The trade-off is that a native whisper/Vulkan crash
takes the whole process down — serve.py's supervisor respawns it, and the heartbeat
below lets the supervisor tell a crashed claim apart from a live one.

Two behaviours keep the pipeline self-healing:
  - On an empty queue the worker SLEEPS and retries instead of exiting, so a drained
    queue that scan-transcribe later refills is picked up without a pod restart.
  - While a job is claimed, a heartbeat thread refreshes its last_transition_at every
    minute. If the worker dies mid-transcription the heartbeat stops, the row goes
    stale, and serve.py re-queues it. A live worker — even on a ~1h46m transcription —
    keeps it fresh, so a slow job is never mistaken for a dead one.
"""
import sys
import threading
import time

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

_IDLE_SLEEP = 30        # seconds to wait before re-polling an empty queue
_HEARTBEAT_INTERVAL = 60  # seconds between last_transition_at refreshes (see serve._TRANSCRIBE_STALE_MINUTES)

_WORKER = sys.argv[1] if len(sys.argv) > 1 else "?"
_PREFIX = f"[transcribe-worker-{_WORKER}]"

# The id of the job currently being transcribed (None while idle). Read by the
# heartbeat thread; a plain dict is fine — single writer, CPython atomic reads.
_current = {"id": None}


def _log(msg: str) -> None:
    print(f"{_PREFIX} {msg}", flush=True)


def _heartbeat(url: str) -> None:
    """Refresh the claimed job's last_transition_at so the supervisor can tell a
    live transcription from one whose worker has crashed."""
    engine = sa.create_engine(url)
    while True:
        time.sleep(_HEARTBEAT_INTERVAL)
        job_id = _current["id"]
        if not job_id:
            continue
        try:
            with engine.begin() as db:
                db.execute(sa.text(
                    "UPDATE transcribe_jobs SET last_transition_at = now() "
                    "WHERE id = :id AND stage = 'transcribing'"
                ), {"id": job_id})
        except Exception as exc:  # noqa: BLE001 — heartbeat must not kill the worker
            _log(f"heartbeat error: {exc}")


def main() -> None:
    cfg = Config()
    url = _sync_db_url(cfg.database_url)
    threading.Thread(target=_heartbeat, args=(url,), daemon=True).start()
    processed = 0

    while True:
        engine = sa.create_engine(url)
        with engine.connect() as db:
            row = db.execute(_CLAIM_SQL).first()
            db.commit()
        engine.dispose()

        if row is None:
            time.sleep(_IDLE_SLEEP)  # stay alive; scan-transcribe may refill the queue
            continue

        job_id = str(row[0])
        _current["id"] = job_id
        _log(f"claimed {job_id} (run {processed + 1})")
        try:
            transcribe_item_flow(job_id=job_id)
        except Exception as exc:  # noqa: BLE001
            _log(f"error on {job_id}: {exc}")
        finally:
            _current["id"] = None
        processed += 1


if __name__ == "__main__":
    main()
