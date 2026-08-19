---
id: 006-69bb
title: Add the mp3 metadata HTTP API
status: complete
priority: P1
type: feature
created: "2026-08-18T17:22:54.673Z"
updated: "2026-08-18T19:43:19.610Z"
dependencies: ["003", "004", "005"]
plan: plans/radio-traffic-redesign.md
plan_step: Step 6
started_at: "2026-08-18T19:37:27.956Z"
completed_at: "2026-08-18T19:43:19.609Z"
---

# Add the mp3 metadata HTTP API

## Problem Statement

The tag vocabulary is served over HTTP so the sidebar can paint from the browser cache without waiting on the socket, and external consumers need a non-WebSocket way to read the corpus metadata.

## Acceptance Criteria

- [x] GET /mp3/tags returns the vocabulary with a generation id
- [x] GET /mp3/meta returns vocabulary plus items
- [x] GET /mp3/meta/{id} returns one item and 404s on an unknown id
- [x] a non-GET returns 405
- [x] a matching If-None-Match returns 304 with an empty body
- [x] responses carry a positive Cache-Control, not no-store
- [x] writeJSON is left unmodified and a writeCachedJSON sibling is added
- [x] the handlers require no auth and read no cookie
- [x] responses are served from the Redis cache, never Postgres
- [x] bytes and ETag are built once per cache generation, not per request
- [x] go test ./internal/handler/... passes

## Files

- packages/backend/internal/handler/mp3meta.go
- packages/backend/internal/handler/mp3meta_test.go
- packages/backend/cmd/server/main.go

## Proof

- [x] [completeness] Completeness (Three routes registered on the existing mux with writeCachedJSON, plus docs/http-api.md which did not exist before. 14 tests. go build, vet, gofmt, test ./... clean, and go test -race clean on handler and cache.)
- [x] [feature-availability] Feature availability (Criteria 1-6 and 11 are behavioural: real requests through a real ServeMux against miniredis with a real AssembleMp3Meta and StoreMp3Meta build. Six mutations each failed the test that owns them - memo disabled, no-store substituted, If-None-Match ignored, 304 ordered before 404, origin gate reintroduced, cookie read added.)
- [x] [robustness] Robustness (An unwarmed cache returns 503 rather than falling back to Postgres - the constructors take no pgxpool at all, so no DB path exists to fall back to. 404 on an unknown id is decided before If-None-Match, so a stale client asking about a withdrawn id is told it is gone rather than handed a 304 confirming what it holds.)
- [x] [resilience] Resilience (A global rate limiter bounds all three routes. Mp3MetaGeneration reads only the etag key, so a revalidating client costs one small round trip instead of pulling 1.5MB from Redis to discover nothing changed.)
- [x] [security] Security (Deliberately unauthenticated public reference data, matching the anonymous mp3 channel. Proven both ways: a request carrying a session cookie and an untrusted Origin gets a byte-identical response, AND a comment-stripped source scan asserts mp3meta.go names none of LookupSessionUser, SessionTokenFrom, Cookie, OriginAllowlist or pgxpool. The behavioural half alone could not prove a lookup did not happen, since a route that ignored the result would also pass.)
- [x] [defense-in-depth] Defense in depth (Two layers. The payload is built from model.ItemMeta, which structurally cannot carry gate_reasons or model, and the handlers cannot read identity because they hold no pool and no allowlist. writeJSON was left byte-identical so username answers cannot become cacheable by accident - asserted by a test pinning that writeJSON still sets no-store while writeCachedJSON sets the opposite.)
- [x] [input-validation] Input validation (The only client input is the path id and the If-None-Match header. An unparseable or unknown id is a 404 decided before any cache read; a non-GET is 405; the ETag comparison is exact-match against a server-built hash.)
- [x] [thread-safety] Thread safety (go test -race clean on internal/handler and internal/cache. Handlers are stateless reads over a shared limiter and Redis client with no mutable package state beyond the memoised build.)
- [~] [configurability] Configurability (Nothing to configure. Route paths, cache-control lifetimes and the rate limit are fixed constants; making them tunable would let the HTTP and WebSocket transports that share one assembler drift apart.)

## QA

Go build/vet/gofmt/test clean plus -race on handler and cache. Six mutations verified the tests. Merged into feat/radio-traffic-redesign, PR #442.

## Work Log

