package handler

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"

	"classicy/streamer/internal/db"
	"testing"
)

func usernameHandler(t *testing.T) http.HandlerFunc {
	t.Helper()
	// A nil pool is fine for the cases that must be rejected before any query.
	return NewUsernameAvailableHandler(nil, NewOriginAllowlist(""), slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func TestUsernameCheckRejectsAnUntrustedOrigin(t *testing.T) {
	// The endpoint turns a session cookie into an identity, and SameSite=lax
	// bounds that cookie to the site rather than the origin — so any host under
	// 911realtime.org could otherwise ask on a signed-in user's behalf.
	r := httptest.NewRequest("GET", "/chat/username-available?name=danny", nil)
	r.Header.Set("Origin", "https://archived-third-party.911realtime.org")
	w := httptest.NewRecorder()

	usernameHandler(t)(w, r)

	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", w.Code)
	}
}

func TestUsernameCheckRejectsAMalformedNameBeforeQuerying(t *testing.T) {
	// A nil pool would panic if this reached the database, which is what makes
	// this test meaningful: it proves the shape check runs first.
	for _, bad := range []string{"ab", "", "Danny!", "a-very-long-name-well-past-the-limit"} {
		r := httptest.NewRequest("GET", "/chat/username-available?name="+bad, nil)
		w := httptest.NewRecorder()

		usernameHandler(t)(w, r)

		if w.Code != http.StatusBadRequest {
			t.Errorf("name %q: status = %d, want 400", bad, w.Code)
		}
		var body struct{ Available bool }
		_ = json.Unmarshal(w.Body.Bytes(), &body)
		if body.Available {
			t.Errorf("name %q reported available", bad)
		}
	}
}

func TestUsernameCheckRefusesAnythingButGET(t *testing.T) {
	r := httptest.NewRequest("POST", "/chat/username-available?name=danny", nil)
	w := httptest.NewRecorder()

	usernameHandler(t)(w, r)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", w.Code)
	}
}

func TestUsernameCheckIsNeverCached(t *testing.T) {
	// An answer that was true a minute ago is exactly the answer this endpoint
	// must not serve, and this domain has a documented history of edge caching
	// turning a filtered read into a stale one.
	r := httptest.NewRequest("GET", "/chat/username-available?name=ab", nil)
	w := httptest.NewRecorder()

	usernameHandler(t)(w, r)

	if got := w.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
}

func TestUsernameAvailableSQLExcludesTheAskingUser(t *testing.T) {
	// Re-saving the name you already hold must come back available, or nobody
	// can keep their own screen name.
	for _, want := range []string{"id <> $2", "lower(username)"} {
		if !contains(db.UsernameAvailableSelectForTest, want) {
			t.Errorf("query missing %q:\n%s", want, db.UsernameAvailableSelectForTest)
		}
	}
}

func contains(h, n string) bool {
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return true
		}
	}
	return false
}
