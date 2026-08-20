# HTTP API

The streamer is a WebSocket service first — [`docs/websocket-protocol.md`](./websocket-protocol.md)
is the contract that matters. This file covers the plain-HTTP routes served off the same host by the
`http.ServeMux` in [`cmd/server/main.go`](../cmd/server/main.go).

Most of those routes are operational or identity-bound (`/health`, `/ready`, `/clock`, `/alert`,
`/room`, `/chat/username-available`, `/feedback`) and are documented where they are implemented. The
three **mp3 metadata** routes are different: they are the only public, cacheable read API the
streamer exposes, and they have a consumer outside this repo's frontend, so they are specified here.

---

## mp3 metadata routes

Radio Traffic reference metadata for the mp3 corpus: who a recording is between, what it is about,
the tag vocabulary those recordings are filed under, and the pre-computed waveform envelope.

| Route | Payload | Approx. size | Who calls it |
|---|---|---|---|
| `GET /mp3/tags` | tag vocabulary only | ~50 KB | the Radio Traffic sidebar filter tree |
| `GET /mp3/meta` | vocabulary + every item | ~1.5 MB | external consumers, one-shot |
| `GET /mp3/meta/{id}` | one item | ~2-5 KB | anything that holds an id and wants its detail |

`/mp3/tags` is the route the app uses. It exists separately from `/mp3/meta` so the filter tree can
paint from the browser cache without pulling the per-item metadata it has no use for — tag filtering
*is* the navigation in Radio Traffic, so an unpainted sidebar is closer to feature loss than to a
cosmetic gap.

The frontend takes per-item metadata from the one-shot `mp3_meta` WebSocket frame instead, not from
`/mp3/meta`. That frame and these routes are built from the same
[`cache.AssembleMp3Meta`](../internal/cache/mp3.go) output — one producer, two transports.

### Shapes

All three responses carry the same top-level `generation`, so a client can tell that the vocabulary
it holds and the per-item tags it is rendering came from the same build (see *Generation* below).

`GET /mp3/tags`:

```json
{
  "generation": "5d36dcd2…",
  "vocabulary": [
    { "tag": "facility:zbw", "namespace": "facility", "value": "ZBW", "color": "#8b0000" }
  ]
}
```

`GET /mp3/meta`:

```json
{
  "generation": "5d36dcd2…",
  "vocabulary": [ … ],
  "items": {
    "5821": {
      "subject": "Boston Center coordinates with NEADS",
      "tier": "primary",
      "confidence": "high",
      "evidence": "…verbatim transcript quote…",
      "participants": [
        { "person": "Rountree", "facility": "zbw", "position": "…", "role": "controller",
          "confidence": "high" }
      ],
      "mentions": { "facilities": ["zob"], "aircraft": ["aal11"], "people": [] },
      "provenance": { "generated_at": "…", "sources": { … }, "commission": { … } },
      "tags": [ { "tag": "facility:zbw", "namespace": "facility", "value": "ZBW" } ],
      "peaks": [[-3, 3], [-12, 10]]
    }
  }
}
```

`items` is keyed by **string** item id (`mp3_items.id`), because that is what a JSON object key is.

`GET /mp3/meta/{id}`:

```json
{ "generation": "5d36dcd2…", "item": { … one entry from `items` above … } }
```

Field-by-field meaning lives on the Go types in [`internal/model/item.go`](../internal/model/item.go)
(`Tag`, `Participant`, `Mentions`, `Provenance`, `ItemMeta`) — that is the definition, not a copy of
it. `peaks` is 480 `[min, max]` pairs scaled to -128..127.

Absent by construction: `gate_reasons` and `model`. They are QA signals redacted upstream in
video-grabber's `public_meta.py`, and `ItemMeta` has nowhere to put them, so no layer here has
anything to strip. `mp3_items.parties` itself is private and stays that way.

### Status codes

| Code | When |
|---|---|
| `200` | normal |
| `304` | the request's `If-None-Match` matched the current generation |
| `404` | `/mp3/meta/{id}` only — no item holds that id |
| `405` | anything but `GET` |
| `429` | the rate limiter's bucket is empty |
| `503` | no metadata snapshot has been built yet |

`404` is decided **before** the conditional: a stale client asking about an id that has since been
withdrawn is told it is gone rather than handed a `304` that confirms the copy it still holds.

`503` means the first cache warm has not landed, or it failed against a database that predates the
metadata columns (`cache.warmMp3Meta` logs and continues rather than taking the mp3 channel down).
It is deliberately *not* an empty corpus: a client would cache that as the truth for five minutes.
`503` responses carry no `Cache-Control`, so the answer does not outlive the warm that fixes it.

### Caching

```
ETag: "5d36dcd2…"
Cache-Control: public, max-age=300, stale-while-revalidate=86400
```

This is immutable archival metadata about 2001. It should sit in every cache between the streamer
and the browser, which is the opposite of what `handler.writeJSON` — hardcoded to `no-store` for
"is this screen name free?" — provides. The cacheable variant is a **separate** function,
`writeCachedJSON`, rather than a parameter on the first: making username answers cacheable is the
exact bug `writeJSON`'s comment guards against, and a flag would put that bug one wrong argument
away.

