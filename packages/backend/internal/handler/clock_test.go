package handler

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"

	"classicy/streamer/internal/clock"
)

func newClockTestHandler(t *testing.T, key string) (http.HandlerFunc, *clock.MasterClock) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis.Run: %v", err)
	}
	t.Cleanup(mr.Close)
	rdb := goredis.NewClient(&goredis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	mc := clock.New(rdb, logger)
	return NewClockHandler(mc, key, logger), mc
}

func doClock(h http.HandlerFunc, method, key, body string) *httptest.ResponseRecorder {
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, "/clock", rdr)
	if key != "" {
		req.Header.Set("X-Clock-Key", key)
	}
	w := httptest.NewRecorder()
	h(w, req)
	return w
}

func TestClockDisabledWithoutKeyConfig(t *testing.T) {
	h, _ := newClockTestHandler(t, "")
	if w := doClock(h, http.MethodGet, "anything", ""); w.Code != http.StatusNotFound {
		t.Fatalf("expected 404 when feature is off, got %d", w.Code)
	}
}

func TestClockRejectsWrongKey(t *testing.T) {
	h, _ := newClockTestHandler(t, "sekrit")
	if w := doClock(h, http.MethodGet, "wrong", ""); w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", w.Code)
	}
	if w := doClock(h, http.MethodGet, "", ""); w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 with no key header, got %d", w.Code)
	}
}

func TestClockActivateStatusRelease(t *testing.T) {
	h, mc := newClockTestHandler(t, "sekrit")

	w := doClock(h, http.MethodPost, "sekrit", `{"active":true,"time":"2001-09-11T13:03:00Z"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("activate: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"active":true`) {
		t.Fatalf("activate response missing active:true: %s", w.Body.String())
	}
	if now, ok := mc.Now(); !ok || now.Before(time.Date(2001, 9, 11, 13, 3, 0, 0, time.UTC)) {
		t.Fatalf("master clock not set: %v %v", now, ok)
	}

	if w := doClock(h, http.MethodGet, "sekrit", ""); !strings.Contains(w.Body.String(), `"active":true`) {
		t.Fatalf("status should be active: %s", w.Body.String())
	}

	w = doClock(h, http.MethodPost, "sekrit", `{"active":false}`)
	if w.Code != http.StatusOK {
		t.Fatalf("release: expected 200, got %d", w.Code)
	}
	if _, ok := mc.Now(); ok {
		t.Fatal("master clock should be inactive after release")
	}
}

func TestClockBadRequests(t *testing.T) {
	h, _ := newClockTestHandler(t, "sekrit")
	if w := doClock(h, http.MethodPost, "sekrit", `{"active":true,"time":"yesterday"}`); w.Code != http.StatusBadRequest {
		t.Fatalf("bad time: expected 400, got %d", w.Code)
	}
	if w := doClock(h, http.MethodPost, "sekrit", `not json`); w.Code != http.StatusBadRequest {
		t.Fatalf("bad json: expected 400, got %d", w.Code)
	}
	if w := doClock(h, http.MethodPut, "sekrit", ""); w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("PUT: expected 405, got %d", w.Code)
	}
	if w := doClock(h, http.MethodPost, "sekrit", `{"active":true}`); w.Code != http.StatusBadRequest {
		t.Fatalf("activate without time: expected 400, got %d", w.Code)
	}
}
