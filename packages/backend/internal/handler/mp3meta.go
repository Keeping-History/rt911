package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"classicy/streamer/internal/cache"

	goredis "github.com/redis/go-redis/v9"
	"golang.org/x/time/rate"
)

// mp3MetaLimiter bounds all three metadata routes together.
//
// Public reference data: no auth, no origin gate, no cookie. OriginAllowlist
// gates identity, not access — an untrusted origin already streams every
// channel anonymously — and this is the same corpus the anonymous mp3 channel
// serves. A limiter is therefore the only gate, and its job is not to stop
// copying (one GET copies the lot, by design) but to stop a scripted client
// pinning the box. One global bucket rather than per-IP: the per-IP map is an
// unbounded leak, and behind an ingress the addresses would be the ingress's
// anyway.
var mp3MetaLimiter = rate.NewLimiter(10, 20)

// mp3MetaView is one cache generation rendered into every byte the three routes
// can be asked for.
//
// Story 005's cache holds pre-marshalled JSON precisely so the HTTP path never
// re-encodes, but two jobs are still left over per generation: wrapping the
// fragments in their response envelope, and splitting the item map so a single
// id can be answered without decoding ~1.5 MB. Both happen here, once, and the
// result is held for as long as the generation stands.
type mp3MetaView struct {
	generation string
	// The generation as a JSON string literal, so composing an envelope is a
	// concatenation rather than a marshal.
	generationJSON []byte
	etag           string
	// tags is GET /mp3/tags — ~50 KB of vocabulary, which is all the sidebar
	// filter tree needs to paint.
	tags []byte
	// meta is GET /mp3/meta — the same vocabulary plus every item, ~1.5 MB.
	meta []byte
	// items backs GET /mp3/meta/{id}: the item map decoded exactly far enough to
	// index it, with each item's bytes left untouched for the wire.
	items map[string]json.RawMessage
}

// The rendered view is process-wide rather than per-handler: all three routes
// answer from the same generation, and rendering it once per handler would
// triple both the work and the resident bytes for no gain.
var (
	mp3MetaMu   sync.RWMutex
	mp3MetaHeld *mp3MetaView
)

// NewMp3TagsHandler serves the tag vocabulary alone.
//
// This is the route the Radio Traffic sidebar calls. It exists as its own
// endpoint so the filter tree can paint from the browser cache without pulling
// the ~1.5 MB of per-item metadata it has no use for.
func NewMp3TagsHandler(rdb *goredis.Client, logger *slog.Logger) http.HandlerFunc {
	return mp3MetaRoute(rdb, logger, "mp3 tag vocabulary",
		func(v *mp3MetaView, _ *http.Request) []byte { return v.tags })
}

// NewMp3MetaHandler serves the vocabulary and every item in one response — the
// convenience route for external consumers, who have no socket to take the
// mp3_meta frame from.
func NewMp3MetaHandler(rdb *goredis.Client, logger *slog.Logger) http.HandlerFunc {
	return mp3MetaRoute(rdb, logger, "mp3 metadata",
		func(v *mp3MetaView, _ *http.Request) []byte { return v.meta })
}

// NewMp3MetaItemHandler serves one item's metadata, or 404 when no item holds
// that id.
func NewMp3MetaItemHandler(rdb *goredis.Client, logger *slog.Logger) http.HandlerFunc {
	return mp3MetaRoute(rdb, logger, "mp3 item metadata",
		func(v *mp3MetaView, r *http.Request) []byte {
			item, ok := v.items[r.PathValue("id")]
			if !ok {
				return nil
			}
			return fmt.Appendf(nil, `{"generation":%s,"item":%s}`, v.generationJSON, item)
		})
}

// mp3MetaRoute is the shape all three share: method check, rate limit, snapshot,
// conditional GET, serve. Only the body selection differs, so only that is a
// parameter — a nil body means the request named something that does not exist.
func mp3MetaRoute(
	rdb *goredis.Client,
	logger *slog.Logger,
	what string,
	body func(*mp3MetaView, *http.Request) []byte,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !mp3MetaLimiter.Allow() {
			http.Error(w, "slow down", http.StatusTooManyRequests)
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()

		view, err := mp3MetaSnapshot(ctx, rdb)
		if err != nil {
			logger.Warn("mp3 metadata read failed", "route", what, "error", err)
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		// No snapshot has been built yet — the first cache warm has not landed,
		// or it failed against a database without the metadata columns. Saying
		// so beats serving an empty corpus a client would cache for five minutes
		// as the truth.
		if view == nil {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}

		payload := body(view, r)
		// Existence is decided before the conditional: a stale client asking
		// about an id that has since gone away must be told it is gone, not
		// handed a 304 that confirms whatever it still holds.
		if payload == nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}

		if etagMatches(r.Header.Get("If-None-Match"), view.etag) {
			writeCacheValidators(w, view.etag)
			w.WriteHeader(http.StatusNotModified)
			return
		}
		writeCachedJSON(w, view.etag, payload)
	}
}

