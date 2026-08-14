#!/bin/sh
# One rt911 transcribe worker slot: claims transcribe_jobs from the cluster DB
# (via the reverse SSH tunnel) and runs whisper.cpp/Metal locally.
cd "$(dirname "$0")"
set -a; . ./worker.env; set +a
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
mkdir -p "$SCRATCH_DIR"
exec ./venv/bin/python -m video_grabber.transcribe.dispatch_worker "${1:-mac}"
