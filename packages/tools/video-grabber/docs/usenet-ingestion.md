# Usenet newsgroup ingestion

Downloads historical Usenet newsgroup archives from the Internet Archive, **threads**
them, and writes them to Directus for the streamer's `usenet` channel and the
frontend Newsgroups app. Scoped to messages posted **on or before Sep 20 2001**.

Code lives in [`video_grabber/usenet/`](../video_grabber/usenet/). The original
design/execution plan is [`plans/usenet-archive-ingestion.md`](../../../../plans/usenet-archive-ingestion.md)
(repo root); this doc is the living architecture + operations reference.

---

## End-to-end data flow

```
Internet Archive (.mbox.zip / .mbox.gz, one item ≈ one newsgroup)
        │  scan          (scanner.py → usenet_jobs)
        ▼
   usenet_jobs  ── dispatch ──►  process-usenet-item (per item)
        │                              │
        │   download (downloader.py)   │
        ▼                              ▼
   <group>.mbox.zip ──► decompress ──► usenetarchive build ──► thread index
        │                          (threader.py)            {msgid: {parent, thread}}
        │                                                          │
        ├──► mbox_parser  ──► JSONL records (dates, body, cutoff)  │
        │        (processor.py)                                    │
        ▼                                                          ▼
   join by message_id  ────────────────────────────────────────────
        │  (processor.py)
        ▼
   group by newsgroup ──► writer.py ──► Directus: sources(type=usenet) + usenet_items
        │
        ▼
   streamer `usenet` channel ──► frontend Newsgroups app
```

The feature spans three packages:

| Layer | Where | What |
|---|---|---|
| Parser | `packages/tools/mbox_parser/mbox_parser.py` | mbox → JSONL: UTC dates, body, cutoff, mboxo-safe splitting |
| Ingestion | `packages/tools/video-grabber/video_grabber/usenet/` | scan → download → thread → process → write (this doc) |
| Streamer channel | `packages/backend/internal/{model,db,session,handler}` | the opt-in `usenet` WebSocket channel |
| Frontend | `packages/frontend/src/Applications/Newsgroups/` | browse groups → threaded messages → message detail |

---

## Ingestion modules

| Module | Role |
|---|---|
| `scanner.py` | Enumerate the configured IA collections into `usenet_jobs` (`ON CONFLICT` dedup). |
| `downloader.py` | Fetch the `.mbox.zip`/`.mbox.gz` payload (byte-range resume), skipping sidecars. |
| `threader.py` | Run usenetarchive + the custom `uat-thread-export` tool; return `{msgid: {parent, thread}}`. |
| `processor.py` | Run `mbox_parser`, join the thread index by `message_id`, group by newsgroup. |
| `writer.py` | Upsert `sources` (type=usenet) + replace `usenet_items` per group (size-batched). |
| `flows.py` | Prefect flows: `scan-usenet`, `process-usenet-item`, `dispatch-usenet`. |
| `uat_thread_export.cpp` | ~30-line libuat tool; dumps `message_id \t parent_message_id` TSV. |

The `usenet_jobs` state table (migration `002`) mirrors `video_jobs`:
`discovered → downloading → downloaded → processing → processed | failed`.

---

## The usenetarchive integration (the crux)

usenetarchive (C++/AGPL) is used **only as a connectivity oracle**: `mbox_parser`
stays the parser of record (dates/body/cutoff), and usenetarchive supplies the
restored thread links — including quote-matched ones recovered for messages whose
headers lost them. The two join on `message_id`.

### Why the full build pipeline is required

`threadify` (and our `uat-thread-export`) open the archive via libuat's
`Archive::Open`, which requires a **complete** archive — the zstd message store,
lexicon, strings, connectivity, and msgid tables. So the build must run the whole
sequence, in dependency order, not just `connectivity`:

```
(decompress .zip/.gz → plain .mbox)     # import-source-mbox does NOT decompress
import-source-mbox <mbox> <raw>
kill-duplicates    <raw>  <arch>
extract-msgid      <arch>   # mid* table
connectivity       <arch>   # conn* graph + toplevel + Date parse   [needs msgid]
extract-msgmeta    <arch>   # str* (From/Subject)
repack-zstd -s 24  <arch>   # zstd store (zmeta/zdata/zdict); -s caps dict memory
lexicon            <arch>   # lex* word index                       [needs connectivity]
lexsort            <arch>   # sort lex*
threadify          <arch>   # restore missing links                 [needs lexsort]
uat-thread-export  <arch>  > msgid \t parent_msgid TSV
```

The binaries are built into the worker image (multi-stage `Dockerfile`,
`MARCH_NATIVE=OFF` so they run on the encode node, not just the CI builder). The
custom `uat-thread-export` is compiled against libuat in that same stage.

### Large-group fallback

The full build (especially `repack-zstd` dictionary training) is memory-heavy and
OOM-kills the worker on very large groups. Above `USENET_MAX_THREADIFY_MESSAGES`
(default 100k), `processor.py` skips usenetarchive entirely and threads from
`References`/`In-Reply-To` headers (jwz-style) — losing only quote-restoration.

---

## Operating

The pipeline self-drives once started, like `video_jobs`: a one-time scan enumerates
work, and the scheduled `dispatch-usenet` (every 5 min, 4-wide) drains it.
Idempotent and fail-and-keep throughout.

### Start a run

