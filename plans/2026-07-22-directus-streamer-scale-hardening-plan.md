# Directus + Streamer Scale Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden Directus and the streamer so the single-node k3s deployment survives an unpredictable viral traffic spike (10–100×) with graceful degradation, and cap the audit-log regrowth that caused the baseline saturation.

**Architecture:** Shed reads before they reach the origin (Directus Redis data cache → `s-maxage` → Cloudflare edge cache), shed abusive load at the edge (Directus + Traefik rate limiting), give Postgres real capacity (CPU/tuning, and remove Prefect contention), and remove the last per-connection Postgres cost in the streamer (`sendSources` memoization). Design spec: `plans/2026-07-22-directus-streamer-scale-hardening-design.md`.

**Tech Stack:** Directus 12.1.1 (env config), Postgres 16, Redis 7, Traefik (IngressRoute/Middleware CRDs), Cloudflare (Cache Rules), Kustomize/ArgoCD GitOps (`github.com/Keeping-History/infra`, checked out at `/home/robbiebyrd/infra`), Go 1.25 streamer (`packages/backend`).

## Global Constraints

- **GitOps only for cluster state.** ArgoCD `selfHeal: true` reverts imperative edits. All durable manifest/config changes land as commits in `/home/robbiebyrd/infra` (`apps/rt911/`). Never `kubectl set image`/`edit`/`patch` for durable changes.
- **Directus ConfigMap changes require a manual `rt911-api` rollout restart** — there is no Reloader in this namespace.
- **Directus is single-replica `strategy: Recreate`** — every restart is a brief full outage. Batch env changes to minimize restarts.
- **Tier 0 acute fix is already applied** (2026-07-22): `directus_revisions`/`directus_activity` truncated, `directus_revisions_collection_item_index` on `(collection, item)` created, disk reclaimed 74%→57%. This plan covers the *remaining* work only.
- **Public vs credentialed CORS is already split** at Traefik: public paths get `ACAO: *`; `/auth`, `/users`, `/items/playlists` get `api-cors-credentialed` + `Cache-Control: no-store`. Do not edge-cache credentialed paths.
- **Verify before claiming done** — every infra task ends with a `kubectl`/`curl` check whose expected output is shown.

---

## Task 1: Stop audit-log regrowth (Directus retention + accountability)

Caps the table that caused the incident so it can never silently return to 135 GB. The `(collection,item)` index already makes counts cheap, so this is write-amplification + size control, not urgent.

