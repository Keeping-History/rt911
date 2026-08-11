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

func newRoomTestHandler(t *testing.T, key string) http.HandlerFunc {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis.Run: %v", err)
	}
	t.Cleanup(mr.Close)
	rdb := goredis.NewClient(&goredis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	bus := fanout.New[model.RoomCommand](rdb, "room:command", logger)
	return NewRoomHandler(bus, key, logger)
}

func roomPost(t *testing.T, h http.HandlerFunc, key, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest("POST", "/room", strings.NewReader(body))
	if key != "" {
		r.Header.Set("X-Room-Key", key)
	}
	w := httptest.NewRecorder()
	h(w, r)
	return w
}

func TestRoomControlDisabledWithoutKey(t *testing.T) {
	w := roomPost(t, newRoomTestHandler(t, ""), "anything", `{"room":"42","action":"message","message":"hi"}`)
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
}

func TestRoomControlRejectsAWrongKey(t *testing.T) {
	w := roomPost(t, newRoomTestHandler(t, "right"), "wrong", `{"room":"42","action":"message","message":"hi"}`)
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
}

func TestRoomControlRequiresARoom(t *testing.T) {
	w := roomPost(t, newRoomTestHandler(t, "k"), "k", `{"action":"message","message":"hi"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

// An unknown action must fail at this boundary. Forwarded, it would reach
// clients that silently ignore it, so a typo would look like a working command
// that simply did nothing.
func TestRoomControlRejectsAnUnknownAction(t *testing.T) {
	h := newRoomTestHandler(t, "k")
	for _, body := range []string{
		`{"room":"42","action":"explode"}`,
		`{"room":"42","action":""}`,
		`{"room":"42"}`,
	} {
		w := roomPost(t, h, "k", body)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("body %s: status = %d, want 400", body, w.Code)
		}
	}
}

func TestRoomControlValidatesPerActionPayload(t *testing.T) {
	h := newRoomTestHandler(t, "k")
	cases := map[string]string{
		"jump without a time":   `{"room":"42","action":"jump"}`,
		"jump with a bad time":  `{"room":"42","action":"jump","time":"not-a-time"}`,
		"focus without an app":  `{"room":"42","action":"focus"}`,
		"message without a msg": `{"room":"42","action":"message"}`,
	}
	for name, body := range cases {
		if w := roomPost(t, h, "k", body); w.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400", name, w.Code)
		}
	}
}

func TestRoomControlAcceptsValidCommands(t *testing.T) {
	h := newRoomTestHandler(t, "k")
	for name, body := range map[string]string{
		"jump":    `{"room":"42","action":"jump","time":"2001-09-11T13:03:00Z"}`,
		"focus":   `{"room":"42","action":"focus","app":"TV.app"}`,
		"message": `{"room":"42","action":"message","message":"Look at channel 4"}`,
	} {
		if w := roomPost(t, h, "k", body); w.Code != http.StatusAccepted {
			t.Fatalf("%s: status = %d, want 202 (body %q)", name, w.Code, w.Body.String())
		}
	}
}
