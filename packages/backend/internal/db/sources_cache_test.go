package db

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"classicy/streamer/internal/model"
)

func TestSourcesCacheMemoizesWithinTTL(t *testing.T) {
	var calls int32
	loader := func(ctx context.Context) (Sources, error) {
		atomic.AddInt32(&calls, 1)
		return Sources{Video: []string{"cnn"}, Usenet: []model.NewsgroupSource{}}, nil
	}
	c := newSourcesCacheWithLoader(loader, time.Minute)

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _ = c.Get(context.Background()) }()
	}
	wg.Wait()

	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("expected loader called once under concurrency, got %d", got)
	}
	if v := c.Get(context.Background()); len(v.Video) != 1 || v.Video[0] != "cnn" {
		t.Fatalf("unexpected cached value: %+v", v)
	}
}

func TestSourcesCacheServesLastGoodOnRefreshError(t *testing.T) {
	var calls int32
	loader := func(ctx context.Context) (Sources, error) {
		if atomic.AddInt32(&calls, 1) == 1 {
			return Sources{Video: []string{"cnn"}}, nil
		}
		return Sources{}, context.DeadlineExceeded
	}
	c := newSourcesCacheWithLoader(loader, time.Nanosecond) // force immediate expiry
	_ = c.Get(context.Background())                          // seed
	time.Sleep(time.Millisecond)
	v := c.Get(context.Background()) // refresh fails → last good
	if len(v.Video) != 1 || v.Video[0] != "cnn" {
		t.Fatalf("expected last-good value on refresh error, got %+v", v)
	}
}
