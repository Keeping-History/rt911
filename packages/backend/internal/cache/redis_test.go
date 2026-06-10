package cache

import (
	"context"
	"testing"
	"time"

	"classicy/streamer/internal/model"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"
)

func newTestRedis(t *testing.T) (*goredis.Client, func()) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis.Run: %v", err)
	}
	rdb := goredis.NewClient(&goredis.Options{Addr: mr.Addr()})
	return rdb, func() {
		rdb.Close()
		mr.Close()
	}
}

func TestUpsertThenItemsAt(t *testing.T) {
	rdb, done := newTestRedis(t)
	defer done()
	ctx := context.Background()

	start := time.Date(2001, 9, 11, 8, 46, 0, 0, time.UTC)
	item := model.MediaItem{
		ID:        42,
		Title:     "test event",
		URL:       "https://example.com/event",
		Format:    "pager",
		Approved:  1,
		StartDate: start,
	}

	if err := Upsert(ctx, rdb, item); err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	got, err := ItemsAt(ctx, rdb, start)
	if err != nil {
		t.Fatalf("ItemsAt: %v", err)
	}
	if len(got) != 1 || got[0].ID != 42 || got[0].Title != "test event" {
		t.Fatalf("expected one item id=42 title='test event', got %+v", got)
	}
}

func TestForgetRemovesItem(t *testing.T) {
	rdb, done := newTestRedis(t)
	defer done()
	ctx := context.Background()

	start := time.Unix(1000201560, 0).UTC()
	item := model.MediaItem{ID: 7, Title: "x", StartDate: start, Approved: 1}

	if err := Upsert(ctx, rdb, item); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	if err := Forget(ctx, rdb, 7); err != nil {
		t.Fatalf("Forget: %v", err)
	}

	got, err := ItemsAt(ctx, rdb, start)
	if err != nil {
		t.Fatalf("ItemsAt: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected no items after Forget, got %+v", got)
	}
}

func TestUpsertOverwritesAndMovesScore(t *testing.T) {
	rdb, done := newTestRedis(t)
	defer done()
	ctx := context.Background()

	first := time.Unix(1000000000, 0).UTC()
	second := time.Unix(1000000600, 0).UTC()

	if err := Upsert(ctx, rdb, model.MediaItem{ID: 5, Title: "a", StartDate: first, Approved: 1}); err != nil {
		t.Fatalf("Upsert first: %v", err)
	}
	if err := Upsert(ctx, rdb, model.MediaItem{ID: 5, Title: "b", StartDate: second, Approved: 1}); err != nil {
		t.Fatalf("Upsert second: %v", err)
	}

	// Old score must no longer return the item.
	got, err := ItemsAt(ctx, rdb, first)
	if err != nil {
		t.Fatalf("ItemsAt first: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected item to have moved off first score, got %+v", got)
	}

	// New score returns the updated payload.
	got, err = ItemsAt(ctx, rdb, second)
	if err != nil {
		t.Fatalf("ItemsAt second: %v", err)
	}
	if len(got) != 1 || got[0].Title != "b" {
		t.Fatalf("expected updated title 'b', got %+v", got)
	}
}

func TestItemsAtEmptySecondReturnsNothing(t *testing.T) {
	rdb, done := newTestRedis(t)
	defer done()
	ctx := context.Background()

	got, err := ItemsAt(ctx, rdb, time.Now())
	if err != nil {
		t.Fatalf("ItemsAt empty: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected empty result, got %+v", got)
	}
}
