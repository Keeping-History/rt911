package handler

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
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

func TestAlertPushAdHocRejectsBlankTitle(t *testing.T) {
	w := alertPost(t, newAlertTestHandler(t, "right"), "right", `{"title":"   "}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestAlertPushAdHocRejectsLongTitle(t *testing.T) {
	body := `{"title":"` + strings.Repeat("x", alertMaxTitle+1) + `"}`
	w := alertPost(t, newAlertTestHandler(t, "right"), "right", body)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestAlertPushAdHocRejectsUnknownSeverity(t *testing.T) {
	w := alertPost(t, newAlertTestHandler(t, "right"), "right", `{"title":"Evacuate","severity":"urgent"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

// A body over alertMaxBody must be rejected before decode, not just truncated
// silently — http.MaxBytesReader is what enforces that.
func TestAlertPushAdHocRejectsOversizedBody(t *testing.T) {
	body := `{"title":"x","content":"` + strings.Repeat("y", alertMaxBody) + `"}`
	w := alertPost(t, newAlertTestHandler(t, "right"), "right", body)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestAlertPushAdHocSucceedsAndDefaultsSeverity(t *testing.T) {
	w := alertPost(t, newAlertTestHandler(t, "right"), "right",
		`{"title":"Server maintenance","content":"<p>Back in 10 minutes</p>"}`)
	if w.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202, body: %s", w.Code, w.Body.String())
	}
	var resp alertResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Title != "Server maintenance" {
		t.Fatalf("title = %q, want %q", resp.Title, "Server maintenance")
	}
	// Ad-hoc ids must never collide with a positive Directus alert_items id.
	if resp.ID >= 0 {
		t.Fatalf("id = %d, want strictly negative", resp.ID)
	}
}

func TestAlertPushAdHocAcceptsEachKnownSeverity(t *testing.T) {
	h := newAlertTestHandler(t, "right")
	for severity := range alertSeverities {
		w := alertPost(t, h, "right", `{"title":"Evacuate","severity":"`+severity+`"}`)
		if w.Code != http.StatusAccepted {
			t.Fatalf("severity %q: status = %d, want 202", severity, w.Code)
		}
	}
}

func TestAlertPushAdHocIDsIncrementPerRequest(t *testing.T) {
	h := newAlertTestHandler(t, "right")
	firstResp := decodeAlertResponse(t, alertPost(t, h, "right", `{"title":"First"}`))
	secondResp := decodeAlertResponse(t, alertPost(t, h, "right", `{"title":"Second"}`))
	if firstResp.ID == secondResp.ID {
		t.Fatalf("expected distinct ids per request, both got %d", firstResp.ID)
	}
}

func decodeAlertResponse(t *testing.T, w *httptest.ResponseRecorder) alertResponse {
	t.Helper()
	if w.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202, body: %s", w.Code, w.Body.String())
	}
	var resp alertResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return resp
}

// nextAdHocAlertID is exercised directly (rather than through two full
// handlers) so the salt can be fixed instead of random — a flaky assertion on
// two independently-random pod salts happening to differ is not worth writing.
func TestNextAdHocAlertIDStaysNegativeAndVariesBySaltAndCounter(t *testing.T) {
	var counterA, counterB atomic.Uint32

	first := nextAdHocAlertID(1, &counterA)
	second := nextAdHocAlertID(1, &counterA)
	if first == second {
		t.Fatalf("expected the counter to advance the id, both got %d", first)
	}
	if first >= 0 || second >= 0 {
		t.Fatalf("expected strictly negative ids, got %d and %d", first, second)
	}

	fromOtherPod := nextAdHocAlertID(2, &counterB)
	if fromOtherPod == first {
		t.Fatalf("expected a different salt to produce a different id, both got %d", first)
	}
}
