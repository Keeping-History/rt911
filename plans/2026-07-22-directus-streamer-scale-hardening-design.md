# Directus + Streamer Scale Hardening — Design

**Date:** 2026-07-22
**Author:** Robbie Byrd (with Claude)
**Status:** Approved for planning
**Goal:** Survive an unpredictable viral traffic spike (10–100× burst) against a single-node k3s deployment, with graceful degradation instead of collapse. Fix the baseline saturation that already exists at idle along the way.

---

## 1. Context

911realtime.org v2 runs entirely on one k3s node (`dev.keepinghistory.org`). The public site is fronted by Cloudflare. Three data tiers live in the `rt911` namespace, all **single-replica**:

- `rt911-api` — Directus 12.1.1 (REST data platform), image `ghcr.io/keeping-history/rt911-api`, port 8055
- `rt911-db` — Postgres 16 (Directus's database; **also hosts Prefect's DB**)
- `rt911-cache` — Redis 7 (currently consumed by the **streamer**, not Directus)
- `rt911-streamer` — Go WebSocket backend
- `rt911-frontend` — Vite/React SPA

Config for Directus comes from ConfigMap `rt911-config`, managed in the **separate GitOps repo `github.com/Keeping-History/infra`** (ArgoCD `selfHeal: true` — imperative cluster edits get reverted, so all durable changes land in that repo).

## 2. Diagnosis

### 2.1 Root cause — a 143 GB unindexed audit log

Directus records a `directus_activity` + `directus_revisions` row for every write through its items API. The video-grabber pipeline writes hundreds of thousands of rows, so on a system replaying **immutable 2001 data** the audit log has ballooned:

| Table | Rows | Size |
|---|---|---|
| `directus_revisions` | 41,473,435 | **135 GB** |
| `directus_activity` | 44,625,198 | 7.6 GB |

Directus repeatedly runs, on item reads:

```sql
select count("directus_revisions"."id")
from "directus_revisions"
where collection = $1 and item = $2 and version is null
```

`directus_revisions` has indexes only on `id` (pk), `parent`, `activity` — **none on `(collection, item)`**. So every count is a **full sequential scan of a 135 GB table**. Live snapshot of `pg_stat_activity` found **12 of these running concurrently, each stuck 7–12 minutes, all blocked on `IO`**. This pins `rt911-db` at its full 1-core CPU limit *at idle*. Under a spike it does not degrade — it is already saturated, so it collapses.

### 2.2 Supporting findings

- **Directus caching is completely disabled.** No `CACHE_ENABLED`, no `CACHE_STORE`, no Redis store configured. Every API read hits Postgres. Verified: `env | grep -E 'CACHE|REDIS|RATE_LIMITER'` inside the pod returns nothing but k8s service-discovery vars.
- **No edge caching.** No `Cache-Control`/`s-maxage` on Directus responses; no Cloudflare cache rule for `api-beta.911realtime.org`. Every public read reaches the origin.
- **No rate limiting.** Only CORS middleware sits in front of `rt911-api` at Traefik. Nothing sheds a surge.
- **Postgres runs on stock defaults in a 1 GB container** — `shared_buffers` 128 MB, `effective_cache_size` 4 GB, `work_mem` 4 MB — none tuned for the container, CPU limit 1 core. `max_connections=100`, ~42 in use (headroom fine at 1 replica).
- **Prefect shares `rt911-db`.** The video-grabber pipeline's Prefect database lives on the same Postgres instance (49 GB `prefect` DB alongside the 202 GB `directus` DB), with `idle in transaction` connections — cross-workload contention.
- **Disk at 74%** (608 G / 874 G on `/dev/sda4`). The 143 GB audit log is ~16% of the disk.

### 2.3 Topology confirmation — the streamer is NOT the bottleneck

The Go streamer never calls Directus. It reads Postgres/Redis directly, with a Redis hot-cache and **windowed 1 Hz ticks** (most ticks are no-ops; refills are per-window, not per-second). It is already built for scale. The one shared, uncached per-connection cost is `sendSources` — 4 identical Postgres queries (`AvailableVideoSources`, `AvailableAudioSources`, `AvailablePagerProviders`, `AvailableNewsgroups`) fired on every WebSocket `init`, time-independent and identical for all clients. Minor, but a free win.

Directus REST is consumed **only by the frontend**, for editor/auth/bookmarks/POIs/flight-tracks/readme (polled every 60 s)/hypercard side data. The live media path is the WebSocket to the streamer and does not touch Directus.

