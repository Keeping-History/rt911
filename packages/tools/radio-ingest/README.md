# radio-ingest — one-off Radio Tuner station ingest (2026-08-16)

Record of the one-shot job that ingested the anchor-verified 9/11 broadcast
recordings into `mp3_items` and assigned them to the Radio Tuner
(`BROADCAST_STATIONS` in the frontend, extended in the same PR).

This ran **once**, imperatively (`kubectl apply` in the `video-grabber`
namespace, reusing the worker image and its `envFrom` credentials). It is
deliberately **not** in the infra repo: ArgoCD would either fight the
completed immutable Job on every sync or, as a sync hook, re-run it on every
deploy. Keep it here as provenance; re-running is safe (uploads skip on
size match, rows dedupe on exact `url`, the same key the catalogue backfill
flow uses).

## What went in

22 files, 45.8 hours, ten stations. Sources of truth for the start times:

- The verification ledger (Aircheck Ledger artifact, 2026-08-15): every
  start anchored to UA 175 (9:03:11 ET), the Pentagon strike (9:37:46), a
  collapse (9:59:04 / 10:28:22), or a spoken "news time" check.
- `ingest_manifest.json` — the exact rows as ingested (naive-UTC dates per
  the `mp3_items` convention; `end_date` always set because the snapshot
  query treats NULL as "never ends").

Delta-aware: WINS already had 23/24 hours in production (only the 2–3 AM
Sept 12 hour was added); WCBS already had the official 8:46–13:13 release
(only the radiotapes 13:14–19:39 afternoon files were added).

## Files

- `ingest_manifest.py` — builds the manifest from the staged/verified audio
  (session-local paths; kept for the record of how starts were assigned)
- `ingest_manifest.json` — the manifest as executed
- `ingest_job.py` — uploader/upserter that ran in-cluster
- `radio-ingest-job.yaml` — the Job (hostPath staging mount is machine-specific)

## Sources & credit

radiotapes.com (WINS/WCBS/WABC/WTOP sets — provided by Stuart Held, Todd
Kosovich et al.) and fan-preserved airchecks from YouTube (WKXW, KFI, WRIF
Drew & Mike, WIBX Keeler, WBAP, KQRS). Rejected candidates and reasons are
in the ledger.
