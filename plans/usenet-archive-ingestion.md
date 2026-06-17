---
status: in_progress
---
# Plan: Usenet Archive Ingestion from the Internet Archive (≤ Sep 20 2001)

**Created:** 2026-06-17 | **Status:** In progress | **Effort:** M | **Branch:** feat/usenet-ingestion
**Goal:** Stand up a job that downloads historical Usenet newsgroup archives from the Internet
Archive, **threads** them, and writes them to Directus for the streamer's `usenet` channel, scoped to
messages posted **on or before Sep 20 2001** (`--before 2001-09-21`).
**Companion:** consumes `packages/tools/mbox_parser/mbox_parser.py` (built). Lives in
`packages/tools/video-grabber/video_grabber/usenet/`. The Directus schema/seam (channel, field
mapping) is specified in Stage 4 below.

> **This is the authoritative execution plan for the ingestion pipeline.** The broader newsgroups
> feature also includes the backend `usenet` channel + `sources` refactor (**done**) and the frontend
> Newsgroups app + pager→sources migration (**todo**) — those are outside this plan; see
> "Broader feature scope" at the end.

## Summary

A **scan → download → process(thread) → ingest** pipeline, mirroring the existing `video-grabber`
pipeline (`video_grabber/ia/scanner.py`, `pipeline/downloader.py`, `directus/writer.py`):

1. **Scan** the Internet Archive to enumerate newsgroup items into `usenet_jobs`.
2. **Download** the mbox payload for each item.
3. **Process**: thread + dedup each archive with `usenetarchive` (locked: max fidelity), and apply the
   per-message cutoff via `mbox_parser.py --before 2001-09-21`.
4. **Ingest** the threaded messages into Directus (`usenet_items` + `sources` type=usenet).

The Sep-20-2001 cutoff is enforced **per message at the process stage**, not in the IA search —
see "Why" below. The scan stage just enumerates *what to download*.

## Why the date cutoff can't live in the IA search (the central finding)

Verified against the live IA API on 2026-06-17:

- **No item carries a usable date.** Across `usenet`, `giganews`, and `usenethistorical`, the
  `date`/`year`/`publicdate` fields are empty or reflect the *donation* date (e.g. 2014-04-22), not
  message dates.
- **Each item is one newsgroup spanning its whole life.** A single item (e.g. `usenet-comp.lang.c`)
  holds every message from the group's first post through its last in one mbox. There is no
  "pre-2001 item" to query for — every populated group item straddles the cutoff.

→ Therefore the cutoff must be a **per-message** filter on the `Date:` header, which
`mbox_parser.py` already implements (`--before`, `mbox_parser.py:500-503`) and which also drops
undatable messages entirely (`mbox_parser.py:497`) — relevant because pre-1995 articles often carry
malformed/naïve date headers. The scan stage cannot pre-filter by date and must not try.

## Findings: what's actually on the Internet Archive (verified 2026-06-17)

The `usenet` umbrella collection has **79,448** items but is dominated by one modern backup. The
three real sub-collections:

| Collection | Items | Payload format | Pre-Oct-2001 value | mbox_parser-ready? |
|---|---|---|---|---|
| **`usenethistorical`** | 1,019 | `<group>.mbox.zip` | **Entirely pre-2001** (UTZOO 1981–1991 + early sets) — zero wasted downloads | ✅ `.zip` |
| **`giganews`** | 25,327 | `<group>.mbox.gz` (+ a `.csv.gz` index) | Large; rich pre-2001 content, groups extend past 2001 (`--before` trims tail) | ✅ `.gz` |
| `usenet` / `FULL-USENET-BACKUP-2020-*` | ~79k | `.mbox.7z` | Modern crawl, lowest pre-2001 density | ❌ `.7z` (parser has no 7z path) |

**Scope decision (locked with Boss):** target **`usenethistorical` + `giganews`** (~26.3k items).
The 2020 `.7z` backup is excluded — lowest marginal value and would require a new 7z decompress
step in `mbox_parser`.

## Architecture: stage by stage

### Stage 1 — Scan (produce the download list)

A scanner enumerates the two collections into a JSONL download list. One record per item:

```json
{"ia_identifier": "usenet-ncsu", "collection": "usenethistorical",
 "mbox_format": "zip", "download_glob": "*mbox*", "title": "usenet-ncsu"}
```

Key implementation decisions (validated against the live API):

- **Use the scrape API, not `advancedsearch.php`.**
  `https://archive.org/services/search/v1/scrape?q=collection:<id>&fields=identifier,format,title&count=10000`.
  `advancedsearch.php` hard-caps at 10,000 rows — it would silently drop ~15k of giganews's 25k
  items. Scrape returns an opaque `cursor` token to page through the full set (`count` min 100, max
  10000). Send a named `User-Agent` to avoid aggressive throttling.
  (`video-grabber` reaches the same API indirectly via `internetarchive.search_items`; doing it
  directly with stdlib `urllib` keeps this tool dependency-light.)
