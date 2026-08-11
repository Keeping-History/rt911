package fanout

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"
)

type payload struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

func newTestBus(t *testing.T) (*Bus[payload], *goredis.Client, func()) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis.Run: %v", err)
	}
	rdb := goredis.NewClient(&goredis.Options{Addr: mr.Addr()})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return New[payload](rdb, "test:channel", logger), rdb, func() {
		rdb.Close()
		mr.Close()
	}
}

// waitFor polls until cond holds, so the tests never depend on a fixed sleep
// being long enough for the subscriber goroutine to attach.
func waitFor(t *testing.T, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return false
}

func TestPublishReachesSubscriber(t *testing.T) {
	bus, _, cleanup := newTestBus(t)
	defer cleanup()

	got := make(chan payload, 4)
	bus.OnMessage(func(p payload) { got <- p })

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go bus.Run(ctx)

	// Publishing before the subscriber has attached would be dropped — pub/sub
	// has no backlog — so wait for the subscription to register first.
	if !waitFor(t, func() bool { return bus.Publish(ctx, payload{Name: "ping", Count: 1}) == nil && len(got) > 0 }) {
		t.Fatal("no message received within the deadline")
	}

	p := <-got
	if p.Name != "ping" || p.Count != 1 {
		t.Fatalf("payload round-trip: got %+v, want {ping 1}", p)
	}
}

// Two buses on the same Redis channel stand in for two pods: what one publishes
// must reach the other. This is the whole point of the package.
func TestMessageCrossesPods(t *testing.T) {
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

	podA := New[payload](rdbA, "test:crosspod", logger)
	podB := New[payload](rdbB, "test:crosspod", logger)

	seen := make(chan payload, 4)
	podB.OnMessage(func(p payload) { seen <- p })

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go podB.Run(ctx)

	if !waitFor(t, func() bool { return podA.Publish(ctx, payload{Name: "from-a"}) == nil && len(seen) > 0 }) {
		t.Fatal("pod B never received pod A's message")
	}
	if p := <-seen; p.Name != "from-a" {
		t.Fatalf("got %+v, want name from-a", p)
	}
}

func TestRunStopsOnContextCancel(t *testing.T) {
	bus, _, cleanup := newTestBus(t)
	defer cleanup()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { bus.Run(ctx); close(done) }()

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after context cancel")
	}
}

// A malformed payload must not kill the subscriber loop — one bad publisher
// would otherwise take the pod's fan-out down until restart.
func TestBadPayloadIsSkipped(t *testing.T) {
	bus, rdb, cleanup := newTestBus(t)
	defer cleanup()

	got := make(chan payload, 4)
	bus.OnMessage(func(p payload) { got <- p })

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go bus.Run(ctx)

	if !waitFor(t, func() bool {
		rdb.Publish(ctx, "test:channel", "{not json")
		return bus.Publish(ctx, payload{Name: "after-bad"}) == nil && len(got) > 0
	}) {
		t.Fatal("loop did not survive a malformed payload")
	}
	if p := <-got; p.Name != "after-bad" {
		t.Fatalf("got %+v, want name after-bad", p)
	}
}

// A bus with no handler must not panic — Run is often started before the owner
// has wired its callback in tests and at boot.
func TestNilHandlerIsSafe(t *testing.T) {
	bus, _, cleanup := newTestBus(t)
	defer cleanup()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go bus.Run(ctx)

	for i := 0; i < 5; i++ {
		if err := bus.Publish(ctx, payload{Name: "no-handler"}); err != nil {
			t.Fatalf("Publish: %v", err)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
