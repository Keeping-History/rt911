package handler

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"classicy/streamer/internal/fanout"
	"classicy/streamer/internal/model"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"
)

// A nil pool is deliberate: every case below must be rejected before the
// handler queries alert_items, and a nil pool panicking is what proves it.
func newAlertTestHandler(t *testing.T, key string) http.HandlerFunc {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis.Run: %v", err)
	}
	t.Cleanup(mr.Close)
	rdb := goredis.NewClient(&goredis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	bus := fanout.New[model.AlertItem](rdb, "alerts:push", logger)
	return NewAlertHandler(nil, bus, key, logger)
}

func alertPost(t *testing.T, h http.HandlerFunc, key, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest("POST", "/alert", strings.NewReader(body))
	if key != "" {
		r.Header.Set("X-Alert-Key", key)
	}
	w := httptest.NewRecorder()
	h(w, r)
	return w
}

// An unset key disables the endpoint outright rather than leaving it open —
// the same posture as /clock, so a deployment that never configured it cannot
// be pushed to by anyone who finds the path.
func TestAlertPushDisabledWithoutKey(t *testing.T) {
	w := alertPost(t, newAlertTestHandler(t, ""), "anything", `{"id":1}`)
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
}

func TestAlertPushRejectsAWrongKey(t *testing.T) {
	w := alertPost(t, newAlertTestHandler(t, "right"), "wrong", `{"id":1}`)
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
}

func TestAlertPushRejectsAMissingKey(t *testing.T) {
	w := alertPost(t, newAlertTestHandler(t, "right"), "", `{"id":1}`)
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
}

func TestAlertPushRejectsNonPost(t *testing.T) {
	r := httptest.NewRequest("GET", "/alert", nil)
	r.Header.Set("X-Alert-Key", "right")
	w := httptest.NewRecorder()
	newAlertTestHandler(t, "right")(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", w.Code)
	}
}

func TestAlertPushRejectsBadJSON(t *testing.T) {
	w := alertPost(t, newAlertTestHandler(t, "right"), "right", `{not json`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

// Guards the nil-pool boundary: a missing or nonsensical id must fail the shape
// check rather than reach the query.
func TestAlertPushRequiresAPositiveID(t *testing.T) {
	h := newAlertTestHandler(t, "right")
	for _, body := range []string{`{}`, `{"id":0}`, `{"id":-3}`} {
		w := alertPost(t, h, "right", body)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("body %s: status = %d, want 400", body, w.Code)
		}
	}
}
