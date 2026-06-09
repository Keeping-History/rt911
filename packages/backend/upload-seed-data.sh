#!/usr/bin/env bash
set -euo pipefail

BUCKET="gs://rt911-seed-data"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

gsutil cp "$SCRIPT_DIR/entries_news.json"  "$BUCKET/entries_news.json"
gsutil cp "$SCRIPT_DIR/entries_media.json" "$BUCKET/entries_media.json"

echo "Uploaded seed data to $BUCKET"
