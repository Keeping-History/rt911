package handler

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"classicy/streamer/internal/cache"
	"classicy/streamer/internal/model"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"
	"golang.org/x/time/rate"
)

// The limiter is a package-level global on purpose (see mp3meta.go), so a test
// that wants to exercise the handlers rather than the bucket has to swap it out
// and put it back. Swapped rather than reconfigured: SetLimit/SetBurst leave the
// tokens already in the old bucket behind, which makes what the next test sees
// depend on what the last one spent.
func swapMp3MetaLimiter(t *testing.T, limiter *rate.Limiter) {
	t.Helper()
	saved := mp3MetaLimiter
	mp3MetaLimiter = limiter
	t.Cleanup(func() { mp3MetaLimiter = saved })
}

func unlimitMp3Meta(t *testing.T) {
	t.Helper()
	swapMp3MetaLimiter(t, rate.NewLimiter(rate.Inf, 1))
}

func sampleMp3Corpus() (map[int]model.ItemMeta, []model.Tag) {
	vocab := []model.Tag{
		{Tag: "facility:zob", Namespace: "facility", Value: "zob"},
		{Tag: "aircraft:aal11", Namespace: "aircraft", Value: "aal11"},
		{Tag: "topic:hijack", Namespace: "topic", Value: "hijack"},
	}
	items := map[int]model.ItemMeta{
		5821: {
			Subject:      "Boston Center coordinates with Herndon",
			Tier:         "primary",
			Confidence:   "high",
			Participants: []model.Participant{{Person: "Rountree", Facility: "zbw", Role: "controller"}},
			Mentions:     &model.Mentions{Facilities: []string{"zob"}, Aircraft: []string{"aal11"}, People: []string{}},
			Tags:         []model.Tag{vocab[0], vocab[1]},
			Peaks:        [][2]int8{{-3, 3}, {-12, 10}},
		},
		// An item with no metadata beyond an empty tag list: the client has to be
		// able to tell "nothing is tagged" from "the field is missing".
		5822: {Tags: []model.Tag{}},
	}
	return items, vocab
}

// warmMp3MetaRedis stands up a miniredis holding one stored build — the same
// keys and the same assembler the cache warm writes, so the handlers are read
// through the real storage shape rather than a stub.
func warmMp3MetaRedis(t *testing.T, items map[int]model.ItemMeta, vocab []model.Tag) (*goredis.Client, *cache.Mp3Meta) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis.Run: %v", err)
	}
	rdb := goredis.NewClient(&goredis.Options{Addr: mr.Addr()})
	t.Cleanup(func() {
		rdb.Close()
		mr.Close()
	})

	m, err := cache.AssembleMp3Meta(items, vocab)
	if err != nil {
		t.Fatalf("AssembleMp3Meta: %v", err)
	}
	if err := cache.StoreMp3Meta(t.Context(), rdb, m); err != nil {
		t.Fatalf("StoreMp3Meta: %v", err)
	}
	return rdb, m
}

// mp3MetaMux registers the routes exactly as cmd/server/main.go does, so the
// {id} wildcard is resolved by the real pattern rather than by a hand-set path
// value that could disagree with what is deployed.
func mp3MetaMux(rdb *goredis.Client) *http.ServeMux {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	mux := http.NewServeMux()
	mux.HandleFunc("GET /mp3/tags", NewMp3TagsHandler(rdb, logger))
	mux.HandleFunc("GET /mp3/meta", NewMp3MetaHandler(rdb, logger))
	mux.HandleFunc("GET /mp3/meta/{id}", NewMp3MetaItemHandler(rdb, logger))
	return mux
}

func getMp3(t *testing.T, mux *http.ServeMux, path string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest("GET", path, nil)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	return w
}

