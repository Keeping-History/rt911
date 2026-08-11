package session

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"classicy/streamer/internal/fanout"
	"classicy/streamer/internal/model"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"
)

// The end-to-end claim of the whole exercise: an alert published on one pod
// reaches a client whose WebSocket lives on a different pod. Two hubs with two
// Redis clients over one server stand in for two replicas — the unit tests
// either side of this one cover the bus and the hub separately, but only this
// shows the seam actually joins up.
func TestAlertPushCrossesPods(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis.Run: %v", err)
	}
	defer mr.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	rdbA := goredis.NewClient(&goredis.Options{Addr: mr.Addr()})
	rdbB := goredis.NewClient(&goredis.Options{Addr: mr.Addr()})
	defer rdbA.Close()
	defer rdbB.Close()

	// Pod A: publishes only — it serves the operator's HTTP call and holds no
	// session in this test.
	busA := fanout.New[model.AlertItem](rdbA, "alerts:push", logger)

	// Pod B: runs a hub with the connected client.
	hubB := NewHub(logger, 0)
	busB := fanout.New[model.AlertItem](rdbB, "alerts:push", logger)
	busB.OnMessage(hubB.BroadcastAlert)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go busB.Run(ctx)

	vt := time.Date(2001, 9, 11, 13, 3, 0, 0, time.UTC)
	client := NewSession(hubB, nil, nil, logger)
	client.Init(vt, nil)
	client.Subscribe(ChannelAlerts)
	hubB.mu.Lock()
	hubB.sessions[client.id] = client
	hubB.mu.Unlock()
	drain(t, client)

	scheduled := time.Date(2001, 9, 11, 20, 0, 0, 0, time.UTC)
	alert := testAlert(99, scheduled)

	// Publish until pod B's subscriber has attached — pub/sub keeps no backlog,
	// so a send before SUBSCRIBE lands is simply lost.
	deadline := time.Now().Add(2 * time.Second)
	var got outMsg
	for time.Now().Before(deadline) {
		if err := busA.Publish(ctx, alert); err != nil {
			t.Fatalf("publish from pod A: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
		select {
		case data := <-client.send:
			got = decodeFrame(t, data)
		default:
			continue
		}
		break
	}

	if got.Type != "alerts" {
		t.Fatalf("pod B's client never received pod A's alert (got frame %q)", got.Type)
	}
	if len(got.Alerts) != 1 || got.Alerts[0].ID != 99 {
		t.Fatalf("wrong alert delivered: %+v", got.Alerts)
	}
	// The restamp has to survive the trip, or the client buffers it as future.
	if !got.Alerts[0].StartDate.Equal(vt) {
		t.Fatalf("start_date: got %v, want pod B's session time %v", got.Alerts[0].StartDate, vt)
	}
}
