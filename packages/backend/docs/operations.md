# Operations

How to build, run, deploy, observe, and troubleshoot the streamer.

---

## Building

The build is a stock Go 1.25 build with no codegen.

```sh
# from packages/backend/
go build -o streamer ./cmd/server
```

The Dockerfile uses a multi-stage Alpine build, producing a static binary (`CGO_ENABLED=0`) and a ~15 MiB final image:

```sh
docker build -t rt911-streamer:dev .
```

Build flags worth knowing:

- `-ldflags="-s -w"` strips DWARF and symbol tables. The Dockerfile uses this.
- The binary is fully static — no `glibc`, no shared libraries needed at runtime.

---

## Running

### Local, against a compose stack

```sh
docker compose up -d rt911-db rt911-cache rt911-api    # Postgres, Redis, Directus
node seed.mjs                                          # populate Directus (one-time)
go run ./cmd/server                                    # the streamer
```

The streamer logs three things you care about on startup:

```
{"time":"...","level":"INFO","msg":"redis cache warm","items":3210}
{"time":"...","level":"INFO","msg":"streamer listening","addr":":8080"}
```

If you see neither, look for `database connection failed` or `cache warm failed` — those are exit-1 errors and the process won't have stayed up.

### Production-shaped

Use the Dockerfile. The container runs `./streamer` as PID 1 with the three env variables.

```sh
docker run -d \
  -e DATABASE_URL="postgres://..." \
  -e REDIS_URL="redis://..." \
  -e LISTEN_ADDR=":8080" \
  -p 8080:8080 \
  rt911-streamer:dev
```

The container has a `HEALTHCHECK` that hits `/health` every 15 s.

---

## Observability

### Logs

JSON via `slog` to stdout. Key fields:

- `level` — `INFO`, `WARN`, `ERROR`.
- `msg` — short human-readable label.
- Structured kv pairs (no `printf`-style formatting). Examples:
  - `"session joined" id=… total=…`
  - `"correcting drift" session=… drift=4.2s`
  - `"send buffer full, dropping message" session=… type=items`
  - `"cache lookup failed" session=… error=…`

There's no log level filter. If you need filtering, do it downstream (Loki, Vector, …).

### Metrics

Observability is via structured logs to stdout. To gauge load from logs alone:

- `grep "session joined" | wc -l` minus `grep "session left" | wc -l` gives current connections.
- `grep "send buffer full"` tells you which sessions are falling behind.
- `grep "cache resynced"` shows the listener's reconnects.
- Container CPU is a good proxy for tick fan-out cost.

Aggregate via Loki, Vector, or your log pipeline of choice — the JSON shape makes downstream parsing trivial.

### Health and readiness

Two endpoints:

- `GET /health` — liveness. Returns `200 OK` as long as the HTTP server is accepting connections. Use this for Kubernetes `livenessProbe` and Docker `HEALTHCHECK`.
- `GET /ready` — readiness. Pings Postgres and Redis (each with a 2 s timeout) and returns `200` only if both succeed. Returns `503` with a descriptive body otherwise. Use this for Kubernetes `readinessProbe` and load-balancer health checks.

```sh
curl -i http://localhost:8080/health
HTTP/1.1 200 OK

curl -i http://localhost:8080/ready
HTTP/1.1 200 OK
# or, when Redis is down:
HTTP/1.1 503 Service Unavailable
redis: dial tcp [::1]:6379: connect: connection refused
```

---

## Common procedures

### Pick up new rows added in Directus

**Automatic.** The streamer installs a Postgres trigger on `media_items` at boot. Every INSERT, UPDATE, and DELETE fires `NOTIFY media_items_changed`; the listener goroutine in `cache.Listen` applies the change to Redis within milliseconds. Look for these log lines after editing in Directus:

```
{"level":"INFO","msg":"notify listener attached","channel":"media_items_changed"}
{"level":"INFO","msg":"cache resynced","items":...,"removed":...}
```

If you don't see the listener attaching at boot, check Postgres connectivity and credentials — the listener uses the same `DATABASE_URL` as the pool.

### Force a full cache rebuild

The listener resyncs the entire cache against Postgres every time it reconnects, so the recommended way to force a rebuild is to bounce the streamer:

```sh
docker compose restart rt911-streamer
```

If you suspect Redis itself is corrupt (e.g. a partially-warmed cache from an interrupted boot), flush the keys before restarting so `WarmCache` runs from scratch instead of skipping on `ZCARD > 0`:

```sh
docker compose exec rt911-cache redis-cli DEL media:by_start media:items
docker compose restart rt911-streamer
```

### Inspect cache contents

```sh
docker compose exec rt911-cache redis-cli ZCARD media:by_start
# 3210
docker compose exec rt911-cache redis-cli ZRANGEBYSCORE media:by_start 1000201960 1000201962
# (lists item IDs firing in that 3-second window)
docker compose exec rt911-cache redis-cli HGET media:items 12345
# (raw JSON of the item)
```

The Unix timestamp for "2001-09-11T08:46:00Z" is `1000201560`.

### Watch a session in flight

There's no introspection endpoint, but you can correlate by session ID:

```sh
docker compose logs -f rt911-streamer | jq -c 'select(.session == "abc123…")'
```

The session ID is logged on join (`"session joined" id=…`) and stays on every subsequent log line for that session.

### Reseed Directus

```sh
node seed.mjs
```

The seed script is idempotent — it skips collections, fields, and rows that already exist. To re-seed from scratch:

```sh
docker compose down -v   # drops all volumes — DESTRUCTIVE
docker compose up -d
node seed.mjs
```

---

## Troubleshooting

### Symptom: `/stream` accepts the connection but no `items` ever arrive

1. Did the client send `init`? Ticks before `init` are no-ops.
2. Is `virtualTime` paused? Check for a `pause_ack` in the client's history.
3. Is the format filter excluding everything? Send `{"type":"filter","formats":[]}` to clear it.
4. Does the time range contain any items? Try `2001-09-11T08:46:00Z` — the canonical test point.
5. Is Redis warm? `redis-cli ZCARD media:by_start` should be non-zero.

### Symptom: `init_ack` returns an empty `items[]` for a known-busy time

1. Are the rows `approved = 1`? The cache warm filter excludes 0.
2. Did Directus' `varchar(255)` truncation eat data? Check `seed.mjs` ALTER TABLE block was run.
3. Did `import-usenet.mjs` finish? Bulk imports are checkpointed; check `START_FILE`.

### Symptom: `cache lookup failed` flooding the logs

Redis is unreachable. The streamer continues serving (init/seek still work via Postgres) but per-second delivery is broken. Check `REDIS_URL`, Redis container health, and network.

### Symptom: `database connection failed` on startup

Postgres is unreachable. Verify `DATABASE_URL`, that Postgres is healthy, and that the credentials can `SELECT` from `media_items`.

### Symptom: clients drop after 2 minutes of inactivity

Expected behaviour — the read deadline is 120 s. Clients must respond to pings (browsers do this automatically) or send any inbound message.

### Symptom: clients get correct items for a few seconds, then go silent

Either:
- The session was paused via `pause`. Send `resume`.
- The session crossed the end of seeded data — no more items match for any second.
- The format filter eliminated everything from this point forward.

### Symptom: `send buffer full, dropping message` repeatedly for one session

The client is consuming slower than the server is producing. This is most common when:
- The client is on a slow network.
- The client filter is too permissive (e.g. all formats) on a high-density time window.

The session will continue running but with gaps. The next heartbeat will not snap virtual time — drift only triggers a correction when the *client's* reported time diverges, and dropped messages don't cause that.

---

## Capacity planning

A rough sketch — measure your workload before committing.

| Metric                     | Per session     | At 1K sessions | At 10K sessions |
| -------------------------- | --------------- | -------------- | --------------- |
| Goroutines                 | 3               | 3K             | 30K             |
| WebSocket FDs              | 1               | 1K             | 10K             |
| Redis QPS                  | ~1 / s (tick)   | 1K QPS         | 10K QPS         |
| Send-channel memory        | ~64 KiB         | ~64 MiB        | ~640 MiB        |
| Postgres QPS               | Only on seek/init | bursts        | bursts          |

The streamer's footprint is dominated by Redis QPS and goroutine memory. Both scale linearly with session count. The hub fan-out is O(N) per tick but each step is a cheap channel send, so even 100K sessions is feasible on a single core.

---

## Disaster recovery

The streamer holds no state of its own. To recover from total loss:

1. Bring up a new Postgres from backup (Directus' standard backup story).
2. Bring up a new empty Redis. The streamer warms it on boot.
3. Start the streamer. Clients reconnect with exponential backoff.

There is nothing to migrate, restore, or replay on the streamer side. The same is not true of Directus' uploads volume — see Directus docs.