## 3. Design

Four tiers, ordered by leverage. Tier 0 stops the current bleeding; Tier 1 is the actual spike-survival mechanism; Tiers 2–3 add capacity and trim residual load.

### Tier 0 — Root-cause remediation (live DB runbook + Directus config)

Executed as an ordered runbook against `rt911-db`. **Irreversible by design** (approved: the audit trail has no functional value for immutable replay data).

1. **Terminate the stuck scans** — reclaim the CPU immediately:
   ```sql
   SELECT pg_terminate_backend(pid)
   FROM pg_stat_activity
   WHERE query ILIKE 'select count("directus_revisions"%' AND state = 'active';
   ```
2. **Quiesce writers** — scale the video-grabber worker to 0 (or pause the Prefect deployment) so no Directus-API write holds a lock during the truncate. Restore afterward.
3. **Truncate the audit log** — instant, reclaims ~143 GB to the filesystem (unlike `DELETE`, which needs `VACUUM FULL` + an exclusive lock):
   ```sql
   TRUNCATE directus_revisions, directus_activity RESTART IDENTITY;
   ```
   FK safety confirmed: `directus_revisions.activity → directus_activity` is `ON DELETE CASCADE`, and nothing outside these two tables references them, so truncating both together is clean.
4. **Add the missing index** on the now-empty table (instant; prevents recurrence even if the log regrows):
   ```sql
   CREATE INDEX directus_revisions_collection_item_index
   ON directus_revisions (collection, item);
   ```
5. **Stop regrowth at the source** — set accountability to `null` on the pipeline-written data collections so Directus creates no new activity/revisions for them:
   ```sql
   UPDATE directus_collections SET accountability = NULL
   WHERE collection NOT LIKE 'directus_%';  -- refined to the pipeline collections during planning
   ```
6. **Cap regrowth by config** (belt-and-suspenders, in `rt911-config`): `RETENTION_ENABLED=true`, `REVISIONS_RETENTION='7d'`, `ACTIVITY_RETENTION='30d'`, `FLOW_LOGS_RETENTION='30d'`. Directus's built-in retention job prunes on a cron so this can never silently regrow to 135 GB again.

**Verification:** `pg_stat_activity` shows no long-running revision counts; `rt911-db` CPU drops off the 1-core ceiling; `df -h` shows ~57% disk; an item read that previously triggered the count returns in ms.

### Tier 1 — Spike hardening (the viral-burst goal)

The single node cannot scale out meaningfully, so the strategy is **serve reads without touching the origin** and **shed abusive load at the edge**.

**1a. Directus Redis data cache** (`rt911-config`, Directus 12.1.1 env):
```
CACHE_ENABLED=true
CACHE_STORE=redis
REDIS=redis://<host>:6379          # unified Redis env (v10.4+)
CACHE_TTL=30m                       # data is immutable; long TTL is safe
CACHE_AUTO_PURGE=true               # purge on writes (keeps editor UX correct)
CACHE_STATUS_HEADER=X-Cache         # HIT/MISS for verification
CACHE_NAMESPACE=directus-cache
```
Redis target: **stand up a dedicated cache Redis** rather than sharing the streamer's `rt911-cache` (avoids the Directus cache and streamer hot-cache contending for the same memory/eviction policy). Small footprint.

**1b. Edge caching via `s-maxage` + Cloudflare** — the actual 100× absorber:
- Directus: `CACHE_CONTROL_S_MAXAGE=3600` so public GET responses carry `s-maxage` (exact 12.1.1 cache-control env surface to be confirmed against docs during planning).
- Cloudflare: a **Cache Rule** matching `api-beta.911realtime.org/items/{public collections}` (map_pois, flight_tracks, flight_positions, readme_articles, news_items, sources, tv_channels) → *Eligible for cache*, Edge TTL = respect origin, so Cloudflare serves the burst from its edge.
- **CORS/`Vary` gotcha:** api-beta stamps `Access-Control-Allow-Origin: *` at Traefik and Cloudflare ignores `Vary` (documented prior incident). Since ACAO is a constant `*`, caching is safe — but the plan must verify no per-origin/credentialed variance leaks into the cached public responses (the credentialed ingress `rt911-api-credentialed` stays uncached).