// The sidebar filter tree is painted from this route alone, and it compares the
// generation against the one on the mp3_meta frame to notice it is holding
// vocabulary from a different build than the per-item tags it is rendering.
func TestMp3TagsServesTheVocabularyStampedWithItsGeneration(t *testing.T) {
	unlimitMp3Meta(t)
	items, vocab := sampleMp3Corpus()
	rdb, stored := warmMp3MetaRedis(t, items, vocab)

	w := getMp3(t, mp3MetaMux(rdb), "/mp3/tags", nil)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", w.Code, w.Body.String())
	}
	var body struct {
		Generation string      `json:"generation"`
		Vocabulary []model.Tag `json:"vocabulary"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Generation != stored.Generation {
		t.Errorf("generation = %q, want %q", body.Generation, stored.Generation)
	}
	if len(body.Vocabulary) != len(vocab) || body.Vocabulary[0].Tag != "facility:zob" {
		t.Errorf("vocabulary = %+v, want the stored %+v", body.Vocabulary, vocab)
	}
	// The whole reason this route exists apart from /mp3/meta: the filter tree
	// must not have to pull the per-item metadata to draw itself.
	if strings.Contains(w.Body.String(), "Boston Center") {
		t.Error("/mp3/tags carried per-item metadata; it must serve the vocabulary alone")
	}
}

func TestMp3MetaServesVocabularyAndEveryItem(t *testing.T) {
	unlimitMp3Meta(t)
	items, vocab := sampleMp3Corpus()
	rdb, stored := warmMp3MetaRedis(t, items, vocab)

	w := getMp3(t, mp3MetaMux(rdb), "/mp3/meta", nil)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", w.Code, w.Body.String())
	}
	var body struct {
		Generation string                    `json:"generation"`
		Vocabulary []model.Tag               `json:"vocabulary"`
		Items      map[string]model.ItemMeta `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Generation != stored.Generation {
		t.Errorf("generation = %q, want %q", body.Generation, stored.Generation)
	}
	if len(body.Vocabulary) != len(vocab) {
		t.Errorf("vocabulary has %d tags, want %d", len(body.Vocabulary), len(vocab))
	}
	if len(body.Items) != len(items) {
		t.Fatalf("items has %d entries, want %d", len(body.Items), len(items))
	}
	if body.Items["5821"].Subject != "Boston Center coordinates with Herndon" {
		t.Errorf("item 5821 = %+v, want the stored metadata", body.Items["5821"])
	}
	// Step 1 redacts these at derivation, so ItemMeta structurally cannot hold
	// them. Asserted anyway: this is the response a scraper gets in one request.
	for _, secret := range []string{"gate_reasons", "model"} {
		if strings.Contains(w.Body.String(), secret) {
			t.Errorf("%q leaked into the public metadata response", secret)
		}
	}
}