- **Two-stage file resolution, like video-grabber.** The scan emits *identifier + glob*, not
  resolved file URLs. Resolving exact filenames would cost ~26k extra metadata HTTP calls at scan
  time; defer file selection to the download stage. (Optionally add a `--resolve-files` mode that
  fetches per-item metadata and emits flat `download_url`s, for a downloader that can't glob.)
- **Dedup.** An item can appear under multiple collections; dedup by `ia_identifier`. If persisted
  to a DB later, push this down to `ON CONFLICT (ia_identifier) DO NOTHING` exactly as
  `scanner.upsert_job` does.
- **Don't drop "unknown" formats.** Emit items whose format advertises no mbox payload with
  `mbox_format="unknown"` rather than dropping them — mirrors `scanner.is_candidate()`'s
  "let downstream verify" stance.

*Verified:* a real run against `usenethistorical` enumerated all **1,019** items in one pass;
format histogram was 1,018 `zip` + 1 `mbox`.

### Stage 2 — Download

For each list record, fetch the mbox payload into working storage:

- `ia download <identifier> --glob '*mbox*'` (or `internetarchive.download(identifier,
  glob_pattern='*mbox*')`) pulls the `.mbox.zip` / `.mbox.gz` and skips the torrent, CSV index, and
  metadata sidecars.
- **Open question (see below):** download volume is large (giganews is ~25k items). Decide
  concurrency, retry, and whether payloads are cached to Wasabi (like video-grabber) or processed
  and discarded.

### Stage 3 — Process (thread + cutoff)

**Locked: maximum fidelity via `wolfpld/usenetarchive` (C++/AGPLv3).** Per group:

```
group.mbox ─ import-source-mbox → LZ4 archive ─ threadify → connectivity graph ─ export-messages → records
                                              └─ kill-duplicates (crosspost dedup)
```

`threadify` reconstructs parent/child links from `References`/`In-Reply-To` **and** quoted-text
matching (recovering links stripped by news↔email gateways). The restored connectivity lives only in
the archive's binary graph (`export-messages` doesn't carry it), so we extract it with a tiny custom
libuat tool **`uat-thread-export`** (`video_grabber/usenet/uat_thread_export.cpp`, ~30 LOC, built in
the image) that emits `message_id \t parent_message_id` TSV. `usenet/threader.py` runs the pipeline +
that tool and returns a `{message_id: {parent, thread_root}}` index.

**usenetarchive is a connectivity oracle only** — `mbox_parser` stays the parser of record (dates,
body, cutoff), and the writer joins the thread index onto parser records **by `message_id`**. The
cutoff + date normalization come from `mbox_parser`:

```sh
python mbox_parser.py --before 2001-09-21 --format jsonl \
    --output-break 50000 -o out/<group>.jsonl <group>.mbox.gz
```