**Files:**
- Modify: `/home/robbiebyrd/infra/apps/rt911/configmap.yaml` (add retention keys to `rt911-config`)
- Live DB: `rt911-db` (accountability update — folded into this task's rollout window)

**Interfaces:**
- Produces: retention env keys and disabled accountability that later tasks assume are present (no code interface).

- [ ] **Step 1: Add retention env to the ConfigMap.** In `configmap.yaml`, under `data:` (near the Directus section), add:

```yaml
  # --- Audit-log retention (caps directus_activity/revisions growth) --------
  # Immutable replay data: no functional need for a deep audit trail. The
  # (collection,item) index keeps counts cheap regardless, this caps SIZE.
  RETENTION_ENABLED: "true"
  RETENTION_SCHEDULE: "0 3 * * *"   # nightly 03:00
  RETENTION_BATCH: "10000"
  ACTIVITY_RETENTION: "30d"
  REVISIONS_RETENTION: "7d"
  FLOW_LOGS_RETENTION: "30d"
```

- [ ] **Step 2: Disable accountability on pipeline-written collections.** Run against `rt911-db` (keeps teacher-authored collections' history; nulls the bulk pipeline ones):

```bash
kubectl exec -n rt911 deploy/rt911-db -- psql -U directus -d directus -c "
UPDATE directus_collections SET accountability = NULL
WHERE collection NOT LIKE 'directus_%'
  AND collection NOT IN ('playlists','stacks','tm_bookmarks','readme_articles','readme_tags');"
```

Expected: `UPDATE <n>` where n = number of pipeline/data collections.

- [ ] **Step 3: Commit the infra change.**

```bash
cd /home/robbiebyrd/infra && git add apps/rt911/configmap.yaml && \
git commit -m "feat(rt911): cap Directus audit-log growth via retention env"
```

- [ ] **Step 4: Apply + restart Directus (one restart shared with Task 2/3/4 if done together).**

```bash
kubectl apply -k /home/robbiebyrd/infra/apps/rt911/
kubectl rollout restart -n rt911 deploy/rt911-api
kubectl rollout status  -n rt911 deploy/rt911-api --timeout=120s
```

Expected: `deployment "rt911-api" successfully rolled out`.

- [ ] **Step 5: Verify.** Confirm env present and accountability nulled:

```bash
kubectl exec -n rt911 deploy/rt911-api -- printenv RETENTION_ENABLED REVISIONS_RETENTION
kubectl exec -n rt911 deploy/rt911-db -- psql -U directus -d directus -tc \
  "SELECT count(*) FROM directus_collections WHERE accountability IS NULL AND collection NOT LIKE 'directus_%';"
```

Expected: `true` / `7d`, and a non-zero count.

---

## Task 2: Directus Redis data cache

Turns repeat reads into Redis HITs instead of Postgres queries. Dedicated Redis (not the streamer's `rt911-cache`) to avoid eviction contention.

**Files:**
- Create: `/home/robbiebyrd/infra/apps/rt911/directus-cache.yaml` (new Redis Deployment + Service)
- Modify: `/home/robbiebyrd/infra/apps/rt911/kustomization.yaml` (add the new resource)
- Modify: `/home/robbiebyrd/infra/apps/rt911/configmap.yaml` (cache env)

**Interfaces:**
- Produces: Service `rt911-directus-cache:6379`; env `CACHE_ENABLED/CACHE_STORE/REDIS/CACHE_TTL/CACHE_AUTO_PURGE/CACHE_STATUS_HEADER` (Task 4 reuses this Redis for the rate limiter).

- [ ] **Step 1: Create the cache Redis manifest** `directus-cache.yaml` (in-memory LRU, no persistence needed for a cache):

```yaml
# Dedicated Redis for the Directus data cache + rate limiter. Ephemeral: a
# cache miss after a restart is harmless, so no PVC/AOF (unlike rt911-cache).
apiVersion: apps/v1
kind: Deployment
metadata:
  name: rt911-directus-cache
spec:
  replicas: 1
  strategy: { type: Recreate }
  selector: { matchLabels: { app: rt911-directus-cache } }
  template:
    metadata: { labels: { app: rt911-directus-cache } }
    spec:
      containers:
        - name: redis
          image: redis:7-alpine
          args: ["--maxmemory", "384mb", "--maxmemory-policy", "allkeys-lru", "--save", ""]
          ports: [{ containerPort: 6379 }]
          readinessProbe:
            exec: { command: ["redis-cli", "ping"] }
            initialDelaySeconds: 2
            periodSeconds: 5
          resources:
            requests: { cpu: 50m, memory: 128Mi }
            limits:   { cpu: 500m, memory: 512Mi }
---
apiVersion: v1
kind: Service
metadata:
  name: rt911-directus-cache
spec:
  selector: { app: rt911-directus-cache }
  ports: [{ port: 6379, targetPort: 6379 }]
```

- [ ] **Step 2: Register the resource** in `kustomization.yaml` — add `- directus-cache.yaml` to the `resources:` list (after `redis.yaml`).

- [ ] **Step 3: Add cache env** to `configmap.yaml`:

```yaml
  # --- Directus data cache (rt911-directus-cache) ----------------------------
  CACHE_ENABLED: "true"
  CACHE_STORE: "redis"
  REDIS: "redis://rt911-directus-cache:6379"
  CACHE_TTL: "30m"            # data is immutable; long TTL is safe
  CACHE_AUTO_PURGE: "true"    # keep editor writes visible
  CACHE_STATUS_HEADER: "X-Cache"
  CACHE_NAMESPACE: "directus-cache"
```

- [ ] **Step 4: Commit + apply + restart.**

```bash
cd /home/robbiebyrd/infra && git add apps/rt911/directus-cache.yaml apps/rt911/kustomization.yaml apps/rt911/configmap.yaml && \
git commit -m "feat(rt911): enable Directus Redis data cache (dedicated instance)"
kubectl apply -k /home/robbiebyrd/infra/apps/rt911/
kubectl rollout status -n rt911 deploy/rt911-directus-cache --timeout=90s
kubectl rollout restart -n rt911 deploy/rt911-api && kubectl rollout status -n rt911 deploy/rt911-api --timeout=120s
```

Expected: both rollouts succeed.

- [ ] **Step 5: Verify cache HIT.** Two identical public reads; second must be a HIT:

```bash
curl -s -D- -o /dev/null "https://api-beta.911realtime.org/items/tv_channels?limit=1" | grep -i x-cache
curl -s -D- -o /dev/null "https://api-beta.911realtime.org/items/tv_channels?limit=1" | grep -i x-cache
```

Expected: first `X-Cache: MISS`, second `X-Cache: HIT`. If both MISS, the auto-purge or a `Cache-Control: no-store` upstream is defeating it — inspect the Traefik middleware chain for that path.

---

## Task 3: Edge caching (`s-maxage` + Cloudflare Cache Rule)

The actual 100× absorber: Cloudflare serves the burst so the origin sees ~one request per URL per TTL.

**Files:**
- Modify: `/home/robbiebyrd/infra/apps/rt911/configmap.yaml` (`CACHE_CONTROL_S_MAXAGE`)
- Cloudflare dashboard/API: Cache Rule for `api-beta.911realtime.org` (out-of-repo; documented here)

**Interfaces:**
- Consumes: Task 2's cache being live (so origin is cheap on the MISS that refills the edge).
- Produces: `Cache-Control: ... s-maxage=...` on public GETs; `cf-cache-status: HIT` at the edge.

- [ ] **Step 1: Confirm the 12.1.1 cache-control env name** before writing it (avoid a wrong key that silently no-ops):

```
Context7 /directus/docs query: "CACHE_CONTROL_S_MAXAGE and Cache-Control response header configuration in Directus 12"
```

Expected: confirms `CACHE_CONTROL_S_MAXAGE` (seconds). Use whatever the docs confirm.

- [ ] **Step 2: Add the env** to `configmap.yaml`:

```yaml
  CACHE_CONTROL_S_MAXAGE: "3600"   # Cloudflare edge TTL for public GETs
```

- [ ] **Step 3: Commit + apply + restart** (same pattern as Task 2 Step 4; message `feat(rt911): stamp s-maxage on Directus responses for edge caching`).

- [ ] **Step 4: Verify origin header** (through Cloudflare, but read the origin directive):

```bash
curl -s -D- -o /dev/null "https://api-beta.911realtime.org/items/tv_channels?limit=1" | grep -i 'cache-control'
```

Expected: `cache-control:` contains `s-maxage=3600`. Confirm a credentialed path stays `no-store`:

```bash
curl -s -D- -o /dev/null "https://api-beta.911realtime.org/items/playlists?limit=1" | grep -i 'cache-control'
```

Expected: `no-store` present (must NOT be edge-cached).

- [ ] **Step 5: Add the Cloudflare Cache Rule** (dashboard: Rules → Cache Rules, zone `911realtime.org`). Rule: **If** `hostname eq "api-beta.911realtime.org"` and `starts_with(http.request.uri.path, "/items/")` and `http.request.method eq "GET"` → **Cache eligibility: Eligible for cache**, **Edge TTL: Use cache-control header if present**, **Respect origin: on**. (Leave `/auth`, `/users`, `/assets` — assets are already handled by the file-proxy — untouched.)

- [ ] **Step 6: Verify edge HIT.** Two external GETs of the same public URL:

```bash
for i in 1 2; do curl -s -D- -o /dev/null "https://api-beta.911realtime.org/items/tv_channels?limit=1" | grep -i 'cf-cache-status'; done
```

Expected: first `cf-cache-status: MISS`, second `HIT` (or `DYNAMIC`→`HIT` after warm). If it stays `DYNAMIC`, the Cache Rule isn't matching — recheck the expression.

---

## Task 4: Rate limiting (Directus app-tier + Traefik edge)

Graceful degradation under surge/abuse: 429 rather than collapse.

**Files:**
- Modify: `/home/robbiebyrd/infra/apps/rt911/configmap.yaml` (Directus limiter env)
- Modify: `/home/robbiebyrd/infra/apps/rt911/directus.yaml` (Traefik `Middleware` + attach to the IngressRoute)

**Interfaces:**
- Consumes: Task 2's `rt911-directus-cache` Redis (limiter store).
- Produces: 429 responses past threshold; new Traefik middleware referenced by the Directus IngressRoute.

- [ ] **Step 1: Add Directus limiter env** to `configmap.yaml`:

```yaml
  # --- Rate limiter (Redis-backed, shared with the data cache) ---------------
  RATE_LIMITER_ENABLED: "true"
  RATE_LIMITER_STORE: "redis"
  RATE_LIMITER_POINTS: "50"     # requests
  RATE_LIMITER_DURATION: "1"    # per second, per IP
```

- [ ] **Step 2: Read `directus.yaml`** to learn the exact middleware/IngressRoute style in use:

```bash
sed -n '1,200p' /home/robbiebyrd/infra/apps/rt911/directus.yaml
```

Expected: shows existing `Middleware` (`api-cors`, `api-cors-credentialed`) and the IngressRoute/Ingress that lists them — match that exact CRD style.

- [ ] **Step 3: Add a Traefik rate-limit middleware** in `directus.yaml` (adjust `apiVersion`/kind to match what Step 2 showed; typical `traefik.io/v1alpha1`):

```yaml
---
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: api-ratelimit
spec:
  rateLimit:
    average: 40      # sustained req/s per source
    burst: 120       # short burst allowance
    period: 1s
    sourceCriterion:
      ipStrategy:
        depth: 1     # trust one hop (Cloudflare) for the real client IP
```

- [ ] **Step 4: Attach the middleware** to the Directus IngressRoute — add `api-ratelimit` to the `middlewares:` list *before* the CORS middleware on the public route (keep it off the credentialed `/auth` route or set a laxer limit there so logins aren't throttled). Match the reference style from Step 2.

- [ ] **Step 5: Commit + apply + restart.**

```bash
cd /home/robbiebyrd/infra && git add apps/rt911/configmap.yaml apps/rt911/directus.yaml && \
git commit -m "feat(rt911): rate-limit Directus at app tier + Traefik edge"
kubectl apply -k /home/robbiebyrd/infra/apps/rt911/
kubectl rollout restart -n rt911 deploy/rt911-api && kubectl rollout status -n rt911 deploy/rt911-api --timeout=120s
```

- [ ] **Step 6: Verify 429 under burst** (fire >threshold rapidly against a public path; expect some 429s):

```bash
for i in $(seq 1 200); do curl -s -o /dev/null -w "%{http_code}\n" "https://api-beta.911realtime.org/items/tv_channels?limit=1" & done | sort | uniq -c
```

Expected: a mix of `200` and `429` (some requests shed). If all `200`, the limiter isn't attached — recheck the middleware reference. Then confirm a normal single request still returns `200`.

---

## Task 5: Postgres capacity + tuning

`rt911-db` was pinned at its 1-core limit during the incident. Give it headroom and tune for the container.

**Files:**
- Modify: `/home/robbiebyrd/infra/apps/rt911/postgres.yaml` (resources + tuned server args/conf)

**Interfaces:**
- Produces: higher CPU/mem limits and tuned `shared_buffers`/`effective_cache_size`/`work_mem` on `rt911-db`.

- [ ] **Step 1: Read `postgres.yaml`** to see current resources and how args/config are passed:

```bash
cat /home/robbiebyrd/infra/apps/rt911/postgres.yaml
```

Expected: shows `resources.limits` (`cpu: 1`, `memory: 1Gi`) and the container command/args.

- [ ] **Step 2: Raise limits and tune.** Edit `postgres.yaml`: set `resources.limits` to `cpu: "4"`, `memory: 4Gi` (requests `cpu: 500m`, `memory: 2Gi`), and pass tuned settings via container `args` (postgres accepts `-c key=val`):

```yaml
          args:
            - "-c"
            - "shared_buffers=1GB"            # ~25% of 4Gi
            - "-c"
            - "effective_cache_size=3GB"      # ~75%
            - "-c"
            - "work_mem=16MB"
            - "-c"
            - "maintenance_work_mem=256MB"
            - "-c"
            - "max_connections=150"
```

(Keep any existing args; append these. If `postgres.yaml` uses a mounted `postgresql.conf` instead, set the same keys there.)

- [ ] **Step 3: Commit + apply.** Postgres restart = brief DB outage (Directus + streamer reconnect):

```bash
cd /home/robbiebyrd/infra && git add apps/rt911/postgres.yaml && \
git commit -m "feat(rt911): raise rt911-db CPU/mem limits + tune for container"
kubectl apply -k /home/robbiebyrd/infra/apps/rt911/
kubectl rollout status -n rt911 deploy/rt911-db --timeout=180s
```

- [ ] **Step 4: Verify tuning applied.**

```bash
kubectl exec -n rt911 deploy/rt911-db -- psql -U directus -d directus -c "SHOW shared_buffers; SHOW effective_cache_size; SHOW work_mem;"
```

Expected: `1GB`, `3GB`, `16MB`. Confirm the pod's CPU limit rose: `kubectl get deploy -n rt911 rt911-db -o jsonpath='{..limits.cpu}'` → `4`.

---

## Task 6: Move Prefect off the Directus Postgres

Prefect's DB shares `rt911-db` (49 GB `prefect` DB + idle-in-transaction connections), competing with Directus. Point it at the general `db/postgresql-0` instead.

**Files:**
- Modify: video-grabber Prefect DB connection config (infra manifest for the Prefect deployment / its `PREFECT_API_DATABASE_CONNECTION_URL` secret)

**Interfaces:**
- Consumes: an existing/new database on `db/postgresql-0`.
- Produces: zero Prefect connections on `rt911-db`.

- [ ] **Step 1: Locate the Prefect DB URL.** Find where Prefect's connection string is set:

```bash
grep -rn 'PREFECT_API_DATABASE_CONNECTION_URL\|rt911-db' /home/robbiebyrd/infra/apps/video-grabber/ 2>/dev/null
```

Expected: the env/secret pointing Prefect at `rt911-db`.

- [ ] **Step 2: Create a `prefect` DB on `db/postgresql-0`** (the general cluster Postgres):

```bash
kubectl exec -n db postgresql-0 -- psql -U postgres -c "CREATE DATABASE prefect;" || echo "exists"
```

- [ ] **Step 3: Migrate Prefect data** (dump from rt911-db → restore to db/postgresql-0). Prefect state is transient/recreatable, so a clean cutover is acceptable if a dump/restore is heavy — document the choice. For dump/restore:

```bash
kubectl exec -n rt911 deploy/rt911-db -- pg_dump -U directus -d prefect -Fc > /tmp/prefect.dump
# restore into db/postgresql-0 (adjust creds/host per that instance's secret)
```

- [ ] **Step 4: Repoint Prefect** — update the connection URL to `db/postgresql-0` in the video-grabber manifest, commit, apply, restart the Prefect worker/server.

```bash
cd /home/robbiebyrd/infra && git add apps/video-grabber/ && \
git commit -m "feat(video-grabber): move Prefect DB off rt911-db to shared postgres"
kubectl apply -k /home/robbiebyrd/infra/apps/video-grabber/
kubectl rollout restart -n video-grabber deploy/video-grabber-worker
```

- [ ] **Step 5: Verify no Prefect on rt911-db.**

```bash
kubectl exec -n rt911 deploy/rt911-db -- psql -U directus -d directus -tc \
  "SELECT count(*) FROM pg_stat_activity WHERE datname='prefect';"
```

Expected: `0`. And the pipeline still runs (check a Prefect flow completes).

---

## Task 7: Streamer `sendSources` in-memory cache (this repo, TDD)

The 4 `sendSources` queries are identical for every client and time-independent, yet run on every WebSocket `init`. Memoize with a TTL + single-flight so a connection storm issues at most one refresh per interval, not 4 queries per client.

**Files:**
- Create: `packages/backend/internal/db/sources_cache.go`
- Test: `packages/backend/internal/db/sources_cache_test.go`
- Modify: `packages/backend/internal/handler/ws.go:595-613` (`sendSources` reads the cache)
- Modify: `packages/backend/cmd/server/main.go` (construct the cache, pass into the handler)

**Interfaces:**
- Consumes: `db.AvailableVideoSources/AvailableAudioSources/AvailablePagerProviders(ctx, *pgxpool.Pool) ([]string, error)`, `db.AvailableNewsgroups(ctx, *pgxpool.Pool) ([]model.NewsgroupSource, error)`.
- Produces: `type Sources struct { Video, Audio, Pager []string; Usenet []model.NewsgroupSource }` and `func NewSourcesCache(pool *pgxpool.Pool, ttl time.Duration) *SourcesCache` with `func (c *SourcesCache) Get(ctx context.Context) Sources`. `sendSources` calls `Get`.

- [ ] **Step 1: Write the failing test** `sources_cache_test.go`. It proves (a) the underlying queries run once across many concurrent `Get`s within the TTL (single-flight + memo), and (b) a stale/failed refresh still returns the last good value:

```go
package db

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rt911/backend/internal/model" // adjust to the module path in go.mod
)

func TestSourcesCacheMemoizesWithinTTL(t *testing.T) {
	var calls int32
	loader := func(ctx context.Context) (Sources, error) {
		atomic.AddInt32(&calls, 1)
		return Sources{Video: []string{"cnn"}, Usenet: []model.NewsgroupSource{}}, nil
	}
	c := newSourcesCacheWithLoader(loader, time.Minute)

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _ = c.Get(context.Background()) }()
	}
	wg.Wait()

	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("expected loader called once under concurrency, got %d", got)
	}
	if v := c.Get(context.Background()); len(v.Video) != 1 || v.Video[0] != "cnn" {
		t.Fatalf("unexpected cached value: %+v", v)
	}
}

func TestSourcesCacheServesLastGoodOnRefreshError(t *testing.T) {
	var calls int32
	loader := func(ctx context.Context) (Sources, error) {
		if atomic.AddInt32(&calls, 1) == 1 {
			return Sources{Video: []string{"cnn"}}, nil
		}
		return Sources{}, context.DeadlineExceeded
	}
	c := newSourcesCacheWithLoader(loader, time.Nanosecond) // force immediate expiry
	_ = c.Get(context.Background())        // seed
	time.Sleep(time.Millisecond)
	v := c.Get(context.Background())        // refresh fails → last good
	if len(v.Video) != 1 || v.Video[0] != "cnn" {
		t.Fatalf("expected last-good value on refresh error, got %+v", v)
	}
}
```

- [ ] **Step 2: Run the test, verify it fails to compile/fails.**

Run: `cd packages/backend && go test ./internal/db/ -run TestSourcesCache -v`
Expected: FAIL — `undefined: Sources`, `undefined: newSourcesCacheWithLoader`.

- [ ] **Step 3: Implement `sources_cache.go`.**

```go
package db

import (
	"context"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rt911/backend/internal/model" // adjust to go.mod module path
)

// Sources is the time-independent, all-clients-identical source lists sent on init.
type Sources struct {
	Video  []string
	Audio  []string
	Pager  []string
	Usenet []model.NewsgroupSource
}

type sourcesLoader func(ctx context.Context) (Sources, error)

// SourcesCache memoizes Sources with a TTL and single-flight refresh: under a
// connection storm at most one refresh runs per interval, and a failed refresh
// serves the last good value (sources are static, so staleness is harmless).
type SourcesCache struct {
	load sourcesLoader
	ttl  time.Duration

	mu      sync.Mutex
	val     Sources
	fetched time.Time
	valid   bool
	inflight *sync.Once
}

func NewSourcesCache(pool *pgxpool.Pool, ttl time.Duration) *SourcesCache {
	return newSourcesCacheWithLoader(func(ctx context.Context) (Sources, error) {
		var s Sources
		var err error
		if s.Video, err = AvailableVideoSources(ctx, pool); err != nil {
			return Sources{}, err
		}
		if s.Audio, err = AvailableAudioSources(ctx, pool); err != nil {
			return Sources{}, err
		}
		if s.Pager, err = AvailablePagerProviders(ctx, pool); err != nil {
			return Sources{}, err
		}
		if s.Usenet, err = AvailableNewsgroups(ctx, pool); err != nil {
			return Sources{}, err
		}
		return s, nil
	}, ttl)
}

func newSourcesCacheWithLoader(load sourcesLoader, ttl time.Duration) *SourcesCache {
	return &SourcesCache{load: load, ttl: ttl}
}

// Get returns cached Sources, refreshing at most one caller at a time when stale.
func (c *SourcesCache) Get(ctx context.Context) Sources {
	c.mu.Lock()
	fresh := c.valid && time.Since(c.fetched) < c.ttl
	if fresh {
		v := c.val
		c.mu.Unlock()
		return v
	}
	if c.inflight == nil {
		c.inflight = &sync.Once{}
	}
	once := c.inflight
	last := c.val
	hadValue := c.valid
	c.mu.Unlock()

	once.Do(func() {
		v, err := c.load(ctx)
		c.mu.Lock()
		if err == nil {
			c.val, c.fetched, c.valid = v, time.Now(), true
		}
		c.inflight = nil // allow the next refresh after this one settles
		c.mu.Unlock()
	})

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.valid {
		return c.val
	}
	if hadValue {
		return last
	}
	return Sources{}
}
```

- [ ] **Step 4: Run the test, verify it passes.**

Run: `cd packages/backend && go test ./internal/db/ -run TestSourcesCache -v`
Expected: PASS (both tests).

- [ ] **Step 5: Wire the cache into the handler.** In `cmd/server/main.go`, construct once at boot (near the pool setup): `sourcesCache := db.NewSourcesCache(pool, 5*time.Minute)` and thread it to where `sendSources` is invoked (add a `*db.SourcesCache` field to the handler/deps struct that `ws.go` uses; match the existing dependency-passing pattern). Then rewrite `sendSources` (`ws.go:595-613`):

```go
func sendSources(r *http.Request, sess *session.Session, cache *db.SourcesCache, logger *slog.Logger) {
	s := cache.Get(r.Context())
	sess.SendSources(s.Video, s.Audio, s.Pager, s.Usenet)
}
```

Update the call site `ws.go:216` to pass `cache` instead of `pool`. (The `logger` param may become unused — drop it if so, or keep for a future warn.)

- [ ] **Step 6: Build + full test + lint.**

Run:
```bash
cd packages/backend && go build ./... && go test ./... && go vet ./...
```
Expected: build clean, all tests pass (including the existing `TestSendSourcesEmitsSourceLists`), vet clean.

- [ ] **Step 7: Commit.**

```bash
git add packages/backend/internal/db/sources_cache.go packages/backend/internal/db/sources_cache_test.go \
        packages/backend/internal/handler/ws.go packages/backend/cmd/server/main.go
git commit -m "perf(streamer): memoize per-init sendSources queries with TTL + single-flight"
```

---

## Self-Review (completed)

- **Spec coverage:** Tier 0 acute = done pre-plan (noted in constraints); Tier 0 regrowth = Task 1; Tier 1a = Task 2; Tier 1b = Task 3; Tier 1c = Task 4; Tier 2 = Tasks 5–6; Tier 3 = Task 7. All spec sections mapped.
- **Placeholders:** none — every infra step has exact file, command, and expected output; the one env-name uncertainty (Task 3) is gated by an explicit Context7 confirmation step, not left vague.
- **Type consistency:** `Sources`, `NewSourcesCache`, `newSourcesCacheWithLoader`, `Get` used consistently across Task 7 steps; loader returns match the real `db.Available*` signatures (`[]string` ×3, `[]model.NewsgroupSource`); `SendSources(video, audio, pager []string, usenet []model.NewsgroupSource)` matches `session.go:448`.
- **Note for executor:** verify the Go module path in `packages/backend/go.mod` and fix the `model` import path in Task 7 accordingly (`github.com/rt911/backend/...` is illustrative).
