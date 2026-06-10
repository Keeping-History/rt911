# rt911 streamer

A Go WebSocket service that streams scheduled broadcast media items to clients in **virtual time**. Every connected client gets its own clock; the server advances each clock at one tick per real second and pushes the items whose `start_date` falls inside the current second.

The streamer is the realtime spine of [911realtime.org](https://911realtime.org) — it lets the frontend replay TV broadcasts, news entries, pager traffic, usenet posts, and other dated artifacts as if they were happening live on a chosen historical date.

```
┌──────────┐  WebSocket   ┌──────────────┐   ZRANGEBYSCORE   ┌────────┐
│ Browser  │ ───────────▶ │   streamer   │ ────────────────▶ │  Redis │
│ (client) │ ◀─────────── │ (this Go svc)│                   └────┬───┘
└──────────┘    items     └──────┬───────┘  warm on boot          │
                                  │ pgx                            │
                                  ▼                                │
                          ┌──────────────┐                         │
                          │  PostgreSQL  │◀────────────────────────┘
                          │  (Directus)  │   AllItems / CurrentItems
                          └──────────────┘
```

---

## Quick start

```sh
# from packages/backend/
cp .env.example .env       # in the repo root; the streamer reads DATABASE_URL / REDIS_URL
docker compose up -d       # brings up postgres, redis, directus, and the streamer
```

The streamer listens on `:8080` by default. Connect with any WebSocket client:

```js
const ws = new WebSocket("ws://localhost:8080/stream");
ws.onopen = () => ws.send(JSON.stringify({
  type: "init",
  time: "2001-09-11T08:46:00Z",   // virtual start time
}));
ws.onmessage = (e) => console.log(JSON.parse(e.data));
```

You will receive an `init_ack` with the items active at that timestamp, then one `items` frame per real second containing newly-scheduled entries.

To run outside Docker:

```sh
go run ./cmd/server
# DATABASE_URL=postgres://… REDIS_URL=redis://… LISTEN_ADDR=:8080
```

---

## Endpoints

| Path      | Protocol  | Purpose                                                                              |
| --------- | --------- | ------------------------------------------------------------------------------------ |
| `/stream` | WebSocket | Bidirectional client session                                                         |
| `/health` | HTTP      | Liveness — `200 OK` while the HTTP server is up                                      |
| `/ready`  | HTTP      | Readiness — pings Postgres and Redis; `200` if both reachable, `503` otherwise       |

Wire protocol details live in [`docs/websocket-protocol.md`](./docs/websocket-protocol.md).

---

## Repository layout

```
packages/backend/
├── cmd/server/main.go        # entrypoint: wires db + cache + hub + http mux
├── internal/
│   ├── cache/                # Redis warm + per-second lookup
│   ├── db/                   # pgx pool + media_items queries
│   ├── handler/              # WebSocket upgrade + message router
│   ├── model/                # MediaItem struct shared by all packages
│   └── session/              # Hub (broadcast tick) + Session (per-client state)
├── docs/                     # detailed documentation (start here)
├── Dockerfile                # multi-stage alpine build
├── docker-compose.yml        # postgres + redis + directus + streamer + timemachine
├── seed.mjs                  # Directus schema + data import
├── import-usenet.mjs         # bulk import of usenet ndjson
├── gen-epg.mjs               # one-shot EPG JSON dump for the frontend
├── go.mod / go.sum
└── .env.example              # see also: repo-root .env.example
```

---

## Documentation

| File                                                       | What's in it                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| [`docs/architecture.md`](./docs/architecture.md)           | System diagram, lifecycles, goroutine layout, design rationale            |
| [`docs/websocket-protocol.md`](./docs/websocket-protocol.md) | Every message type, JSON shape, examples, error semantics                |
| [`docs/data-model.md`](./docs/data-model.md)               | `media_items` / `sources` schema, formats, ordering rules                 |
| [`docs/configuration.md`](./docs/configuration.md)         | Environment variables, defaults, tuning knobs                             |
| [`docs/operations.md`](./docs/operations.md)               | Building, deploying, logs, health checks, troubleshooting                 |
| [`docs/components/cache.md`](./docs/components/cache.md)   | `internal/cache` — Redis layout, warm semantics, lookup queries           |
| [`docs/components/db.md`](./docs/components/db.md)         | `internal/db` — pgx pool, `AllItems`, `CurrentItems`, null handling       |
| [`docs/components/handler.md`](./docs/components/handler.md) | `internal/handler` — WS upgrade, message dispatch, pump goroutines      |
| [`docs/components/model.md`](./docs/components/model.md)   | `internal/model` — `MediaItem` field-by-field reference                   |
| [`docs/components/session.md`](./docs/components/session.md) | `internal/session` — `Hub` + `Session`, ticking, drift, filtering       |
| [`CLAUDE.md`](./CLAUDE.md)                                 | AI-coding-assistant guardrails for this package                           |
| [`SPEC.md`](./SPEC.md)                                     | Functional specification (what the service must do and why)               |

---

## Local development

The streamer talks to a Directus-managed Postgres (`media_items`, `sources`) and a Redis cache.

1. **Bring the stack up.** `docker compose up -d rt911-db rt911-cache rt911-api` from `packages/backend/`.
2. **Seed Directus.** `node seed.mjs` (or `node import-usenet.mjs` for usenet data). The seed scripts need `entries_media.json`, `entries_news.json`, and `pager_entries.json` next to them — fetch via `upload-seed-data.sh`'s GCS bucket.
3. **Run the streamer.** `go run ./cmd/server`. It will warm the Redis cache on first boot (logs `redis cache warm items=…`), then begin accepting `/stream` connections.

The first connection won't see items unless your virtual `time` overlaps the seeded data. `2001-09-11T08:46:00Z` is a reliable test point.

---

## Why this design?

- **Virtual clocks, not stored playlists.** Each client picks any historical instant and the streamer reconstructs the timeline from the database. No precomputed schedules.
- **Hub fan-out at 1 Hz.** A single ticker drives all sessions; sessions advance their own virtual time and look up Redis independently. Adding a client is O(1) — no scheduler bookkeeping.
- **Redis is authoritative for hot reads.** The cache is keyed by `start_date` (Unix seconds) in a `ZSET`, so `ZRANGEBYSCORE start start` returns exactly the items that fire on that second.
- **Postgres is authoritative for state.** Seeking and initialising hit `CurrentItems`, which finds everything that overlaps a moment (including 5-minute lookback for instant items). The cache only answers the per-second hot path.

See [`docs/architecture.md`](./docs/architecture.md) for the long version.
