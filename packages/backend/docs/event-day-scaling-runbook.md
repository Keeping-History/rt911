# Event-Day Scaling Runbook — 9/11/2026 Traffic Spike

**Target:** ~30,000 concurrent users in a single hour on 2026-09-11, up from a few hundred/day.
**Nature of the problem:** a **horizontal-scale + edge (CDN) problem**, not a storage-engine problem. See [§10](#10-explicitly-out-of-scope-db-engine-changes).
**Deployment model:** GitOps only. Every change lands in `github.com/Keeping-History/infra` under `apps/rt911/*` and is synced by ArgoCD (`syncPolicy.automated.selfHeal: true`, `prune: true`). **No imperative `kubectl scale`/`kubectl set image`** — selfHeal reverts it within seconds.

> All current values in this document were read directly from the code in this repo and from the live manifests in the infra repo (commit state as of 2026-07-07). Where a number is an **estimate**, it is labelled as such and gated on the load test in [§9](#9-manual-load-test-approach).

---

## 0. TL;DR — what to provision

| Tier | Today | Event-day target |
|---|---|---|
| Frontend SPA (`beta`) | 1 nginx pod, no CDN | Cloudflare-proxied (origin near-idle), keep 2 pods |
| Streamer WSS (`stream-beta`) | 1 pod, `1 CPU / 2Gi` | **~12 pods**, `2 CPU / 2Gi` each, on burst nodes, Cloudflare-proxied |
| Directus/API (`api-beta`) | 1 pod, `1 CPU / 1Gi` | 1–2 pods; content **frozen** during event |
| Postgres | 1 pod, `1 CPU / 1Gi`, 10Gi | Primary `4 CPU / 8Gi` + **1 read replica** + **pgbouncer** |
| Redis | 1 pod, `500m / 1Gi` | `2 CPU / 2Gi`, pinned to primary node; replica optional (see [§5](#5-redis)) |
| Media (`files`) | Cloudflare → file-proxy → Wasabi | **No change** — already built to absorb load |
| Nodes | 1 k3s node (SQLite datastore) | Primary + **3–4 burst agent nodes** (`workload=burst`) |
| Ingress | 1 Traefik, 1 node, 1 IP | Bump Traefik replicas/resources; lean on Cloudflare edge |

**Provision ahead, tear down after.** This is a scheduled, ~1-hour spike with static content — pre-scale manually; do **not** rely on reactive HPA (justification in [§2](#2-streamer-wss-capacity-math) and [§7](#7-gitops-change-list)).

---

## 1. Architecture as it stands (grounded)

```
                  ┌──────────── Cloudflare ────────────┐
   files.911…  ──►│  (media: already proxied + cached)  │──► file-proxy(nginx-s3-gateway) ──► Wasabi
                  └─────────────────────────────────────┘
   beta.911…    ──►  Traefik ──► rt911-frontend (nginx, static SPA)     [NOT CDN-fronted today]
   stream-beta… ──►  Traefik ──► rt911-streamer (WSS, per-client clock)  [NOT CDN-fronted today]
   api-beta…    ──►  Traefik ──► rt911-api (Directus)

   rt911-streamer ──(read-only)──► rt911-db (Postgres 16)   ◄── Directus (read-write), video-grabber (writes)
   rt911-streamer ──(hot path)───► rt911-cache (Redis 7)    ◄── warmed ~460K rows at boot
```

Verified facts that drive every decision below:

1. **The streamer accepts connections unconditionally.** `internal/handler/ws.go:72` upgrades every request; there is **no load-shedding / max-connection gate** anywhere. A pod will keep accepting sockets until the kernel/OOM stops it.
2. **Per connection = 3 goroutines** (`writePump`, `RunTimePump`, `readPump` — `ws.go:82/108/119`) + one shared `Hub` goroutine per pod (`internal/session/hub.go:37`). `send` channel is buffered at 256 (`session.go:22`). Pings every 30s, read deadline 120s (`ws.go:83/113`).
3. **TLS terminates at Traefik**, so the streamer speaks plain HTTP internally — no per-connection TLS buffers on the Go side (TLS cost sits at Traefik/Cloudflare).
4. **The tick is windowed, not per-second.** `session.go:46-52`: `leadSeconds=30s`, `windowMedia/Mp3=300s`, `windowPager/News/Usenet=600s`. Each channel issues **one** Redis range query per window, and clients buffer + reveal-gate locally. Steady-state Redis load at 30K sessions is therefore ~hundreds of ops/sec, not tens of thousands. **This is the scaling lever.**
5. **The streamer is read-only against Postgres** (SPEC.md:193 — "The service is read-only and trusts every connection"). The only PG traffic on the live path is (a) the usenet channel's windowed per-group reads and (b) `init`/`seek` overlap queries (`CurrentItems`); the only PG *write*-adjacent path is the `NOTIFY`/`LISTEN` cache-sync listener, which reacts to Directus edits. → **read replicas are viable.**
6. **The streamer is horizontally scalable.** State is per-pod (`Hub` + per-session goroutines); all pods share the same Redis + Postgres. Nothing pins a client to a pod, so N pods behind one ingress Just Work.
7. **Single node, SQLite k3s datastore.** No HA control-plane without an etcd migration. Local-path PVCs (Redis 2Gi, PG 10Gi, uploads 10Gi) are node-local and use `strategy: Recreate` — stateful pods cannot freely reschedule.
8. **Everything is `replicas: 1` with no HPA, no affinity/tolerations.** (grep-confirmed across `apps/rt911/*`.)

---

## 2. Streamer (WSS) capacity math

### 2.1 Memory per connection (not the binding constraint)

Per idle connection on the Go side:

| Component | Cost |
|---|---|
| gorilla read+write buffers (`ws.go:20-21`, 1024 + 4096) | ~5 KB |
| 3 goroutine stacks (Go min 8 KB, grows) | ~24 KB |
| `Session` struct + 3 maps + `send` chan (256 × 8B ptr) | ~10–30 KB |
| **Conservative total** | **~60 KB/conn** |

At the current `2Gi` limit: `(2048 MB − ~150 MB base) / 60 KB ≈ 32,000` connections. **Memory is not the ceiling** at 2Gi — CPU is.

### 2.2 CPU per connection (the binding constraint)

- 30K connections on one pod = **90K goroutines + 1 hub goroutine**. The hub does an O(N) non-blocking channel send over every session **every second** (`hub.go:44-52`); each session's `RunTimePump` also wakes every second. Most ticks are no-ops (windowed), but the Go scheduler + GC cost of ~90K goroutines on a small CPU allocation is real and constant.
- **The dangerous event is a synchronized seek.** When thousands of clients seek to the canonical 08:46 ET moment at once, each seek fires `CurrentItems` (Postgres) + subscribed-channel snapshots + resets all channel horizons → the next tick refills every window → a burst of Redis range reads **and msgpack encoding** compressed into a few seconds. This burst, not steady state, sets the per-pod ceiling.

### 2.3 Planning figure (ESTIMATE — gate on load test)

**Assume ~3,000 sustained connections per pod** at `limits: cpu 2 / memory 2Gi`, `requests: cpu 500m / memory 512Mi`.

Rationale: caps per-pod goroutines at ~9K, leaves CPU headroom to absorb the seek-burst encode without starving the writePumps (a starved writePump trips the non-blocking `send_` drop path and clients miss frames). This is deliberately conservative because there is no load-shedding — a pod pushed past its ceiling degrades *all* its clients, so we size for the burst, not the average.

**Required replicas:** `30,000 / 3,000 = 10` → **provision 12 pods** (≈20 % headroom + rolling-update capacity).

> ⚠️ 3,000/pod is an unvalidated estimate. **[§9](#9-manual-load-test-approach) must confirm the real ceiling of a single pod before the event.** If the load test shows 5,000/pod, drop to ~8 pods; if 1,500/pod, raise to ~24 pods and revisit node sizing in [§6](#6-nodecluster-capacity).

### 2.4 Boot-warm thundering herd (rollout hazard)

Every streamer pod runs `cache.WarmCache` at boot (`cmd/server/main.go:37`), reading **~460K rows** from Postgres into the shared Redis (startupProbe budget = `failureThreshold 60 × periodSeconds 5s = 300s`). Twelve pods booting simultaneously = **12 × 460K-row reads against Postgres at once**, right when PG is also under event load.

**Mitigation:** stagger the rollout. In `streamer.yaml` set a conservative `strategy.rollingUpdate.maxSurge: 1` / `maxUnavailable: 0` and scale up **before** the traffic arrives (see timeline [§8](#8-timeline--checklist)), so warms serialize and complete against an idle DB. The Redis writes are idempotent (`HSET`/`ZADD` of identical data), so concurrent warms are correct — just expensive; serializing them removes the PG spike.

---

## 3. Frontend + WSS through Cloudflare

### 3.1 Static SPA (`beta.911realtime.org`)

The SPA is hashed, immutable assets served by an in-cluster nginx pod (`frontend.yaml`, `250m/128Mi`). Putting it behind Cloudflare makes the origin near-idle.

- **DNS:** in the Cloudflare zone for `911realtime.org`, set the `beta` record to **Proxied (orange cloud)**.
- **Cache:** add a cache rule "Cache Everything" for `beta.911realtime.org/*` (hashed asset filenames make this safe; `index.html` should use a short edge TTL or "bypass" so deploys are picked up — the existing `cloudflare-purge` PostSync hook already purges on deploy).
- Keep 2 origin pods for resilience, but origin traffic will be negligible.

> **Verify first:** a `cloudflare-purge` PostSync hook exists in `apps/rt911/purge-hook.yaml` and a CF API token/zone is already wired. That implies at least one rt911 host may already be proxied. **Before the event, confirm the actual proxy status of `beta`, `api-beta`, and `stream-beta` in the Cloudflare dashboard** — don't assume.

### 3.2 WSS streamer (`stream-beta.911realtime.org`)

Cloudflare proxies WebSockets (orange cloud; "WebSockets" is on by default under **Network**). Set the `stream-beta` DNS record to **Proxied**.

**What Cloudflare gives you here — and what it does *not*:**

- ✅ **TLS termination at the edge**, DDoS/L7 protection, hides the origin IP, absorbs TLS-handshake and connection-setup bursts (valuable when 30K clients connect within minutes).
- ❌ **It does NOT reduce the number of WebSockets your origin holds.** Every proxied WS still funnels to the single origin IP/Traefik and one of the 12 streamer pods. Cloudflare is not a connection-sharding layer. You still need the pod count from [§2](#2-streamer-wss-capacity-math) and the ingress work in [§6.3](#63-traefikingress). Long-lived WS also count against Cloudflare plan concurrency limits — **confirm the plan's WebSocket limits with Cloudflare before relying on this at 30K.**

Confirm the streamer CORS middleware (`streamer-cors`, allows `https://beta.911realtime.org`) still matches the proxied origin.

---

## 4. Postgres

Shared by **Directus (read-write)**, the **streamer (read-only)**, and **video-grabber (writes)** — one primary at `1 CPU / 1Gi`, 10Gi local-path today.

### 4.1 Connection math and pooling (the real risk)

The streamer uses pgx with **no `MaxConns` tuning** (`db.Connect`, no env override) → pgx default `MaxConns = max(4, NumCPU)`. Plus each pod runs `NOTIFY` listeners (`cache.Listen` + pager/mp3/news listeners = up to 4 dedicated conns) on `cmd/server/main.go:50-78`.

Per pod ≈ pool (`~4–8`) + listeners (`~4`) ≈ **~12 backends**. **12 pods ≈ 144 Postgres backends**, before Directus/video-grabber. Postgres `max_connections` defaults to **100** → **connection exhaustion**.

**Plan:**

- **Add pgbouncer** (transaction pooling) in front of Postgres. Point every streamer `pgxpool` at pgbouncer.
- **Size pgxpool explicitly** via a new `DATABASE_MAX_CONNS` env (small, since queries are short and windowed): **`pool_max_conns=10` per pod** → pgbouncer multiplexes 12×10 client conns down to a modest real-backend count.
- **pgbouncer** `pool_mode=transaction`, `default_pool_size≈25`, `max_client_conn≈500`. Transaction mode is safe for the streamer's short read queries. **Caveat:** `LISTEN/NOTIFY` needs a session-pinned connection — keep the cache-sync listeners on a **direct** connection to the primary (bypass pgbouncer, or a dedicated `session`-mode pgbouncer pool).

### 4.2 Read replica for the read-only streamer

The streamer never writes (SPEC.md:193), so:

- **Add one async streaming read replica.** Point the streamer's **query pool** (`CurrentItems`, usenet reads, `WarmCache`) at the **replica**; keep **Directus and video-grabber on the primary**.
- **`LISTEN/NOTIFY` is not replicated in Postgres streaming replication.** The cache-sync listener must stay on the **primary**. This is fine because **content is frozen during the event** (no Directus edits → the listener is idle anyway). If you want zero code change, point the whole streamer at the primary and just scale the primary vertically + pgbouncer; the replica is the cleaner option if a small config/env split for the read pool is acceptable.
- **Resources:** primary → `requests cpu 1 / mem 2Gi`, `limits cpu 4 / mem 8Gi`; tune `shared_buffers` (~25 % of mem), `effective_cache_size`, `work_mem`. Replica similar or slightly smaller.

### 4.3 Shared-DB constraint

**Pause video-grabber ingest for the event window** — it writes to the same primary and its bulk work would contend with live reads. Directus stays up (small load) but content editing should be frozen.

---

## 5. Redis

Entire hot path SPOF today (`500m / 1Gi`, 2Gi local-path, `--appendonly yes`).

### 5.1 Load profile (why throughput is not the worry)

Because delivery is **windowed** (`session.go:46-52`), steady-state Redis reads at 30K sessions are roughly:

- media/mp3 refill every 300s → `30K/300 ≈ 100/s` each
- pager/news refill every 600s → `30K/600 ≈ 50/s` each

≈ **a few hundred Redis ops/sec steady state** — trivial for single-threaded Redis. The spike is the **synchronized-seek burst**: all horizons reset to `t`, so the next ticks refill every window for thousands of sessions within seconds → up to tens of thousands of `ZRANGEBYSCORE` in a short window. Redis handles ~100K+ simple ops/sec single-threaded, but ranged reads are heavier — this burst is the thing to size for and to watch in the load test.

### 5.2 Plan

- **Raise limits to `cpu 2 / memory 2Gi`** (requests `cpu 500m / mem 512Mi`). Redis command execution is single-threaded, so >1 CPU mainly covers I/O threads + headroom; the win is memory headroom + not being CPU-throttled during the seek burst.
- **Pin to the primary node.** The local-path PVC already forces this; add explicit `nodeAffinity` to the primary (also a prerequisite before joining burst nodes — [§6.1](#61-node-plan)).
- **HA replica: recommended but not urgent — justified by the windowed profile.** Because clients buffer up to a **300s window** and refill **30s early**, an in-flight Redis outage of up to ~4.5 minutes does **not** starve already-connected clients — they keep playing from their local buffer. Only *new* window refills and *new* connections fail during an outage. So a Redis blip is survivable, and fast recovery matters more than instant failover. Recommendation: add **one Redis replica** (async) for fast failover if operationally cheap; if not, a single beefier Redis with a fast restart path is acceptable given (a) the descaled load and (b) client-side buffering. Note: on restart, `WarmCache` is driven by the streamer pods, so a cold Redis is re-warmed on the next streamer (re)connect/boot — but that takes minutes, hence the preference for a replica over a cold restart mid-event.

---

## 6. Node/cluster capacity

### 6.1 Node plan

Rough event-day resource footprint (limits):

| Workload | Pods × limit | Cores | Mem |
|---|---|---|---|
| Streamer | 12 × (2 CPU / 2Gi) | 24 | 24Gi |
| Postgres primary + replica | 4 + 2 CPU | 6 | 12Gi |
| pgbouncer | 1 | ~0.5 | 0.5Gi |
| Redis (+replica) | 2 (+2) | 2–4 | 2–4Gi |
| Traefik (scaled) | 2–3 | 2–4 | 2Gi |
| Directus + frontend | small | ~1.5 | 2Gi |
| **Total** | | **~40 cores** | **~45Gi** |

The single home node (`dev.keepinghistory.org` / `66.165.230.66`) cannot hold this. **Add 3–4 burst agent nodes** (e.g. 4 × 8 vCPU / 16 GB, or 2 × 16 vCPU / 32 GB cloud VMs).

**Per `infra` `docs/scaling-and-nodes.md` (Option A, manual burst):**

1. **Prerequisite (do this first):** stateful pods use node-local `local-path` PVCs and are **not** pinned yet. **Add `nodeAffinity` to the primary node** on `postgres.yaml`, `redis.yaml`, `directus.yaml` (label the home node e.g. `node-role=primary`) **before joining any second node**, or they may schedule onto a burst node and lose their data.
2. **Tailscale mesh:** install on all nodes; add to k3s agent args `--vpn-auth="name=tailscale,joinKey=<key>"` so nodes talk over the tailnet regardless of location.
3. **Label + taint burst nodes:** `workload=burst` label + `workload=burst:NoSchedule` taint (applied at join / via node manifest, **not** ad-hoc if it must survive — but node taints are cluster state, not in the ArgoCD app; apply via your node-provisioning process).
4. **Opt burst-eligible Deployments onto burst nodes** with a matching `nodeSelector: {workload: burst}` + toleration. **Streamer** (stateless) and extra **Traefik** replicas are burst-eligible; stateful services stay pinned to primary.
5. Join: `curl -sfL https://get.k3s.io | K3S_URL=https://66.165.230.66:6443 K3S_TOKEN=<node-token> sh -s - agent`. Firewall: 6443/tcp, 8472/udp (flannel), 10250/tcp.

### 6.2 SQLite / single-server constraint (accept, don't fix)

The k3s **control-plane datastore is SQLite** → **no HA control-plane**. If the primary (server) node dies, the API server / scheduler is down and you cannot make changes (running pods on burst nodes keep serving, but nothing reschedules). Migrating to embedded etcd for HA is **out of scope** for this event — instead: **keep the primary node healthy, do all provisioning ahead of time, and freeze changes during the event.** (Note: this SQLite is the *k3s datastore*, unrelated to application data in Postgres — see [§10](#10-explicitly-out-of-scope-db-engine-changes).)

### 6.3 Traefik/ingress

All three hosts route through a **single Traefik on one node behind one public IP** — the ultimate funnel and SPOF. Every one of the 30K WebSockets terminates here.

- **Bump the k3s Traefik deployment's replicas (2–3) and resources**, with anti-affinity so replicas spread across burst nodes. **Caveat:** k3s ships Traefik via a managed HelmChart (in `kube-system`), configured through a `HelmChartConfig` — this lives **outside** `apps/rt911/` and may need editing in the infra repo's k3s/base config, not the rt911 kustomization.
- **The single public IP is a hard limit** on a single-node control plane. True ingress HA needs a second server node + external load balancer. For this event, **mitigate with Cloudflare in front** (absorbs connection-setup bursts, hides origin, DDoS protection) + vertical Traefik scaling, and accept the single-IP funnel as a known risk to watch during the load test. If it becomes the bottleneck, consider Cloudflare Spectrum or a cloud LB in front of multiple ingress nodes (larger change — decide based on load-test results).

---

## 7. GitOps change list

All edits land in `github.com/Keeping-History/infra` via PR to `main`; ArgoCD syncs. **No `kubectl scale`/`set image`** (selfHeal + prune revert it).

| File | Change |
|---|---|
| `apps/rt911/streamer.yaml` | `replicas: 1 → 12`; resources `requests cpu 500m/mem 512Mi`, `limits cpu 2/mem 2Gi`; add `nodeSelector {workload: burst}` + toleration; add `strategy.rollingUpdate {maxSurge: 1, maxUnavailable: 0}` (stagger warm — [§2.4](#24-boot-warm-thundering-herd-rollout-hazard)); add env `DATABASE_MAX_CONNS=10`; point `DATABASE_URL` at pgbouncer (query path) — keep listener path on primary |
| `apps/rt911/postgres.yaml` | resources `limits cpu 4/mem 8Gi`; add `nodeAffinity` to primary node; Postgres tuning via `rt911-config` (`shared_buffers`, `work_mem`, `max_connections`) |
| **new** `apps/rt911/postgres-replica.yaml` | async streaming read replica (Deployment/StatefulSet + PVC + Service `rt911-db-ro`) |
| **new** `apps/rt911/pgbouncer.yaml` | pgbouncer Deployment + Service (`transaction` mode, `default_pool_size≈25`, `max_client_conn≈500`) |
| `apps/rt911/redis.yaml` | resources `limits cpu 2/mem 2Gi`; add `nodeAffinity` to primary |
| **new (optional)** `apps/rt911/redis-replica.yaml` | async Redis replica for failover ([§5.2](#52-plan)) |
| `apps/rt911/directus.yaml` | add `nodeAffinity` to primary; optionally `replicas: 2` |
| `apps/rt911/frontend.yaml` | `replicas: 2` (Cloudflare carries the load); no CDN config here |
| `apps/rt911/kustomization.yaml` | add the new resource files above |
| k3s Traefik `HelmChartConfig` (**outside** `apps/rt911/`, in k3s base config) | bump replicas 2–3 + resources + anti-affinity ([§6.3](#63-traefikingress)) |
| **Cloudflare** (dashboard/API/Terraform, **not** k8s) | set `beta`, `stream-beta` to **Proxied**; SPA cache rule; verify WebSockets enabled + plan limits ([§3](#3-frontend--wss-through-cloudflare)) |

**On HPA — deliberately NOT used:** (a) new pods each run a ~460K-row warm gated by a 300s startupProbe, so scale-up is minutes-slow — far too slow for a 1-hour spike; (b) CPU/mem metrics don't track *WebSocket connection count*, the real load signal, so an HPA would scale on the wrong dimension. For a **scheduled, short, known** spike, **manual pre-scale** (`replicas: 12`, set the day before) is correct. Revisit HPA only if this becomes a recurring, unpredictable pattern.

---

## 8. Timeline / checklist

### T-minus (provision & verify)

- **T-14 days** — Load test a **single** streamer pod to failure ([§9](#9-manual-load-test-approach)); lock in the real per-pod ceiling and recompute replica count. Provision the 3–4 burst node VMs.
- **T-7 days** — Land the **prerequisite `nodeAffinity`** PRs (pin stateful pods to primary). Join burst nodes via Tailscale + `workload=burst` taint. Verify pods still schedule correctly.
- **T-5 days** — Land pgbouncer + read-replica PRs; verify streamer connects through pgbouncer and reads from the replica; verify `LISTEN/NOTIFY` still works on primary. Land Redis resource bump (+ replica).
- **T-3 days** — Put `beta` + `stream-beta` behind Cloudflare (Proxied); verify SPA loads and a WSS session connects/streams end-to-end through CF. Confirm CF plan WebSocket limits.
- **T-2 days** — Full-scale rehearsal load test through the real edge (Cloudflare → Traefik → 12 pods) ramped to 30K with a synchronized seek. Fix whatever it surfaces.
- **T-1 day** — Scale streamer `replicas: 12` (staggered warm completes against idle DB). **Freeze content** in Directus; **pause video-grabber ingest.** Confirm all pods `Ready` and Redis warm.

### T-0 (event hour)

- Watch: streamer CPU/mem per pod, `send_`-drop log lines (dropped frames = pod over ceiling), Redis CPU during the seek burst, Postgres/pgbouncer connection counts + replica lag, Traefik CPU + connection count, Cloudflare edge metrics.
- Do **not** make cluster changes mid-event (SQLite single control-plane — [§6.2](#62-sqlite--single-server-constraint-accept-dont-fix)). Everything must already be provisioned.

### Post-event teardown (return to cheap baseline)

- Revert `streamer.yaml` `replicas: 12 → 1` (and resources if raised beyond baseline).
- Cordon/drain and remove burst nodes; tear down the cloud VMs.
- Decide whether to keep the read replica + pgbouncer (cheap, arguably worth keeping) or revert to single Postgres.
- Optionally revert Redis/Traefik resource bumps.
- Leave Cloudflare proxying in place — it's strictly beneficial and free-tier-friendly.
- Unfreeze content; resume video-grabber.
- **Keep the `nodeAffinity` pins** even at baseline — they're correct regardless of node count.

---

## 9. [MANUAL] Load-test approach

**Goal:** find the real single-pod WebSocket ceiling and validate 30K end-to-end with a synchronized seek, *before* the event.

**Tool:** a **custom Go load harness** is preferred over k6/Artillery because (a) 30K long-lived WebSockets are cheap in Go (goroutine-per-conn, same as the server), and (b) it can speak the exact wire protocol — text JSON client→server, binary MessagePack server→client (`docs/websocket-protocol.md`). k6 with `xk6-websockets` is a viable alternative if you want built-in metrics, but will need distribution across several load boxes and can't as easily assert on the msgpack frames.

**Scenario:**

1. **Single-pod ceiling first.** Point the harness at one pod (bypass the LB). Ramp connections (each: `init` at `2001-09-11T12:40:00Z` → `subscribe` to all channels → `heartbeat` loop) until you see frame latency climb, `send_`-drop log lines appear, or CPU saturates. That number is the real per-pod ceiling → recompute replica count.
2. **Synchronized-seek burst.** With N connections held, fire a `seek` to the canonical **08:46 ET** moment (`2001-09-11T12:46:00Z`) across **all** connections within ~1s. Measure the resulting Redis `ZRANGEBYSCORE` burst, streamer CPU, and per-client time-to-first-frame. This is the worst case ([§2.2](#22-cpu-per-connection-the-binding-constraint)).
3. **Full scale.** Ramp to **30,000** concurrent WebSockets through the real path (Cloudflare → Traefik → 12 pods). Distribute the harness across multiple source hosts/IPs — one box hits ephemeral-port (~28K) and file-descriptor limits (`ulimit -n`) well before 30K. Hold for the expected event duration, then do the synchronized seek at scale.

**Pass criteria:** p99 time-to-first-frame after seek within an acceptable UX bound (define with product, e.g. < 3s); zero (or negligible) `send_` drops; Redis/Postgres/Traefik CPU with headroom; no OOMs; replica lag bounded.

---

## 10. Explicitly out of scope: DB-engine changes

**Swapping the storage engine (SQLite → etcd, Postgres → ClickHouse/TSDB, etc.) is out of scope, and here is why:**

- **The data is static, read-only historical media metadata.** It's already warmed into Redis and served via **windowed** reads that descale the per-tick load ([§1.4](#1-architecture-as-it-stands-grounded), `session.go:46-52`). Query latency and storage-engine throughput are **not** the bottleneck.
- **The bottleneck is connection fan-out and per-connection compute** — how many WebSockets one pod holds, how many pods one node fits, and how the edge absorbs the connection burst. A different database changes **none** of that.
- **The two "SQLite/DB" temptations are unrelated to app data:** the SQLite in play is the **k3s control-plane datastore** (addressed as an HA constraint in [§6.2](#62-sqlite--single-server-constraint-accept-dont-fix), not an app-data store); application data is Postgres and is handled by **replication + pooling** ([§4](#4-postgres)), not an engine swap.

This is a **horizontal-scale + CDN/edge** problem. Solve it with more pods, more nodes, connection pooling, a read replica, and Cloudflare — not with a new storage engine.

---

## Appendix — source references

| Claim | Source |
|---|---|
| No load-shedding; unconditional upgrade | `packages/backend/internal/handler/ws.go:72` |
| 3 goroutines/conn + shared hub | `ws.go:82/108/119`, `internal/session/hub.go:37` |
| `send` buffer 256; ping 30s; read deadline 120s | `session.go:22`, `ws.go:83/113` |
| Windowed tick (lead 30s; windows 300/600s) | `internal/session/session.go:46-52` |
| Streamer read-only | `packages/backend/SPEC.md:193` |
| `WarmCache` ~460K rows at boot; `/ready` pings PG+Redis | `cmd/server/main.go:37,99-111` |
| pgx `NOTIFY` listeners on live path | `cmd/server/main.go:50,60,69,78` |
| Current manifests (replicas 1, resources, hosts, PVCs, ArgoCD selfHeal, no HPA/affinity) | `infra` repo `apps/rt911/*.yaml`, `argocd/applications/rt911*.yaml` |
| Burst-node procedure (Tailscale, `workload=burst`, autoscaler) | `infra` repo `docs/scaling-and-nodes.md` |
| Media already Cloudflare→file-proxy→Wasabi | root `CLAUDE.md`, `apps/rt911/purge-hook.yaml` |
