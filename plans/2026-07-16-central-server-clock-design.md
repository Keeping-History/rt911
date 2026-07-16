# Central Server Clock ("Forced Clock Mode") — Design

**Date:** 2026-07-16
**Status:** Approved

## Summary

An operator-activated mode where the streamer forces every connected client onto one
authoritative server clock. Controlled via a key-guarded REST API on the streamer.
While active, clients cannot change the date/time (Time Machine disabled, Date & Time
control panel's date/time editors locked) but may still change their **timezone**,
which is display-only and never affects the data stream.

## Decisions made

| Question | Decision |
|---|---|
| Master-clock storage | **Redis-backed** (`clock:master` key + pub/sub), applied in-process at the Hub; survives pod restarts, scales to future replicas. |
| Sync model | **Continuous via heartbeat**: `heartbeat_ack` carries `master_time` while active; client corrects when drift > ~2 s. |
| API surface | **Set/jump, release, status** only (`POST /clock`, `GET /clock`). No pause/rate control (YAGNI; can be added later). |
| Release behavior | Clients **continue from master time**; controls re-enable. No jump-back. |
| Auth | `X-Clock-Key` header, constant-time compare vs `CLOCK_CONTROL_KEY` env (k8s Secret). Key unset ⇒ endpoints return 404 (feature off). Public ingress on the streamer's existing host. |
| Client UI enforcement | Time Machine app force-closed + launch-blocked; mobile Time Travel screens hidden; Date & Time Manager date/time editors disabled, **timezone stays editable**; playlist clock-jumps suppressed. |

## Server (`packages/backend`)

### `internal/clock` — MasterClock

New package owning forced-mode state:

```go
type State struct {
    Active    bool      `json:"active"`
    VirtualAt time.Time `json:"virtual_at"` // master virtual time at anchor
    WallAt    time.Time `json:"wall_at"`    // wall-clock anchor (UTC)
}
```

- Current master time = `VirtualAt + (time.Now() - WallAt)` — two-anchor math, no
  ticker, drift-free, trivially JSON-serialized into the Redis key **`clock:master`**.
- `MasterClock` holds an in-process copy behind a mutex with `Snapshot()`,
  `Now() (time.Time, bool)` (false when inactive), `Set(t time.Time)`, `Release()`.
- `Set`/`Release` write Redis, apply locally, and `PUBLISH clock:master:changed`.
- A subscriber goroutine (same shape as `cache.Listen`) re-reads `clock:master` on
  every message and on (re)connect; boot reads the key so a restart mid-session stays
  forced. Redis-down behavior matches the rest of the service: both stores are hard
  dependencies.
- On every state change, the Hub broadcasts a `clock` message to all sessions.

### REST API (existing mux in `cmd/server/main.go`)

- `POST /clock` — body `{"active": true, "time": "2001-09-11T12:46:00Z"}` to enable
  or jump; `{"active": false}` to release. Responds `{active, time?}`.
- `GET /clock` — current state `{active, time?}`.
- Both require `X-Clock-Key` equal (constant-time compare, `crypto/subtle`) to
  `CLOCK_CONTROL_KEY`. Missing/wrong key ⇒ 403. `CLOCK_CONTROL_KEY` unset ⇒ 404 for
  both verbs (feature disabled). Bad time / bad JSON ⇒ 400 with a message. Time
  parsing reuses the handler package's `parseTime` fallbacks.

### Session behavior while active

- **Push on connect and on change:** server sends msgpack `{type:"clock", active: bool,
  time: <RFC3339>}` after `init_ack`, and to every session on activate/jump/release.
- **Heartbeat enrichment:** `heartbeat_ack` gains an optional `master_time` field
  (present only while active).
- **Clamping:** while active, the server substitutes master time for any
  client-supplied time on `init`, `seek`, and `heartbeat` — a divergent or malicious
  client cannot stream data from a different moment. `seek_ack`/`heartbeat_ack` echo
  the clamped (master) time. Sessions consult the Hub's `MasterClock`; no new
  per-session state.

## Frontend (`packages/frontend`)

All changes flow through the two sanctioned seams: `MediaStreamProvider` (single WS
consumer) and `setDateTimeFromUtc` (single clock-writer path).

- **`clock` message:** provider calls `setDateTimeFromUtc(time)` and exposes
  `clockForced: boolean` via context. A forced jump > 90 s naturally trips the
  existing seek/buffer-clear machinery — no new resync code.
- **Drift correction:** on `heartbeat_ack.master_time`, correct via
  `setDateTimeFromUtc` only when `|local − master| > 2_000 ms`. Corrections ≤ 90 s
  don't clear buffers (by existing design).
- **Enforcement while `clockForced`:**
  - Time Machine desktop app force-closed and blocked from launching (reuse the
    `disabledApps` enforcement pattern from `PlaylistProvider`).
  - Mobile Time Travel screens hidden from the iPod menu.
  - Playlist clock-jump entries are suppressed (central mode outranks playlists;
    other playlist features keep working — the server clamp makes this true even if
    a stale client misbehaves).
  - Classicy `dateTimeLocked` flag set (below).
- **Release:** provider clears `clockForced`; clients keep ticking from master time.

## Classicy (external, `~/classicy`)

New system-state flag `dateTimeLocked` (seeded/settable like other system Manager
state). The Date & Time Manager control panel disables the **date and time editors**
when set, while the **timezone picker stays enabled**. Timezone is already
display-only in rt911 (`virtualUtcMs` strips the offset before anything reaches the
wire), so a tz change never affects the stream. Ships as a normal classicy release
(push to main → auto-publish → rt911 picks up `latest`).

## Docs & contract

- `packages/backend/docs/websocket-protocol.md`: document `clock`,
  `heartbeat_ack.master_time`, and forced-mode clamping semantics.
- Both wire sides land in the same PR (repo rule; no version negotiation).
- `packages/backend/SPEC.md` gains the REST endpoints.

## Infra (separate repo, follow-up)

- `CLOCK_CONTROL_KEY` in a k8s Secret + env on the streamer Deployment
  (`apps/rt911/streamer.yaml`).
- `/clock` rides the streamer's existing public host/route. Until the infra change
  lands, the key is unset and the endpoints 404.

## Error handling

- REST: 403 wrong key, 404 feature off, 400 bad payload/time, 405 other verbs.
- Redis publish failure on `Set`/`Release`: the local pod still applies and
  broadcasts; error logged (single-replica today, so operator impact is nil).
- Client reconnect while forced: `clock` push on connect re-locks it immediately.

## Testing

- **Go:** `internal/clock` — anchor math, Redis round-trip + pub/sub (miniredis),
  boot re-read; handler — auth (constant-time path), status codes, activate/jump/
  release flows; session — clamping of init/seek/heartbeat, `heartbeat_ack`
  enrichment, `clock` push on connect and on change.
- **Frontend:** provider — `clock` handling sets clock + `clockForced`, drift
  threshold (1.9 s no-op, 2.1 s corrects), release clears flag; enforcement — Time
  Machine blocked while forced, re-enabled after; playlist-jump suppression.
- **Classicy:** Date & Time Manager renders date/time editors disabled and tz
  enabled under `dateTimeLocked`.
- **E2E/manual:** `POST /clock` against the dev streamer; desktop clock jumps; Time
  Machine won't open; `{"active": false}` re-enables it.

## Out of scope

- Pause/resume and playback-rate control.
- Per-session (subset) forcing — the mode is global.
- Operator UI — control is via curl/REST only.
