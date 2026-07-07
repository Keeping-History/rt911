package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"classicy/streamer/internal/session"

	"github.com/alicebob/miniredis/v2"
	"github.com/gorilla/websocket"
	goredis "github.com/redis/go-redis/v9"
	"github.com/vmihailenco/msgpack/v5"
)

// wsFrame is a subset of session.outMsg used only for decoding test responses.
type wsFrame struct {
	Type    string `json:"type"`
	Channel string `json:"channel,omitempty"`
	Msg     string `json:"message,omitempty"`
	Time    string `json:"time,omitempty"`
}

func newTestServer(t *testing.T, rdb *goredis.Client) *url.URL {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := session.NewHub(logger, 0)
	go hub.Run()
	srv := httptest.NewServer(NewWSHandler(hub, rdb, nil, logger))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	u.Scheme = "ws"
	return u
}

// TestWSHandlerShedsWhenAtCapacity proves the client-facing load-shedding
// contract: once the per-pod cap is reached the handler rejects new connections
// with a clean HTTP 503 during the handshake (never upgrading them), rather than
// accepting them toward a crash that would drop every already-connected client.
func TestWSHandlerShedsWhenAtCapacity(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := goredis.NewClient(&goredis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := session.NewHub(logger, 1) // capacity of exactly one connection
	go hub.Run()
	srv := httptest.NewServer(NewWSHandler(hub, rdb, nil, logger))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	u.Scheme = "ws"

	// First connection is admitted and holds the only slot for the test's duration.
	first, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		t.Fatalf("first dial should succeed: %v", err)
	}
	t.Cleanup(func() { first.Close() })

	// Second connection must be shed with HTTP 503, not upgraded.
	_, resp, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if !errors.Is(err, websocket.ErrBadHandshake) {
		t.Fatalf("second dial: want ErrBadHandshake, got %v", err)
	}
	if resp == nil || resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("second dial: want HTTP 503, got %v", resp)
	}
}