**1c. Rate limiting for graceful degradation:**
- Directus built-in, Redis-backed: `RATE_LIMITER_ENABLED=true`, `RATE_LIMITER_STORE=redis`, `RATE_LIMITER_POINTS`, `RATE_LIMITER_DURATION` — protects the app tier.
- Traefik `rateLimit` + `inFlightReq` middleware on the `rt911-api` ingress — sheds a surge before it reaches Directus at all. Tuned to allow legitimate burst but cap per-IP abuse.

### Tier 2 — Postgres capacity (infra repo)

7. **Raise `rt911-db` limits** — CPU well above 1 core (it is the hard wall), memory to match tuning.
8. **Tune Postgres for the container** — `shared_buffers` (~25% of container RAM), `effective_cache_size` (~50–75%), `work_mem`, `max_connections` sane for a single pooled consumer. Via a mounted `postgresql.conf`/args in the infra repo.
9. **Move Prefect off `rt911-db`** — point the video-grabber's Prefect at `db/postgresql-0` (or its own instance) to end cross-workload contention and the idle-in-transaction connections on the Directus DB.

### Tier 3 — Streamer (this repo, `packages/backend`)

10. **In-memory TTL cache for `sendSources`** — the 4 identical, time-independent queries are computed once and reused across all WebSocket inits (short TTL + refresh, or invalidate on NOTIFY). Removes 4 Postgres queries per connection under a connection storm.

## 4. Rollout & repo split

| Change | Where | Reversible? |
|---|---|---|
| Tier 0 steps 1–5 (kill/truncate/index/accountability) | Live SQL runbook on `rt911-db` | No (truncate); index/accountability yes |
| Tier 0 step 6 (retention env) | infra `rt911-config` | Yes |
| Tier 1a/1b/1c Directus env | infra `rt911-config` (+ new Redis manifest) | Yes |
| Tier 1b Cloudflare cache rule | Cloudflare dashboard/API | Yes |
| Tier 1c Traefik middleware | infra ingress manifests | Yes |
| Tier 2 Postgres resources/tuning | infra `rt911-db` manifests | Yes |
| Tier 2 Prefect DB move | infra + video-grabber config | Yes |
| Tier 3 streamer cache | this repo `packages/backend` | Yes (code) |

**Ordering:** Tier 0 first (unblocks everything and is safe once the index exists). Then Tier 1 (biggest spike leverage). Tier 2 and Tier 3 can proceed in parallel afterward. Each infra change is a commit to `Keeping-History/infra`; ArgoCD syncs. Directus ConfigMap changes require a manual `rt911-api` restart (no Reloader — known).

## 5. Verification per tier

- **Tier 0:** `pg_stat_activity` clean; `kubectl top pod rt911-db` off the CPU ceiling; `df -h` ~57%; item-read latency in ms.
- **Tier 1a:** `X-Cache: HIT` on repeat GETs; Postgres query rate drops on repeated reads.
- **Tier 1b:** `cf-cache-status: HIT` at the edge for public collection GETs; origin request count flat under repeated external fetches.
- **Tier 1c:** 429s returned past the configured rate; Directus stays responsive under a synthetic burst (load test).
- **Tier 2:** `rt911-db` CPU headroom under load; no Prefect connections on the `directus` DB.
- **Tier 3:** WebSocket init issues 0 `sendSources` Postgres queries after cache warm (log/metric).

## 6. Risks & mitigations

- **Truncate is irreversible** — accepted; audit trail is meaningless for immutable replay data. Mitigate by quiescing writers first and confirming FK scope (done).
- **Cache staleness in the editor** — `CACHE_AUTO_PURGE=true` keeps writes visible; editor auth path stays uncached.
- **Edge-caching a credentialed/varying response** — keep the credentialed ingress uncached; verify ACAO is a constant before enabling the Cloudflare rule.
- **Directus restart = downtime** (`strategy: Recreate`, 1 replica) — every ConfigMap change takes a brief outage; batch env changes into as few restarts as possible.
- **Shared checkout** — this repo's changes are developed in a git worktree to avoid concurrent-session branch collisions.

## 7. Out of scope / follow-ups

- Horizontal Directus replicas + pgBouncer (little value on a single node; revisit only if the node is split or moved).
- Frontend README 60 s polling — becomes cheap once edge-cached; revisit only if still hot.
- `CurrentWeatherForecast` `LIKE '%zone%'` unindexable scan and `Mp3ItemHistory` unbounded lower bound — minor streamer query-shape cleanups, noted for later.