### 2026-08-18T19:37:34.719Z - Implemented internal/handler/mp3meta.go: three read routes (GET /mp3/tags, GET /mp3/meta, GET /mp3/meta/{id}) on the stdlib mux, sharing one mp3MetaRoute shape (method check -> global rate.NewLimiter(10,20) -> snapshot -> conditional GET -> serve). Reuses story 005's cache.Mp3Meta bytes; added cache.Mp3MetaGeneration so the common request costs one small Redis GET instead of dragging ~1.5MB. Response bytes and the item index are rendered once per generation into a process-wide mp3MetaView. writeJSON untouched; writeCachedJSON added as a sibling. No auth, no origin gate, no cookie. Docs at packages/backend/docs/http-api.md. go build/vet/gofmt/test all clean, plus -race on handler+cache.

### 2026-08-18T19:42:39.454Z - Merged into feat/radio-traffic-redesign, PR #442, commit 45b6f4bd. Added cache.Mp3MetaGeneration beyond the brief and justified: LoadMp3Meta drags ~1.5MB out of Redis, so a handler calling it per request would pay the full payload just to learn nothing changed, and /mp3/tags is the every-page-load route. The new function GETs only the etag key. One ETag covers all three routes, which is correct per RFC 7232 since entity tags are only compared against the same URL. 404 on an unknown id is decided before If-None-Match so a stale client asking about a withdrawn id is told it is gone rather than handed a 304. Six mutations verified the tests have teeth: memo disabled, no-store substituted, If-None-Match ignored, 304-before-404, origin gate reintroduced, cookie read added.


### 2026-08-18T19:43:08.164Z - Proof completeness set PROVEN: Three routes registered on the existing mux with writeCachedJSON, plus docs/http-api.md which did not exist before. 14 tests. go build, vet, gofmt, test ./... clean, and go test -race clean on handler and cache.

### 2026-08-18T19:43:08.254Z - Proof feature-availability set PROVEN: Criteria 1-6 and 11 are behavioural: real requests through a real ServeMux against miniredis with a real AssembleMp3Meta and StoreMp3Meta build. Six mutations each failed the test that owns them - memo disabled, no-store substituted, If-None-Match ignored, 304 ordered before 404, origin gate reintroduced, cookie read added.

### 2026-08-18T19:43:08.366Z - Proof robustness set PROVEN: An unwarmed cache returns 503 rather than falling back to Postgres - the constructors take no pgxpool at all, so no DB path exists to fall back to. 404 on an unknown id is decided before If-None-Match, so a stale client asking about a withdrawn id is told it is gone rather than handed a 304 confirming what it holds.

### 2026-08-18T19:43:08.458Z - Proof resilience set PROVEN: A global rate limiter bounds all three routes. Mp3MetaGeneration reads only the etag key, so a revalidating client costs one small round trip instead of pulling 1.5MB from Redis to discover nothing changed.

### 2026-08-18T19:43:08.555Z - Proof security set PROVEN: Deliberately unauthenticated public reference data, matching the anonymous mp3 channel. Proven both ways: a request carrying a session cookie and an untrusted Origin gets a byte-identical response, AND a comment-stripped source scan asserts mp3meta.go names none of LookupSessionUser, SessionTokenFrom, Cookie, OriginAllowlist or pgxpool. The behavioural half alone could not prove a lookup did not happen, since a route that ignored the result would also pass.

### 2026-08-18T19:43:08.651Z - Proof defense-in-depth set PROVEN: Two layers. The payload is built from model.ItemMeta, which structurally cannot carry gate_reasons or model, and the handlers cannot read identity because they hold no pool and no allowlist. writeJSON was left byte-identical so username answers cannot become cacheable by accident - asserted by a test pinning that writeJSON still sets no-store while writeCachedJSON sets the opposite.

### 2026-08-18T19:43:08.747Z - Proof input-validation set PROVEN: The only client input is the path id and the If-None-Match header. An unparseable or unknown id is a 404 decided before any cache read; a non-GET is 405; the ETag comparison is exact-match against a server-built hash.

### 2026-08-18T19:43:08.840Z - Proof thread-safety set PROVEN: go test -race clean on internal/handler and internal/cache. Handlers are stateless reads over a shared limiter and Redis client with no mutable package state beyond the memoised build.

### 2026-08-18T19:43:08.934Z - Proof configurability set NOT_APPLICABLE: Nothing to configure. Route paths, cache-control lifetimes and the rate limit are fixed constants; making them tunable would let the HTTP and WebSocket transports that share one assembler drift apart.