- `mbox_parser` decompresses `.gz`/`.zip` (`_resolve_paths`), splits mboxo correctly
  (`iter_mbox_messages` validates a header line follows each `From ` separator — Google/Usenet bodies
  aren't `From `-escaped), normalizes dates to UTC for `start_date`, and drops undated + post-cutoff
  messages.
- The threaded records (carrying `thread_id`/`parent_id`) are written to Directus at the **Ingest**
  stage (Stage 4 below).

### Stage 4 — Ingest

Map threaded records → `usenet_items` + upsert the group as a `sources` row (`type="usenet"`), via a
`usenet/writer.py` mirroring `directus/writer.py`. Records come from `mbox_parser` JSONL
(`{date_iso, date_source, headers{...}, body{text_plain[],text_html[]}}`) enriched with
`thread_id`/`parent_id` from `threadify`.

**Field mapping → `usenet_items`** (header values may be a string, a list, or absent):

| Directus column | Source | Transform |
|---|---|---|
| `start_date` | `date_iso` | Normalise to UTC, **strip the offset** → naive `YYYY-MM-DDTHH:MM:SS` (Directus `dateTime` is naive). |
| `source` (FK) | the mbox's group | Upsert a `sources` row `{slug:<group>, name:<group>, type:"usenet"}`; set `source` to its id. Cache slug→id per run (idempotent on `slug`). |
| `subject` | `headers.subject` | first value if list; truncate to 255 |
| `author` | `headers.from` | first value if list |
| `message_id` | `headers["message-id"]` | first value if list; **not unique** (crossposts repeat) |
| `references` | `headers.references` | raw, space-joined if list; column is double-quoted in SQL (reserved word) |
| `in_reply_to` | `headers["in-reply-to"]` | first value if list, else null |
| `thread_id` | `threadify` | root post's `message_id` (portable id) |
| `parent_id` | `threadify` | immediate parent's `message_id` |
| `body` | `body.text_plain` | join with `\n`; fall back to HTML-stripped `text_html` |
| `date_source` | `date_source` | passthrough (QA: which header gave the date) |
| `approved` | — | constant `1` |

- Dedup key = (`source`, `message_id`); idempotent re-runs overwrite, never duplicate.
- The newsgroup catalogue is just the `sources` rows of `type="usenet"`; the streamer enumerates them
  via `AvailableNewsgroups`. Per-group counts/date-ranges aren't stored (compute on demand if needed).

## Resolved decisions (settled 2026-06-17)

1. **Orchestration host** → **Prefect flow in `video-grabber`** (`video_grabber/usenet/`). Reuses the
   GitOps/Argo deploy path, retries, failed-job-keeps semantics ([[feedback-keep-failed-jobs]]), and
   Prefect visibility for a 26k-item run.
2. **State store** → **`usenet_jobs` table** with stages (`discovered`/`downloading`/`downloaded`/
   `processing`/`processed`/`failed`), like `video_jobs`, for idempotent rescans. (Migration `002`.)
3. **Storage policy** → cache raw mbox payloads to scratch PVC and process; Wasabi caching optional
   later (reprocessable). Decide per-item retention when wiring the flow.
4. **Download concurrency + rate limiting** → drain via blocking `run_deployment` like video-grabber;
   `IA_RATE_PER_SEC` sleep between requests.
5. **Ingestion contract** → Stage 4 below (channel `usenet`; `usenet_items` + `sources` type=usenet;
   naive-UTC; threading fields; field-mapping table).
6. **Threading** → **`wolfpld/usenetarchive`** (C++/AGPLv3), max fidelity (Stage 3).
7. **Cutoff** → `--before 2001-09-21`.

## Execution phases & status

| Phase | Scope | Status |
|---|---|---|
| 1 | config (`USENET_COLLECTIONS`/`USENET_BEFORE`) + `usenet_jobs` migration `002` + `usenet/scanner.py` | ✅ done, tested |
| 2 | `usenet/downloader.py` — fetch mbox payload (resume/retry) | ✅ done, tested |
| 3 | `uat_thread_export.cpp` (custom libuat tool) + `usenet/threader.py` wrapper (`import→kill-duplicates→extract-msgid→connectivity→threadify→thread-export`) | ✅ done; Python tested, C++ syntax-verified vs libuat |
| 4 | `usenet/writer.py` — Directus upsert (`sources`) + replace `usenet_items` per group | ✅ done, tested |
| 5 | `usenet/processor.py` (parse+thread join) + `usenet/flows.py` Prefect flows + `serve` registration | ✅ done; processor tested, flows CI-gated (prefect) |
| 6 | Dockerfile (multi-stage usenetarchive build + custom tool + mbox_parser) + CI vendor step + k8s env | ✅ done |

**Unverified until first image build:** the usenetarchive C++ build stage in the Dockerfile (needs
CMake 3.29 + network for CPM) — the one piece no unit test covers. Everything Python is green (31
runnable tests). Sequencing for first run: validate the full chain end-to-end on `usenethistorical`
(smallest, all in-scope) before scaling to `giganews`.

## Broader feature scope (outside this ingestion plan)

The newsgroups feature spans more than ingestion (tracked in memory `project-usenet-feature.md`):
- **Backend `usenet` channel** + **`sources` `type` refactor** — ✅ done (built + tested; see
  `packages/backend/` and `docs/websocket-protocol.md`).
- **Frontend Newsgroups app** + `MediaStreamProvider` wiring — ✅ done (`Applications/Newsgroups/`;
  tsc clean, 56 frontend tests green).
- **Pager → `sources` (`type="pager"`) migration** — ✅ done (backend reads provider via sources
  join; `seed.mjs` adds the `source` FK + `migratePagerSources` idempotent backfill that keeps the
  legacy `provider` column as the import field/audit trail).

## Automation & follow-ups (done)

- **scan-usenet** → one-shot trigger: `k8s/usenet-scan-job.yaml` (`run_deployment`, fire-and-forget).
  Apply once to kick off scanning; not an ArgoCD hook (one-time, not per-sync).
- **dispatch-usenet** → scheduled every 5 min in `serve.py` (`interval=300`); each run drains the
  queue then stops, so the pipeline self-drives after the one-time scan.
- **Backlog pagination** → `usenet_more {newsgroups, before}` message + `db.OlderUsenetItems`;
  frontend "Load older messages" button.
- **Per-group counts** → precomputed `message_count` on the `sources` row (set by the writer),
  surfaced as `sources.usenet: [{name, count}]` and shown in the browse list.
- **Spam filtering** → skipped (usenetarchive `filter-spam` available but not wired, per decision).
- **Seed as a Job** → `packages/backend/Dockerfile.seed` + `k8s/seed-job.yaml` (node + psql-client;
  runs `node seed.mjs` against in-cluster Directus/Postgres; idempotent).