func TestMp3MetaItemServesOneItemAndIsHonestAboutUnknownIDs(t *testing.T) {
	unlimitMp3Meta(t)
	items, vocab := sampleMp3Corpus()
	rdb, stored := warmMp3MetaRedis(t, items, vocab)
	mux := mp3MetaMux(rdb)

	w := getMp3(t, mux, "/mp3/meta/5821", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", w.Code, w.Body.String())
	}
	var body struct {
		Generation string         `json:"generation"`
		Item       model.ItemMeta `json:"item"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Generation != stored.Generation {
		t.Errorf("generation = %q, want %q", body.Generation, stored.Generation)
	}
	if body.Item.Subject != "Boston Center coordinates with Herndon" || len(body.Item.Tags) != 2 {
		t.Errorf("item = %+v, want the stored metadata for 5821", body.Item)
	}
	// One item, not the corpus.
	if strings.Contains(w.Body.String(), "5822") {
		t.Error("the single-item route returned more than the item asked for")
	}

	for _, unknown := range []string{"999999", "not-a-number"} {
		w := getMp3(t, mux, "/mp3/meta/"+unknown, nil)
		if w.Code != http.StatusNotFound {
			t.Errorf("id %q: status = %d, want 404", unknown, w.Code)
		}
	}
}

// A stale client asking about an id that has since been withdrawn must be told
// it is gone. Answering 304 first would confirm whatever copy it still holds.
func TestMp3MetaItemPrefers404OverAMatchingIfNoneMatch(t *testing.T) {
	unlimitMp3Meta(t)
	items, vocab := sampleMp3Corpus()
	rdb, stored := warmMp3MetaRedis(t, items, vocab)

	w := getMp3(t, mp3MetaMux(rdb), "/mp3/meta/999999",
		map[string]string{"If-None-Match": stored.ETag})

	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", w.Code)
	}
}

func TestMp3MetaRoutesRefuseAnythingButGET(t *testing.T) {
	unlimitMp3Meta(t)
	items, vocab := sampleMp3Corpus()
	rdb, _ := warmMp3MetaRedis(t, items, vocab)
	mux := mp3MetaMux(rdb)

	for _, path := range []string{"/mp3/tags", "/mp3/meta", "/mp3/meta/5821"} {
		for _, method := range []string{"POST", "PUT", "DELETE", "PATCH"} {
			r := httptest.NewRequest(method, path, nil)
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			if w.Code != http.StatusMethodNotAllowed {
				t.Errorf("%s %s: status = %d, want 405", method, path, w.Code)
			}
		}
	}
}

// The mux's method pattern rejects a non-GET before the handler is reached, so
// the handler's own check is only exercised when it is called directly. It is
// kept — and tested — so a future re-registration on a bare path cannot silently
// turn these into write endpoints.
func TestMp3MetaHandlersCheckTheMethodThemselves(t *testing.T) {
	unlimitMp3Meta(t)
	items, vocab := sampleMp3Corpus()
	rdb, _ := warmMp3MetaRedis(t, items, vocab)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	for name, h := range map[string]http.HandlerFunc{
		"tags": NewMp3TagsHandler(rdb, logger),
		"meta": NewMp3MetaHandler(rdb, logger),
		"item": NewMp3MetaItemHandler(rdb, logger),
	} {
		w := httptest.NewRecorder()
		h(w, httptest.NewRequest("POST", "/mp3/meta", nil))
		if w.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s: status = %d, want 405", name, w.Code)
		}
	}
}

func TestMp3MetaMatchingIfNoneMatchIsA304WithAnEmptyBody(t *testing.T) {
	unlimitMp3Meta(t)
	items, vocab := sampleMp3Corpus()
	rdb, stored := warmMp3MetaRedis(t, items, vocab)
	mux := mp3MetaMux(rdb)

	for _, path := range []string{"/mp3/tags", "/mp3/meta", "/mp3/meta/5821"} {
		// The ETag a client would have taken off the previous 200 — the header
		// values must round-trip, not merely be equal to a constant.
		etag := getMp3(t, mux, path, nil).Header().Get("ETag")
		if etag != stored.ETag {
			t.Fatalf("%s: ETag = %q, want %q", path, etag, stored.ETag)
		}

		w := getMp3(t, mux, path, map[string]string{"If-None-Match": etag})
		if w.Code != http.StatusNotModified {
			t.Errorf("%s: status = %d, want 304", path, w.Code)
		}
		if w.Body.Len() != 0 {
			t.Errorf("%s: 304 carried a %d-byte body", path, w.Body.Len())
		}
		// A 304 that dropped the freshness would expire the client's stored copy
		// on the schedule of whichever response it last happened to receive.
		if got := w.Header().Get("Cache-Control"); !strings.Contains(got, "max-age=300") {
			t.Errorf("%s: 304 Cache-Control = %q", path, got)
		}
		if got := w.Header().Get("ETag"); got != etag {
			t.Errorf("%s: 304 ETag = %q, want %q", path, got, etag)
		}

		// A non-matching tag is a full response again.
		w = getMp3(t, mux, path, map[string]string{"If-None-Match": `"some-older-build"`})
		if w.Code != http.StatusOK {
			t.Errorf("%s: stale If-None-Match gave %d, want 200", path, w.Code)
		}
	}
}

// Proxies fold multiple cached tags into one comma-separated header, and a weak
// comparison is the right one for a conditional GET.
func TestMp3MetaIfNoneMatchAcceptsAListAndWeakTags(t *testing.T) {
	unlimitMp3Meta(t)
	items, vocab := sampleMp3Corpus()
	rdb, stored := warmMp3MetaRedis(t, items, vocab)
	mux := mp3MetaMux(rdb)

	for _, header := range []string{
		stored.ETag,
		`"an-older-build", ` + stored.ETag,
		"W/" + stored.ETag,
		"*",
	} {
		w := getMp3(t, mux, "/mp3/meta", map[string]string{"If-None-Match": header})
		if w.Code != http.StatusNotModified {
			t.Errorf("If-None-Match %q: status = %d, want 304", header, w.Code)
		}
	}
	for _, header := range []string{"", `"nope"`, `"a", "b"`} {
		w := getMp3(t, mux, "/mp3/meta", map[string]string{"If-None-Match": header})
		if w.Code != http.StatusOK {
			t.Errorf("If-None-Match %q: status = %d, want 200", header, w.Code)
		}
	}
}

// This is immutable archival metadata about 2001. It should sit in every cache
// between here and the browser — the opposite of what writeJSON's callers want.
func TestMp3MetaResponsesAreCacheable(t *testing.T) {
	unlimitMp3Meta(t)
	items, vocab := sampleMp3Corpus()
	rdb, _ := warmMp3MetaRedis(t, items, vocab)
	mux := mp3MetaMux(rdb)

	for _, path := range []string{"/mp3/tags", "/mp3/meta", "/mp3/meta/5821"} {
		w := getMp3(t, mux, path, nil)
		cc := w.Header().Get("Cache-Control")
		if strings.Contains(cc, "no-store") || strings.Contains(cc, "no-cache") {
			t.Errorf("%s: Cache-Control = %q, must not suppress caching", path, cc)
		}
		for _, want := range []string{"public", "max-age=300", "stale-while-revalidate=86400"} {
			if !strings.Contains(cc, want) {
				t.Errorf("%s: Cache-Control = %q, missing %q", path, cc, want)
			}
		}
		if w.Header().Get("ETag") == "" {
			t.Errorf("%s: no ETag, so a client has nothing to revalidate with", path)
		}
		if got := w.Header().Get("Content-Type"); got != "application/json" {
			t.Errorf("%s: Content-Type = %q", path, got)
		}
	}
}

// writeJSON hardcodes no-store because its caller answers "is this screen name
// free?", where a cached answer is the bug. Teaching it to be cacheable would
// put that bug one wrong argument away, so the cacheable variant is a separate
// function — and this asserts the two have not converged.
func TestWriteJSONStaysUncacheableAndWriteCachedJSONDoesNot(t *testing.T) {
	plain := httptest.NewRecorder()
	writeJSON(plain, http.StatusOK, map[string]any{"available": true})
	if got := plain.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("writeJSON Cache-Control = %q, want no-store", got)
	}
	if got := plain.Header().Get("ETag"); got != "" {
		t.Errorf("writeJSON set an ETag (%q); a no-store answer has nothing to validate", got)
	}

	cached := httptest.NewRecorder()
	writeCachedJSON(cached, `"gen"`, []byte(`{"ok":true}`))
	if got := cached.Header().Get("Cache-Control"); got != "public, max-age=300, stale-while-revalidate=86400" {
		t.Errorf("writeCachedJSON Cache-Control = %q", got)
	}
	if got := cached.Header().Get("ETag"); got != `"gen"` {
		t.Errorf("writeCachedJSON ETag = %q", got)
	}
	if got := cached.Body.String(); got != `{"ok":true}` {
		t.Errorf("writeCachedJSON body = %q; the bytes must reach the wire unencoded", got)
	}
}

// These routes are deliberately open: same public corpus the anonymous mp3
// channel serves, and OriginAllowlist gates identity rather than access. A
// request that carries a session cookie must therefore get exactly the same
// answer as one that does not — no personalisation, nothing to vary on.
func TestMp3MetaIgnoresSessionCookiesAndOrigins(t *testing.T) {
	unlimitMp3Meta(t)
	items, vocab := sampleMp3Corpus()
	rdb, _ := warmMp3MetaRedis(t, items, vocab)
	mux := mp3MetaMux(rdb)

	for _, path := range []string{"/mp3/tags", "/mp3/meta", "/mp3/meta/5821"} {
		anonymous := getMp3(t, mux, path, nil)
		identified := getMp3(t, mux, path, map[string]string{
			"Cookie": "directus_session_token=a-real-looking-session",
			"Origin": "https://archived-third-party.911realtime.org",
		})

		if identified.Code != anonymous.Code {
			t.Errorf("%s: signed-in status %d, anonymous %d", path, identified.Code, anonymous.Code)
		}
		if identified.Body.String() != anonymous.Body.String() {
			t.Errorf("%s: the response varied with the caller's cookie", path)
		}
		if identified.Code != http.StatusOK {
			t.Errorf("%s: an untrusted origin was refused; these routes gate nothing", path)
		}
		if got := identified.Header().Get("Vary"); strings.Contains(strings.ToLower(got), "cookie") {
			t.Errorf("%s: Vary = %q — the response must not depend on a cookie", path, got)
		}
		if identified.Header().Get("Set-Cookie") != "" {
			t.Errorf("%s: a read of public reference data issued a cookie", path)
		}
	}
}

// The behavioural test above cannot prove a *lookup* did not happen — an
// authenticated route that ignored the result would pass it. This can: the
// identity helpers are named, so their absence from the source is checkable, and
// a future edit that reintroduces auth here trips this rather than shipping.
func TestMp3MetaHandlersNameNoIdentityMachinery(t *testing.T) {
	src, err := os.ReadFile("mp3meta.go")
	if err != nil {
		t.Fatalf("read mp3meta.go: %v", err)
	}
	code := stripGoComments(string(src))
	for _, forbidden := range []string{
		"LookupSessionUser", "SessionTokenFrom", "Cookie", "OriginAllowlist", "pgxpool",
	} {
		if strings.Contains(code, forbidden) {
			t.Errorf("mp3meta.go references %q; these routes take no auth, no origin gate "+
				"and no database", forbidden)
		}
	}
}

// stripGoComments removes // and /* */ comments so a prose mention of a symbol —
// the file explains at length *why* it calls none of these — is not read as a
// call to it.
func stripGoComments(src string) string {
	var out strings.Builder
	for i := 0; i < len(src); {
		switch {
		case strings.HasPrefix(src[i:], "//"):
			end := strings.IndexByte(src[i:], '\n')
			if end < 0 {
				return out.String()
			}
			i += end
		case strings.HasPrefix(src[i:], "/*"):
			end := strings.Index(src[i+2:], "*/")
			if end < 0 {
				return out.String()
			}
			i += end + 4
		default:
			out.WriteByte(src[i])
			i++
		}
	}
	return out.String()
}

// The payload is ~1.5 MB. Re-encoding it, or re-decoding the item map to pick
// one id out of it, on every request is the difference between a cheap public
// route and a lever for tipping the box over.
func TestMp3MetaBytesAreBuiltOncePerGeneration(t *testing.T) {
	unlimitMp3Meta(t)
	items, vocab := sampleMp3Corpus()
	rdb, first := warmMp3MetaRedis(t, items, vocab)
	mux := mp3MetaMux(rdb)

	getMp3(t, mux, "/mp3/meta", nil)
	mp3MetaMu.RLock()
	rendered := mp3MetaHeld
	mp3MetaMu.RUnlock()
	if rendered == nil || rendered.generation != first.Generation {
		t.Fatalf("no view held for generation %q", first.Generation)
	}

	// Every route, several times over: none of them may re-render.
	for range 3 {
		for _, path := range []string{"/mp3/tags", "/mp3/meta", "/mp3/meta/5821"} {
			if w := getMp3(t, mux, path, nil); w.Code != http.StatusOK {
				t.Fatalf("%s: status %d", path, w.Code)
			}
		}
	}
	mp3MetaMu.RLock()
	stillHeld := mp3MetaHeld
	mp3MetaMu.RUnlock()
	if stillHeld != rendered {
		t.Error("the response bytes were rebuilt while the generation stood still")
	}

	// A new build must be picked up: held-forever is the other failure mode.
	items[5823] = model.ItemMeta{Subject: "a later recording", Tags: []model.Tag{}}
	second, err := cache.AssembleMp3Meta(items, vocab)
	if err != nil {
		t.Fatalf("AssembleMp3Meta: %v", err)
	}
	if second.Generation == first.Generation {
		t.Fatal("a changed corpus produced the same generation")
	}
	if err := cache.StoreMp3Meta(t.Context(), rdb, second); err != nil {
		t.Fatalf("StoreMp3Meta: %v", err)
	}

	w := getMp3(t, mux, "/mp3/meta/5823", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("the new item is not served: status %d", w.Code)
	}
	if got := w.Header().Get("ETag"); got != second.ETag {
		t.Errorf("ETag = %q, want the new build's %q", got, second.ETag)
	}
	// The old tag must no longer satisfy a conditional GET, or a client sits on
	// the previous corpus until its max-age lapses.
	if w := getMp3(t, mux, "/mp3/meta", map[string]string{"If-None-Match": first.ETag}); w.Code != http.StatusOK {
		t.Errorf("the superseded ETag still yielded %d, want 200", w.Code)
	}
}

// Redis is the only store behind these routes. There is no Postgres fallback to
// reach for — an unwarmed cache is 503, not a database query — which is what
// keeps a scriptable public route off the primary.
func TestMp3MetaWithoutAWarmCacheIs503(t *testing.T) {
	unlimitMp3Meta(t)
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis.Run: %v", err)
	}
	defer mr.Close()
	rdb := goredis.NewClient(&goredis.Options{Addr: mr.Addr()})
	defer rdb.Close()

	// Nothing stored: the first cache warm has not landed yet.
	mux := mp3MetaMux(rdb)
	for _, path := range []string{"/mp3/tags", "/mp3/meta", "/mp3/meta/5821"} {
		w := getMp3(t, mux, path, nil)
		if w.Code != http.StatusServiceUnavailable {
			t.Errorf("%s: status = %d, want 503", path, w.Code)
		}
		// A 503 that got cached for five minutes would outlast the warm that
		// fixes it.
		if cc := w.Header().Get("Cache-Control"); strings.Contains(cc, "max-age") {
			t.Errorf("%s: an unavailable answer was marked cacheable (%q)", path, cc)
		}
	}
}

// The limiter is the only gate on an otherwise open route. Its job is not to
// stop the corpus being copied — one GET copies the lot, by design — but to stop
// a scripted client pinning the process.
func TestMp3MetaRateLimits(t *testing.T) {
	items, vocab := sampleMp3Corpus()
	rdb, _ := warmMp3MetaRedis(t, items, vocab)
	mux := mp3MetaMux(rdb)

	swapMp3MetaLimiter(t, rate.NewLimiter(1, 1))

	if w := getMp3(t, mux, "/mp3/meta", nil); w.Code != http.StatusOK {
		t.Fatalf("first request: status = %d, want 200", w.Code)
	}
	// One bucket across all three routes, so the second route pays for the first.
	if w := getMp3(t, mux, "/mp3/tags", nil); w.Code != http.StatusTooManyRequests {
		t.Errorf("second request: status = %d, want 429", w.Code)
	}
}
