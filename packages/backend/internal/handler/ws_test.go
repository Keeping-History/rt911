package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"classicy/streamer/internal/cache"
	"classicy/streamer/internal/model"
	"classicy/streamer/internal/session"

	"github.com/alicebob/miniredis/v2"
	"github.com/gorilla/websocket"
	goredis "github.com/redis/go-redis/v9"
	"github.com/vmihailenco/msgpack/v5"
)

// wsFrame is a subset of session.outMsg used only for decoding test responses.
type wsFrame struct {
	Type    string                 `json:"type"`
	Channel string                 `json:"channel,omitempty"`
	Msg     string                 `json:"message,omitempty"`
	Time    string                 `json:"time,omitempty"`
	ID      int                    `json:"id,omitempty"`
	Done    bool                   `json:"done,omitempty"`
	Flights []model.FlightPosition `json:"flights,omitempty"`
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
	for _, ch := range []string{"pager", "mp3", "news", "usenet", "flights", "weather"} {
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

// TestWSHandlerAllChannelsSubscribeIndependently proves every known channel
// can subscribe/unsubscribe on its own. It uses a nil pool and rdb (like the
// other handler tests above) and never sends init/heartbeat/seek, so the
// session's virtual time stays zero — sendChannelSnapshot is gated behind
// sess.VirtualTime()'s ok flag and is therefore never invoked here, meaning
// even the Postgres- and Redis-backed channels (weather, flights) are safe to
// exercise without a real pool/rdb. Snapshot DB paths are covered separately
// (or, per repo convention, left untested where they require Postgres).
func TestWSHandlerAllChannelsSubscribeIndependently(t *testing.T) {
	conn := dialWS(t, newTestServer(t, nil))
	channels := []string{"pager", "mp3", "news", "usenet", "flights", "weather"}
	for _, ch := range channels {
		sendJSON(t, conn, map[string]string{"type": "subscribe", "channel": ch})
		f := readFrame(t, conn)
		if f.Type != "subscribe_ack" || f.Channel != ch {
			t.Fatalf("channel %q: expected subscribe_ack, got %+v", ch, f)
		}
	}
	for _, ch := range channels {
		sendJSON(t, conn, map[string]string{"type": "unsubscribe", "channel": ch})
		f := readFrame(t, conn)
		if f.Type != "unsubscribe_ack" || f.Channel != ch {
			t.Fatalf("channel %q: expected unsubscribe_ack, got %+v", ch, f)
		}
	}
}

func TestWSHandlerFlightsHistoryChunksAndDone(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := goredis.NewClient(&goredis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })

	// Seed 30 one-position minute buckets ending at the virtual clock instant.
	now := time.Date(2001, 9, 11, 13, 0, 0, 0, time.UTC)
	for i := 0; i < 30; i++ {
		m := now.Add(-time.Duration(i) * time.Minute)
		items := []model.FlightPosition{{
			ID: i + 1, Flight: "AA11", StartDate: m, Lat: 42.0, Lon: -71.0, AltFt: 30000,
		}}
		if err := cache.PutFlightBucket(context.Background(), rdb, m, items); err != nil {
			t.Fatalf("seed bucket: %v", err)
		}
	}

	conn := dialWS(t, newTestServer(t, rdb))

	sendJSON(t, conn, map[string]string{"type": "subscribe", "channel": "flights"})
	if f := readFrame(t, conn); f.Type != "subscribe_ack" {
		t.Fatalf("expected subscribe_ack, got %+v", f)
	}
	// A heartbeat with a large drift initialises the virtual clock without
	// needing a Postgres-backed init.
	sendJSON(t, conn, map[string]string{"type": "heartbeat", "time": now.Format(time.RFC3339)})
	if f := readFrame(t, conn); f.Type != "heartbeat_ack" {
		t.Fatalf("expected heartbeat_ack, got %+v", f)
	}

	sendJSON(t, conn, map[string]any{"type": "flights_history", "minutes": 30, "id": 3})

	var chunks, total int
	for {
		f := readFrame(t, conn)
		if f.Type != "flights_history" {
			t.Fatalf("expected flights_history frame, got %+v", f)
		}
		if f.ID != 3 {
			t.Fatalf("expected echoed id 3, got %d", f.ID)
		}
		if f.Done {
			break
		}
		chunks++
		total += len(f.Flights)
	}
	// 30 minutes at 10-minute chunks (+ the current-instant second) → 3-4 chunk
	// frames depending on boundary alignment; every seeded position arrives once.
	if chunks < 3 || chunks > 4 {
		t.Fatalf("expected 3-4 chunk frames, got %d", chunks)
	}
	if total != 30 {
		t.Fatalf("expected all 30 seeded positions, got %d", total)
	}
}

// A short lookback (the frontend's heading-seed request is 3 minutes) is served
// in one chunk: any window inside the 1-90 minute bound is valid, not just the
// loop-mode 30/90 presets.
func TestWSHandlerFlightsHistoryShortSeedLookback(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := goredis.NewClient(&goredis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })

	now := time.Date(2001, 9, 11, 13, 0, 0, 0, time.UTC)
	for i := 0; i < 3; i++ {
		m := now.Add(-time.Duration(i) * time.Minute)
		items := []model.FlightPosition{{
			ID: i + 1, Flight: "AA11", StartDate: m, Lat: 42.0, Lon: -71.0, AltFt: 30000,
		}}
		if err := cache.PutFlightBucket(context.Background(), rdb, m, items); err != nil {
			t.Fatalf("seed bucket: %v", err)
		}
	}

	conn := dialWS(t, newTestServer(t, rdb))
	sendJSON(t, conn, map[string]string{"type": "subscribe", "channel": "flights"})
	if f := readFrame(t, conn); f.Type != "subscribe_ack" {
		t.Fatalf("expected subscribe_ack, got %+v", f)
	}
	sendJSON(t, conn, map[string]string{"type": "heartbeat", "time": now.Format(time.RFC3339)})
	if f := readFrame(t, conn); f.Type != "heartbeat_ack" {
		t.Fatalf("expected heartbeat_ack, got %+v", f)
	}

	sendJSON(t, conn, map[string]any{"type": "flights_history", "minutes": 3, "id": 7})

	var total int
	for {
		f := readFrame(t, conn)
		if f.Type != "flights_history" {
			t.Fatalf("expected flights_history frame, got %+v", f)
		}
		if f.ID != 7 {
			t.Fatalf("expected echoed id 7, got %d", f.ID)
		}
		if f.Done {
			break
		}
		total += len(f.Flights)
	}
	if total != 3 {
		t.Fatalf("expected all 3 seeded positions, got %d", total)
	}
}

