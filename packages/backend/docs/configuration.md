# Configuration

Every knob the streamer exposes, in one place. The service reads configuration exclusively from environment variables — there is no config file.

---

## Required (with defaults)

| Variable       | Default                                                       | Read by                       | Notes                                                                       |
| -------------- | ------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| `DATABASE_URL` | `postgres://directus:directus@localhost:5432/directus`        | `db.Connect` (`pgxpool.New`)  | Standard libpq URL. `?sslmode=require` and similar params are passed through. |
| `REDIS_URL`    | `redis://localhost:6379`                                      | `cache.Connect` (`redis.ParseURL`) | Use `rediss://` for TLS. Auth via URL userinfo: `redis://:password@host:port`. |
| `LISTEN_ADDR`  | `:8080`                                                       | `http.ListenAndServe`         | Standard Go address syntax. `:8080` binds all interfaces.                   |

All three have sensible local-dev defaults, so `go run ./cmd/server` works against a default `docker compose up` without any env tweaks.

---

## Compose-derived variables

When you run via `docker-compose.yml`, the streamer's environment is *built* from the surrounding compose stack's variables. Setting `DATABASE_URL` directly is uncommon in that path; instead, you set the DB primitives in `.env`:

| Variable        | Used in compose to build…                                                              |
| --------------- | -------------------------------------------------------------------------------------- |
| `DB_USER`       | `DATABASE_URL=postgres://${DB_USER}:${DB_PASSWORD}@rt911-db:5432/${DB_DATABASE}`       |
| `DB_PASSWORD`   | same                                                                                   |
| `DB_DATABASE`   | same                                                                                   |
| `SECRET`        | Directus' admin secret. Not used by the streamer directly.                             |
| `ADMIN_EMAIL`   | Directus admin login.                                                                  |
| `ADMIN_PASSWORD`| Directus admin login.                                                                  |

See [`.env.example`](../.env.example) for the canonical list.

---

## Internal constants

These are hardcoded today. If you find yourself wanting to tune one in production, that's a signal to promote it to an env variable.

| Constant               | Value         | Where                                      | What it controls                                              |
| ---------------------- | ------------- | ------------------------------------------ | ------------------------------------------------------------- |
| `sendBuf`              | `256`         | `session/session.go`                       | `Session.send` channel capacity. Drops messages beyond this.  |
| `driftThresh`          | `3 * time.Second` | `session/session.go`                   | Heartbeat-driven snap threshold.                              |
| Hub `reg`/`unreg` cap  | `64`          | `session/hub.go`                           | Burst capacity for simultaneous joins/leaves.                 |
| Read deadline          | `120 s`       | `handler/ws.go`                            | WebSocket idle timeout; reset on pong or any message.         |
| Write deadline         | `10 s`        | `handler/ws.go`                            | Per-write WebSocket deadline.                                 |
| Ping period            | `30 s`        | `handler/ws.go`                            | Server → client ping interval.                                |
| `ReadBufferSize`       | `1024`        | `handler/ws.go`                            | `websocket.Upgrader` read buffer.                             |
| `WriteBufferSize`      | `4096`        | `handler/ws.go`                            | `websocket.Upgrader` write buffer.                            |
| `ReadLimit`            | `4096` bytes  | `handler/ws.go`                            | Max client message size.                                      |
| 5-minute lookback      | `INTERVAL '5 minutes'` | `db/postgres.go` `CurrentItems`   | How far back "instant" items remain visible on init/seek.     |
| Tick interval          | `1 * time.Second` | `session/hub.go`                       | Virtual clock rate. Don't change this lightly — clients assume 1 Hz. |
| Postgres connect timeout | `15 s`      | `db/postgres.go` `Connect`                 | Boot-time Ping window.                                        |

---

## Logging

`slog` writes JSON to stdout. There is no level filter; everything emitted is emitted. If you need quieter logs, wrap the binary in a log forwarder that filters.

Structured keys you'll see:

- `error` — error message (always wraps an `error`).
- `session` — session ID (set on every per-session logger).
- `total` — current session count (on join/leave).
- `items` — count of items just delivered.
- `drift` — duration on heartbeat snaps.
- `type` — outbound message type when a send is dropped.

---

## Security posture

The streamer is **read-only and unauthenticated**. It assumes:

1. The reverse proxy (or CDN) terminates TLS.
2. The reverse proxy enforces origin allow-listing if you care — the in-process `CheckOrigin` returns `true` for everything.
3. The Postgres role used by `DATABASE_URL` is read-only or at least cannot create/drop schemas. The streamer only `SELECT`s, but a compromised host with write creds is a bigger problem than a streamer bug.
4. The Redis instance is on a private network. Anyone with Redis access can read every item the streamer caches.

If you want auth, add it at the proxy layer (a JWT-validating ingress, mTLS, etc.). Don't add per-message auth — it would have to run on every tick and would eat the latency budget.

---

## Operational tuning

### High session count

The hub's tick fan-out is non-blocking, so adding sessions is cheap. The bottlenecks at scale are:

- Goroutine count: 3 per session. 10K sessions ≈ 30K goroutines, well within Go's comfort zone.
- Redis QPS: 1 `ZRANGEBYSCORE` per session per second. 10K sessions ≈ 10K QPS, well within a small Redis instance's capacity.
- WebSocket file descriptors: ulimit. Raise the container's `nofile`.

### High items-per-second

`Session.send` is buffered at 256. If your dataset has bursts where >256 items fire in a 256-second window for a single session **and** the client is slow, you'll see drop logs. The fix is to filter — clients receiving only one format (`pager`, say) will never hit that ceiling.

### Memory

Each session holds a `formatFilter` map (small) and channel buffers (~64 KiB per session for `send`). Per-session overhead is dominated by the WebSocket connection itself.

Redis memory scales with item count. 6M usenet items ≈ a few GiB of Redis. Provision accordingly or partition by format.

---

## Example deployments

### Single binary on a VM

```sh
export DATABASE_URL="postgres://rt911:hunter2@db.internal:5432/rt911?sslmode=require"
export REDIS_URL="rediss://:hunter2@cache.internal:6379"
export LISTEN_ADDR=":8080"
./streamer
```

Front with nginx or Caddy for TLS termination and origin checking.

### Kubernetes (sketch)

```yaml
env:
  - name: DATABASE_URL
    valueFrom: { secretKeyRef: { name: rt911-pg, key: url } }
  - name: REDIS_URL
    valueFrom: { secretKeyRef: { name: rt911-redis, key: url } }
  - name: LISTEN_ADDR
    value: ":8080"
livenessProbe:
  httpGet: { path: /health, port: 8080 }
readinessProbe:
  httpGet: { path: /ready, port: 8080 }
```

`/health` always returns 200 and catches only a process that has crashed or is wedged on the listener — use it for `livenessProbe`. `/ready` pings Postgres and Redis (2 s timeout each) and returns 503 with a descriptive body when either is down — use it for `readinessProbe` and load-balancer pool membership.

### Docker Compose (provided)

`docker-compose.yml` wires the streamer alongside Postgres, Redis, and Directus. Use `docker compose up -d` from `packages/backend/` to bring everything up.