// mp3MetaSnapshot returns the current view, or nil when nothing has been built.
//
// The generation is probed on its own first so the common case — nothing has
// changed since the last request — costs one small GET instead of dragging the
// whole payload out of Redis to discover it is the payload already held.
func mp3MetaSnapshot(ctx context.Context, rdb *goredis.Client) (*mp3MetaView, error) {
	generation, err := cache.Mp3MetaGeneration(ctx, rdb)
	if err != nil {
		return nil, err
	}
	if generation == "" {
		return nil, nil
	}

	mp3MetaMu.RLock()
	held := mp3MetaHeld
	mp3MetaMu.RUnlock()
	if held != nil && held.generation == generation {
		return held, nil
	}

	m, err := cache.LoadMp3Meta(ctx, rdb)
	if err != nil {
		return nil, err
	}
	if m == nil {
		return nil, nil
	}
	view, err := renderMp3MetaView(m)
	if err != nil {
		return nil, err
	}

	// Unconditional store, so a request that rendered an older generation while
	// a newer one landed can leave the stale view behind. That is self-correcting
	// rather than sticky: the next request probes the generation, sees the
	// mismatch and re-renders. Holding a lock across the Redis read to prevent it
	// would serialise every request behind one slow round trip, which is a worse
	// trade than one extra render.
	mp3MetaMu.Lock()
	mp3MetaHeld = view
	mp3MetaMu.Unlock()
	return view, nil
}

// renderMp3MetaView does the whole per-generation cost in one place: one decode
// of the item map into raw per-item bytes, and the envelopes spliced around
// fragments the cache already encoded.
//
// Spliced rather than marshalled: the cache holds bytes, not values, exactly so
// this path never runs ~1.5 MB back through the encoder to produce what it was
// handed.
func renderMp3MetaView(m *cache.Mp3Meta) (*mp3MetaView, error) {
	var items map[string]json.RawMessage
	if err := json.Unmarshal(m.ItemsJSON, &items); err != nil {
		return nil, fmt.Errorf("index mp3 metadata: %w", err)
	}
	generationJSON, err := json.Marshal(m.Generation)
	if err != nil {
		return nil, fmt.Errorf("marshal mp3 metadata generation: %w", err)
	}

	return &mp3MetaView{
		generation:     m.Generation,
		generationJSON: generationJSON,
		etag:           m.ETag,
		tags: fmt.Appendf(nil, `{"generation":%s,"vocabulary":%s}`,
			generationJSON, m.VocabJSON),
		meta: fmt.Appendf(nil, `{"generation":%s,"vocabulary":%s,"items":%s}`,
			generationJSON, m.VocabJSON, m.ItemsJSON),
		items: items,
	}, nil
}

// etagMatches implements the If-None-Match comparison.
//
// One ETag covers every representation of a generation, which is correct
// because entity tags are only ever compared against the same URL — a browser
// cache keyed on /mp3/tags never offers that entry's tag for /mp3/meta.
//
// Note that browser JS cannot reach this path: the streamer's Traefik CORS
// middleware allows only Content-Type on the preflight, so fetch() may not set
// If-None-Match and may not read ETag. The browser's own HTTP cache revalidates
// underneath JS and is unaffected, and non-browser clients can condition
// explicitly — which is why this is implemented and why nothing is built on top
// of a browser sending the header.
func etagMatches(header, etag string) bool {
	if header == "" {
		return false
	}
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" || strings.TrimPrefix(candidate, "W/") == etag {
			return true
		}
	}
	return false
}

// writeCachedJSON is the sibling of writeJSON, which hardcodes Cache-Control:
// no-store.
//
// Deliberately a second function rather than a parameter on the first: this is
// immutable archival metadata that should sit in every cache between here and
// the browser, while writeJSON's caller answers "is this screen name free?",
// where a cached answer is the exact bug its comment guards against. Teaching
// writeJSON to be cacheable would put that bug one wrong argument away.
func writeCachedJSON(w http.ResponseWriter, etag string, body []byte) {
	w.Header().Set("Content-Type", "application/json")
	writeCacheValidators(w, etag)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// writeCacheValidators is shared with the 304 path, which must repeat the ETag
// and the freshness the 200 would have carried — otherwise the client's stored
// copy expires on the schedule of whichever response it last happened to get.
// Content-Type is not among them: a 304 has no body to describe.
func writeCacheValidators(w http.ResponseWriter, etag string) {
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "public, max-age=300, stale-while-revalidate=86400")
}