func TestWSHandlerFlightsHistoryInvalidMinutes(t *testing.T) {
	conn := dialWS(t, newTestServer(t, nil))
	for _, minutes := range []int{0, -5, 91} {
		sendJSON(t, conn, map[string]any{"type": "flights_history", "minutes": minutes, "id": 1})
		if f := readFrame(t, conn); f.Type != "error" {
			t.Fatalf("expected error frame for minutes=%d, got %+v", minutes, f)
		}
	}
}

func TestWSHandlerFlightsHistoryIgnoredWhenUnsubscribed(t *testing.T) {
	conn := dialWS(t, newTestServer(t, nil))
	sendJSON(t, conn, map[string]any{"type": "flights_history", "minutes": 30, "id": 1})
	// A follow-up round-trip proves the request produced no frames at all.
	sendJSON(t, conn, map[string]string{"type": "pause"})
	if f := readFrame(t, conn); f.Type != "pause_ack" {
		t.Fatalf("expected pause_ack (history silently ignored), got %+v", f)
	}
}

// --- weather_forecast gating ---
//
// Both paths below return before touching the pool (invalid zone shape and
// missing subscription), so a nil pool is safe — same technique as
// TestWSHandlerFlightsHistoryIgnoredWhenUnsubscribed. The DB-backed success
// path (valid zone + subscribed) needs Postgres and stays untested here by
// repo convention (see sendUsenetSnapshot's siblings, none of which are
// exercised end-to-end in this file either).

func TestWSHandlerWeatherForecastIgnoredWhenUnsubscribed(t *testing.T) {
	conn := dialWS(t, newTestServer(t, nil))
	sendJSON(t, conn, map[string]any{"type": "weather_forecast", "zone": "NYZ072", "id": 1})
	// A follow-up round-trip proves the request produced no frames at all.
	sendJSON(t, conn, map[string]string{"type": "pause"})
	if f := readFrame(t, conn); f.Type != "pause_ack" {
		t.Fatalf("expected pause_ack (forecast request silently ignored), got %+v", f)
	}
}

func TestWSHandlerWeatherForecastIgnoredWhenZoneInvalid(t *testing.T) {
	conn := dialWS(t, newTestServer(t, nil))
	sendJSON(t, conn, map[string]string{"type": "subscribe", "channel": "weather"})
	if f := readFrame(t, conn); f.Type != "subscribe_ack" {
		t.Fatalf("expected subscribe_ack, got %+v", f)
	}

	for _, zone := range []string{"", "nyz072", "NYZ72", "NYZ0721", "NY072", "NYZ07A", "NYZ072;DROP"} {
		sendJSON(t, conn, map[string]any{"type": "weather_forecast", "zone": zone, "id": 2})
		// A follow-up round-trip proves the request produced no frames at all —
		// it never reached the pool (which is nil here and would panic).
		sendJSON(t, conn, map[string]string{"type": "pause"})
		if f := readFrame(t, conn); f.Type != "pause_ack" {
			t.Fatalf("zone %q: expected pause_ack (forecast request silently ignored), got %+v", zone, f)
		}
	}
}