func dialWS(t *testing.T, u *url.URL) *websocket.Conn {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func sendJSON(t *testing.T, conn *websocket.Conn, v any) {
	t.Helper()
	data, _ := json.Marshal(v)
	conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func readFrame(t *testing.T, conn *websocket.Conn) wsFrame {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	dec := msgpack.NewDecoder(bytes.NewReader(data))
	dec.SetCustomStructTag("json")
	var f wsFrame
	if err := dec.Decode(&f); err != nil {
		t.Fatalf("decode msgpack: %v", err)
	}
	return f
}

// --- parseTime ---

func TestParseTimeFormats(t *testing.T) {
	want := time.Date(2001, 9, 11, 8, 46, 0, 0, time.UTC)
	cases := []string{
		"2001-09-11T08:46:00Z",
		"2001-09-11T08:46:00",
		"2001-09-11 08:46:00",
		"2001-09-11 08:46:00.000000",
	}
	for _, s := range cases {
		got, err := parseTime(s)
		if err != nil {
			t.Errorf("parseTime(%q): unexpected error %v", s, err)
			continue
		}
		if !got.Equal(want) {
			t.Errorf("parseTime(%q) = %v, want %v", s, got, want)
		}
	}
}

func TestParseTimeInvalid(t *testing.T) {
	for _, s := range []string{"", "not-a-time", "2001/09/11", "11-09-2001"} {
		if _, err := parseTime(s); err == nil {
			t.Errorf("parseTime(%q): expected error, got nil", s)
		}
	}
}

// --- knownChannel ---

func TestKnownChannels(t *testing.T) {
	for _, ch := range []string{"pager", "mp3", "news", "usenet", "flights"} {
		if !knownChannel(ch) {
			t.Errorf("knownChannel(%q) = false, want true", ch)
		}
	}
	for _, ch := range []string{"", "video", "html", "PAGER", "Pager"} {
		if knownChannel(ch) {
			t.Errorf("knownChannel(%q) = true, want false", ch)
		}
	}
}

// --- WebSocket handler end-to-end ---

func TestWSHandlerMalformedJSON(t *testing.T) {
	conn := dialWS(t, newTestServer(t, nil))

	conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	conn.WriteMessage(websocket.TextMessage, []byte("{invalid json"))

	if f := readFrame(t, conn); f.Type != "error" {
		t.Fatalf("expected error frame for malformed JSON, got %q", f.Type)
	}
}

func TestWSHandlerUnknownType(t *testing.T) {
	conn := dialWS(t, newTestServer(t, nil))
	sendJSON(t, conn, map[string]string{"type": "teleport"})
	if f := readFrame(t, conn); f.Type != "error" {
		t.Fatalf("expected error frame for unknown type, got %q", f.Type)
	}
}

func TestWSHandlerPauseResume(t *testing.T) {
	conn := dialWS(t, newTestServer(t, nil))

	sendJSON(t, conn, map[string]string{"type": "pause"})
	if f := readFrame(t, conn); f.Type != "pause_ack" {
		t.Fatalf("expected pause_ack, got %q", f.Type)
	}

	sendJSON(t, conn, map[string]string{"type": "resume"})
	if f := readFrame(t, conn); f.Type != "resume_ack" {
		t.Fatalf("expected resume_ack, got %q", f.Type)
	}
}

func TestWSHandlerSubscribeValidChannel(t *testing.T) {
	conn := dialWS(t, newTestServer(t, nil))
	sendJSON(t, conn, map[string]string{"type": "subscribe", "channel": "pager"})
	f := readFrame(t, conn)
	if f.Type != "subscribe_ack" || f.Channel != "pager" {
		t.Fatalf("expected subscribe_ack for pager, got %+v", f)
	}
}

func TestWSHandlerUnsubscribe(t *testing.T) {
	conn := dialWS(t, newTestServer(t, nil))
	sendJSON(t, conn, map[string]string{"type": "subscribe", "channel": "mp3"})
	readFrame(t, conn) // drain subscribe_ack

	sendJSON(t, conn, map[string]string{"type": "unsubscribe", "channel": "mp3"})
	f := readFrame(t, conn)
	if f.Type != "unsubscribe_ack" || f.Channel != "mp3" {
		t.Fatalf("expected unsubscribe_ack for mp3, got %+v", f)
	}
}

func TestWSHandlerSubscribeInvalidChannel(t *testing.T) {
	conn := dialWS(t, newTestServer(t, nil))
	sendJSON(t, conn, map[string]string{"type": "subscribe", "channel": "not_a_channel"})
	if f := readFrame(t, conn); f.Type != "error" {
		t.Fatalf("expected error for unknown channel, got %q", f.Type)
	}
}

func TestWSHandlerFilter(t *testing.T) {
	conn := dialWS(t, newTestServer(t, nil))
	sendJSON(t, conn, map[string]any{"type": "filter", "formats": []string{"m3u8"}})
	if f := readFrame(t, conn); f.Type != "filter_ack" {
		t.Fatalf("expected filter_ack, got %q", f.Type)
	}
}

// TestWSHandlerHeartbeat uses miniredis because a heartbeat advances
// virtualTime, which causes the next hub tick to issue a Redis range query
// in RunTimePump. Passing nil here would panic on that path.
func TestWSHandlerHeartbeat(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)
	rdb := goredis.NewClient(&goredis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })

	conn := dialWS(t, newTestServer(t, rdb))
	sendJSON(t, conn, map[string]string{"type": "heartbeat", "time": "2001-09-11T08:46:00Z"})
	f := readFrame(t, conn)
	if f.Type != "heartbeat_ack" {
		t.Fatalf("expected heartbeat_ack, got %q", f.Type)
	}
	if f.Time == "" {
		t.Fatal("heartbeat_ack must carry the current virtual time")
	}
}

func TestWSHandlerHeartbeatInvalidTime(t *testing.T) {
	conn := dialWS(t, newTestServer(t, nil))
	sendJSON(t, conn, map[string]string{"type": "heartbeat", "time": "not-a-time"})
	if f := readFrame(t, conn); f.Type != "error" {
		t.Fatalf("expected error for invalid heartbeat time, got %q", f.Type)
	}
}

func TestWSHandlerAllChannelsSubscribeIndependently(t *testing.T) {
	conn := dialWS(t, newTestServer(t, nil))
	for _, ch := range []string{"pager", "mp3", "news", "usenet"} {
		sendJSON(t, conn, map[string]string{"type": "subscribe", "channel": ch})
		f := readFrame(t, conn)
		if f.Type != "subscribe_ack" || f.Channel != ch {
			t.Fatalf("channel %q: expected subscribe_ack, got %+v", ch, f)
		}
	}
	for _, ch := range []string{"pager", "mp3", "news", "usenet"} {
		sendJSON(t, conn, map[string]string{"type": "unsubscribe", "channel": ch})
		f := readFrame(t, conn)
		if f.Type != "unsubscribe_ack" || f.Channel != ch {
			t.Fatalf("channel %q: expected unsubscribe_ack, got %+v", ch, f)
		}
	}
}