```python
# inside the worker pod (has PREFECT_API_URL):
from prefect.deployments import run_deployment
run_deployment(name="scan-usenet/scan-usenet", timeout=0)                       # both collections
# or scoped:  parameters={"collections": ["usenethistorical"]}
```
`dispatch-usenet` is registered with a 5-min schedule by `serve.py`; a worker
restart re-activates it. To **pause**, set the deployment schedule inactive
(`client.update_deployment_schedule(dep_id, sched_id, active=False)`); in-flight
items finish, the queue holds.

> Note: the scan sleeps `1/IA_RATE_PER_SEC` (0.5 s) **per item**, so a ~26k-item
> scan takes ~4 h. It overlaps with processing (dispatch claims `discovered` rows as
> they commit, every 100), so it isn't the bottleneck — processing 26k archives is.

### Monitor

```bash
# stage breakdown (source of truth for remaining work)
kubectl -n video-grabber exec -i deploy/video-grabber-worker -- python -c "
import sqlalchemy as sa; from video_grabber.usenet.flows import get_db; db=get_db()
print(dict(db.execute(sa.text(\"SELECT stage,count(*) FROM usenet_jobs GROUP BY stage\")).fetchall()))"

# failures (kept; auto-retried up to 3×). error_message carries the tool's stderr /
# the Directus response body — a failed step is diagnosable here.
kubectl -n video-grabber exec -i deploy/video-grabber-worker -- python -c "
import sqlalchemy as sa; from video_grabber.usenet.flows import get_db; db=get_db()
[print(r) for r in db.execute(sa.text(\"SELECT ia_identifier,left(error_message,90) FROM usenet_jobs WHERE stage='failed' LIMIT 10\"))]"
```
Output (`usenet_items`, `sources WHERE type='usenet'`) is in the Directus DB
(`rt911` namespace), not the video-grabber DB.

### Config (env)

| Var | Default | Meaning |
|---|---|---|
| `USENET_COLLECTIONS` | `usenethistorical,giganews` | IA collections to scan |
| `USENET_BEFORE` | `2001-09-21` | per-message cutoff (`mbox_parser --before`) |
| `USENET_MAX_THREADIFY_MESSAGES` | `100000` | above this → header-threading fallback |
| `USENETARCHIVE_BIN` | (image: `/usr/local/bin`) | dir holding the usenetarchive binaries |
| `MBOX_PARSER` | (image path) | path to `mbox_parser.py` |

### Deploy

Same GitOps path as the rest of video-grabber (land on `main` → CI builds the image →
ArgoCD rolls the worker; migration `002` runs via the migrate Job). One-shot k8s
Jobs: [`k8s/usenet-scan-job.yaml`](../k8s/usenet-scan-job.yaml) (trigger a scan) and,
on the backend side, the Directus schema is created by `packages/backend/seed.mjs`
(run via `packages/backend/k8s/seed-job.yaml`, built by `build-rt911-seed.yml`).

---

## Gotchas & lessons (found validating live)

These bit during the first production run; each is now fixed but the *why* is worth
keeping. The recurring theme: usenetarchive's CLI/output conventions are
under-documented, and 25-year-old message data is dirty.

| Symptom | Cause | Fix |
|---|---|---|
| `import-source-mbox` reports "0 files processed" | It does **not** decompress; fed the `.zip` it read empty | decompress `.zip`/`.gz` first (`threader._ensure_plain_mbox`) |
| `threadify`/`uat-thread-export`: "Cannot open `<arch>`" | `Archive::Open` needs the **full** archive (zstd+lex+str), not just connectivity | run the complete build sequence |
| `threadify` "fails" with exit 1 after printing success | `return cntsure != 0 ? 1 : 0` — 1 = "matched, re-run sort", **not** an error | accept exit codes `{0,1}` |
| Garbled/binary message-ids in the TSV | msgids are `StringCompress`-packed in the archive | `Archive::UnpackMsgId` to decompress |
| Worker OOM-killed during `repack-zstd` | dict training needs ~10× the dict size in RAM | `repack-zstd -s 24` (16 MiB dict cap) + large-group header fallback |
| Threading "works" but every message is a singleton | usenetarchive stores ids **without** `<>`, mbox_parser keeps them | `normalize_msgid` strips brackets on both sides; ids stored bracket-less |
| Directus `400` on insert | NUL bytes (`\x00`) in old message bodies; Postgres text rejects them | strip NUL in `writer._clean` |
| Directus `400` "request entity too large" | 500-row batch of full bodies exceeds ~1 MB `MAX_PAYLOAD_SIZE` | size-based batching (<900 KB) + 200 KB body cap |
| Junk newsgroup names (`-h`, `!.!`, `1`) as sources | malformed `Newsgroups:` headers in bundled archives | `processor.valid_newsgroup` — drop messages with no valid group |

A debugging aid that paid off twice: `threader._run` and `writer._raise` include the
**tool stderr / Directus response body** in the raised error, so a failed step is
diagnosable straight from `usenet_jobs.error_message` instead of a bare exit code.

---

## Streamer channel (consumer side)

The `usenet` channel is the one streamer channel served **directly from Postgres,
not Redis** — messages carry full bodies, far too large to warm into the cache, and
delivery is gated to the group(s) a client is viewing (so query volume is low). It is
the documented exception to the streamer's "tick = Redis" rule. Newsgroups are
`sources` rows of `type="usenet"`; `usenet_items.source` is the FK. See
`packages/backend/docs/websocket-protocol.md` for the wire protocol
(`usenet_filter` / `usenet_more` / the `usenet` frame).
