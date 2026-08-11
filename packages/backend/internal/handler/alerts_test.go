package handler

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"classicy/streamer/internal/session"
)

func newAlertsTestHandler(t *testing.T, key string) (http.HandlerFunc, *session.Hub) {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := session.NewHub(logger, 0)
	go hub.Run()
	// pool is nil: every test here exercises the ad-hoc path, which never
	// touches Postgres. The by-id path needs a live database.
	return NewAlertsHandler(hub, nil, key, logger), hub
}

func doAlert(h http.HandlerFunc, method, key, body string) *httptest.ResponseRecorder {
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, "/alerts", rdr)
	if key != "" {
		req.Header.Set("X-Alert-Key", key)
	}
	w := httptest.NewRecorder()
	h(w, req)
	return w
}

func TestAlertsDisabledWithoutKeyConfig(t *testing.T) {
	h, _ := newAlertsTestHandler(t, "")
	if w := doAlert(h, http.MethodPost, "anything", `{"title":"x"}`); w.Code != http.StatusNotFound {
		t.Fatalf("expected 404 when the feature is off, got %d", w.Code)
	}
}

func TestAlertsRejectsWrongKey(t *testing.T) {
	h, _ := newAlertsTestHandler(t, "s3kret")
	for _, key := range []string{"", "wrong", "s3kre"} {
		if w := doAlert(h, http.MethodPost, key, `{"title":"x"}`); w.Code != http.StatusForbidden {
			t.Fatalf("key %q: expected 403, got %d", key, w.Code)
		}
	}
}

func TestAlertsRejectsNonPost(t *testing.T) {
	h, _ := newAlertsTestHandler(t, "s3kret")
	if w := doAlert(h, http.MethodGet, "s3kret", ""); w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}
}

func TestAlertsRejectsBadRequests(t *testing.T) {
	h, _ := newAlertsTestHandler(t, "s3kret")
	cases := map[string]string{
		"malformed json":     `{`,
		"no title":           `{"content":"<p>body</p>"}`,
		"whitespace title":   `{"title":"   "}`,
		"unknown severity":   `{"title":"x","severity":"panic"}`,
		"title far too long": `{"title":"` + strings.Repeat("x", alertMaxTitle+1) + `"}`,
	}
	for name, body := range cases {
		if w := doAlert(h, http.MethodPost, "s3kret", body); w.Code != http.StatusBadRequest {
			t.Fatalf("%s: expected 400, got %d (%s)", name, w.Code, w.Body.String())
		}
	}
}

func TestAlertsBroadcastsToSubscribedSessions(t *testing.T) {
	h, hub := newAlertsTestHandler(t, "s3kret")
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	at := time.Date(2001, 9, 11, 13, 3, 0, 0, time.UTC)
	subscribed := session.NewSession(hub, nil, nil, logger)
	subscribed.Init(at, nil)
	subscribed.Subscribe(session.ChannelAlerts)
	quiet := session.NewSession(hub, nil, nil, logger)
	quiet.Init(at, nil)

	hub.Register(subscribed)
	hub.Register(quiet)
	waitHubSessions(t, hub, 2)

	w := doAlert(h, http.MethodPost, "s3kret",
		`{"title":"Evacuate","content":"<p>Leave now.</p>","severity":"stop","image":"https://files.911realtime.org/a.jpg","image_caption":"cap"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}

	var resp alertResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Delivered != 1 {
		t.Fatalf("expected delivered=1 (only the subscriber), got %d", resp.Delivered)
	}
	if resp.Alert.Title != "Evacuate" || resp.Alert.Content != "<p>Leave now.</p>" {
		t.Fatalf("unexpected alert echoed back: %+v", resp.Alert)
	}
	if resp.Alert.Image != "https://files.911realtime.org/a.jpg" || resp.Alert.ImageCaption != "cap" {
		t.Fatalf("expected image fields to survive, got %+v", resp.Alert)
	}
	if resp.Alert.Severity == nil || *resp.Alert.Severity != "stop" {
		t.Fatalf("expected severity stop, got %v", resp.Alert.Severity)
	}
	if resp.Alert.ID >= 0 {
		t.Fatalf("ad-hoc alerts must take negative ids so they cannot collide with alert_items, got %d", resp.Alert.ID)
	}
}

func TestAlertsDefaultsSeverityAndIssuesDistinctIDs(t *testing.T) {
	h, _ := newAlertsTestHandler(t, "s3kret")

	seen := map[int]struct{}{}
	for i := 0; i < 3; i++ {
		w := doAlert(h, http.MethodPost, "s3kret", `{"title":"Ping"}`)
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
		}
		var resp alertResponse
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if resp.Alert.Severity == nil || *resp.Alert.Severity != "note" {
			t.Fatalf("expected severity to default to note, got %v", resp.Alert.Severity)
		}
		if _, dup := seen[resp.Alert.ID]; dup {
			t.Fatalf("id %d reused; the client dedupes by id, so ad-hoc ids must be distinct", resp.Alert.ID)
		}
		seen[resp.Alert.ID] = struct{}{}
	}
}

// waitHubSessions polls until the hub has registered want sessions. Registration
// is asynchronous (Hub.Run consumes a channel), so a broadcast issued too early
// would race it.
func waitHubSessions(t *testing.T, hub *session.Hub, want int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if hub.Count() == want {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %d registered sessions, got %d", want, hub.Count())
}