`If-None-Match` is honoured, including a comma-separated list, a `W/`-prefixed weak tag, and `*`.
A `304` repeats the `ETag` and the `Cache-Control` so a client's stored copy does not expire on the
schedule of whichever response it last happened to receive.

One ETag covers every representation of a generation. That is correct because entity tags are only
ever compared against the same URL — a cache entry for `/mp3/tags` never offers its tag for
`/mp3/meta`.

### Generation

`generation` is the SHA-256 of the assembled items + vocabulary bytes; `ETag` is the same value
quoted. Content-addressed rather than a per-process build id, because the streamer runs N replicas:
a client that takes its vocabulary from one pod's `/mp3/tags` and its per-item tags from another
pod's socket must see the same stamp for the same data, or the mismatch check becomes a refetch
loop.

The client compares the `generation` on `/mp3/tags` against the one on the `mp3_meta` frame and
refetches the vocabulary **once** on a mismatch.

### CORS caveat — verified live, do not design around it

CORS for this host is Traefik middleware `streamer-cors`
(`infra@main:apps/rt911/streamer.yaml`), bound to the ingress at `path: /`, `pathType: Prefix`. It
covers the whole streamer host, so these routes needed **no infra change** to become reachable.

But its preflight allows only `Content-Type` and sets no `access-control-expose-headers`. Verified
against production: an `OPTIONS` carrying `Access-Control-Request-Headers: if-none-match` comes back
with `access-control-allow-headers: Content-Type`.

Consequences for browser JS:

- **Do not set `If-None-Match` from `fetch()`.** The preflight will reject it.
- **You cannot read `ETag` from a `Response`.** It is not exposed.
- Issue plain `GET`s. The browser's own HTTP cache revalidates underneath JS using the `ETag` and
  `Cache-Control` above, and that path is unaffected by the allowlist — you get the 304 benefit
  without touching the headers.

Server-side conditional GET is implemented anyway, for non-browser clients (curl, scripts, CDNs,
other services) that can condition explicitly. Nothing is built on top of a browser sending the
header.

Making hand-rolled conditional requests work from `fetch()` would mean adding `If-None-Match` to
`accessControlAllowHeaders` and `ETag` to `accessControlExposeHeaders` in
`infra@main:apps/rt911/streamer.yaml`. That is an infra change, deliberately out of scope.

### Rate limit

A single global `rate.NewLimiter(10, 20)` — 10 requests/second sustained, burst 20 — shared by all
three routes, per pod. Over the limit is `429 slow down`.

One global bucket rather than per-IP: a per-IP map is an unbounded leak, and behind the ingress the
addresses would be the ingress's anyway. The limiter's job is not to stop the corpus being copied
(one `GET /mp3/meta` copies the lot, by design) but to stop a scripted client pinning the process.

### Security

These routes are **deliberately open**: no authentication, no origin gate, no cookie read, no
`db.LookupSessionUser`. Three reasons, all load-bearing:

- This is the same public corpus the **anonymous** mp3 WebSocket channel already streams. HTTP makes
  it trivially scrapable in one request where the socket path needed a session; for public 9/11
  archival metadata that is an accepted trade, and the rate limiter is the mitigation.
- `OriginAllowlist` gates **identity, never access**. Its own documentation says an untrusted origin
  still streams every channel anonymously. Applying it here would gate access — a different thing
  from what it is for.
- A response that varied with a cookie could not carry `Cache-Control: public` at all.

`internal/handler/mp3meta_test.go` enforces this in both directions: behaviourally (a request
carrying a session cookie and an untrusted `Origin` gets a byte-identical response) and structurally
(the source of `mp3meta.go` names none of `LookupSessionUser`, `SessionTokenFrom`, `Cookie`,
`OriginAllowlist` or `pgxpool`).

### Data path

Redis only. There is no Postgres fallback — an unwarmed cache is a `503`, not a database query,
which is what keeps a scriptable public route off the primary. The snapshot is produced by
`cache.BuildMp3Meta` on warm, on listener resync, and behind the debounce in
`internal/cache/mp3_listen.go`; never on a tick and never per request.

Per request the handler issues **one small `GET`** of the generation key. When it matches what the
process already holds — the common case — the pre-composed response bytes are written straight to
the wire. Only when the generation moves is the ~1.5 MB payload read back and re-composed:

- the envelopes are **spliced** around the JSON fragments `cache.Mp3Meta` already holds, never
  re-marshalled (the cache stores bytes rather than values for exactly this reason);
- the item map is decoded once into `map[string]json.RawMessage`, so `/mp3/meta/{id}` can index a
  single item without decoding ~1.5 MB per request.

The rendered view is process-wide, not per-handler: all three routes answer from the same
generation, and rendering per handler would triple both the work and the resident bytes. Two
requests can race across a rebuild and one may leave an older view behind; that is self-correcting,
because the next request probes the generation, sees the mismatch and re-renders.
