package clock

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"
)

func newTestClock(t *testing.T) (*MasterClock, *goredis.Client, func()) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis.Run: %v", err)
	}
	rdb := goredis.NewClient(&goredis.Options{Addr: mr.Addr()})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return New(rdb, logger), rdb, func() {
		rdb.Close()
		mr.Close()
	}
}

func TestStateNowAt(t *testing.T) {
	anchor := time.Date(2001, 9, 11, 12, 46, 0, 0, time.UTC)
	wall := time.Date(2026, 7, 16, 20, 0, 0, 0, time.UTC)
	st := State{Active: true, VirtualAt: anchor, WallAt: wall}

	got := st.NowAt(wall.Add(90 * time.Second))
	want := anchor.Add(90 * time.Second)
	if !got.Equal(want) {
		t.Fatalf("NowAt: got %v, want %v", got, want)
	}
}

func TestSetNowRelease(t *testing.T) {
	mc, _, done := newTestClock(t)
	defer done()
	ctx := context.Background()

	if _, ok := mc.Now(); ok {
		t.Fatal("new MasterClock must be inactive")
	}

	target := time.Date(2001, 9, 11, 13, 3, 0, 0, time.UTC)
	if err := mc.Set(ctx, target); err != nil {
		t.Fatalf("Set: %v", err)
	}
	now, ok := mc.Now()
	if !ok {
		t.Fatal("expected active after Set")
	}
	if d := now.Sub(target); d < 0 || d > time.Second {
		t.Fatalf("master time %v not within 1s after target %v", now, target)
	}

	if err := mc.Release(ctx); err != nil {
		t.Fatalf("Release: %v", err)
	}
	if _, ok := mc.Now(); ok {
		t.Fatal("expected inactive after Release")
	}
}

func TestLoadRestoresPersistedState(t *testing.T) {
	mc, rdb, done := newTestClock(t)
	defer done()
	ctx := context.Background()

	target := time.Date(2001, 9, 11, 14, 0, 0, 0, time.UTC)
	if err := mc.Set(ctx, target); err != nil {
		t.Fatalf("Set: %v", err)
	}

	// A "restarted pod": fresh MasterClock over the same Redis.
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	mc2 := New(rdb, logger)
	if err := mc2.Load(ctx); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if _, ok := mc2.Now(); !ok {
		t.Fatal("expected loaded clock to be active")
	}
}

func TestOnChangeFiresOnceForLocalApply(t *testing.T) {
	mc, _, done := newTestClock(t)
	defer done()
	ctx := context.Background()

	fired := make(chan State, 4)
	mc.OnChange(func(st State) { fired <- st })

	if err := mc.Set(ctx, time.Date(2001, 9, 11, 13, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("Set: %v", err)
	}
	st := <-fired
	if !st.Active {
		t.Fatal("expected active state in change callback")
	}
	select {
	case extra := <-fired:
		t.Fatalf("unexpected second onChange: %+v", extra)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestRunAppliesPublishedState(t *testing.T) {
	mc, rdb, done := newTestClock(t)
	defer done()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Second process sharing the same Redis, running the subscriber.
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	mc2 := New(rdb, logger)
	applied := make(chan State, 1)
	mc2.OnChange(func(st State) { applied <- st })
	go mc2.Run(ctx)
	time.Sleep(50 * time.Millisecond) // let the subscription attach

	if err := mc.Set(ctx, time.Date(2001, 9, 11, 13, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("Set: %v", err)
	}
	select {
	case st := <-applied:
		if !st.Active {
			t.Fatal("expected active state via pub/sub")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("subscriber never applied the published state")
	}
	if _, ok := mc2.Now(); !ok {
		t.Fatal("mc2 should be active after pub/sub apply")
	}
}
