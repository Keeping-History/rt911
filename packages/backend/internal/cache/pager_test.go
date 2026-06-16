package cache

import (
	"context"
	"testing"
	"time"

	"classicy/streamer/internal/model"
)

func TestUpsertPagerThenPagerItemsAt(t *testing.T) {
	rdb, done := newTestRedis(t)
	defer done()
	ctx := context.Background()

	start := time.Date(2001, 9, 11, 8, 46, 0, 0, time.UTC)
	item := model.PagerItem{
		ID:          42,
		StartDate:   start,
		Provider:    "Metrocall",
		RecipientID: "1060278",
		Channel:     "B",
		Mode:        "ALPHA",
		Message:     "service not responding",
		Approved:    1,
	}

	if err := UpsertPager(ctx, rdb, item); err != nil {
		t.Fatalf("UpsertPager: %v", err)
	}

	got, err := PagerItemsAt(ctx, rdb, start)
	if err != nil {
		t.Fatalf("PagerItemsAt: %v", err)
	}
	if len(got) != 1 || got[0].ID != 42 || got[0].Message != "service not responding" {
		t.Fatalf("expected one pager item id=42, got %+v", got)
	}
	if got[0].Provider != "Metrocall" || got[0].Channel != "B" {
		t.Fatalf("expected provider/channel preserved, got %+v", got[0])
	}
}

func TestForgetPagerRemovesItem(t *testing.T) {
	rdb, done := newTestRedis(t)
	defer done()
	ctx := context.Background()

	start := time.Unix(1000201560, 0).UTC()
	item := model.PagerItem{ID: 7, Message: "x", StartDate: start, Approved: 1}

	if err := UpsertPager(ctx, rdb, item); err != nil {
		t.Fatalf("UpsertPager: %v", err)
	}
	if err := ForgetPager(ctx, rdb, 7); err != nil {
		t.Fatalf("ForgetPager: %v", err)
	}

	got, err := PagerItemsAt(ctx, rdb, start)
	if err != nil {
		t.Fatalf("PagerItemsAt: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected no items after ForgetPager, got %+v", got)
	}
}

// Pager and media items live in separate Redis keyspaces, so writing one must
// never surface through the other's lookup.
func TestPagerCacheIsolatedFromMedia(t *testing.T) {
	rdb, done := newTestRedis(t)
	defer done()
	ctx := context.Background()

	start := time.Unix(1000000000, 0).UTC()
	if err := UpsertPager(ctx, rdb, model.PagerItem{ID: 1, Message: "page", StartDate: start, Approved: 1}); err != nil {
		t.Fatalf("UpsertPager: %v", err)
	}
	if err := Upsert(ctx, rdb, model.MediaItem{ID: 1, Title: "show", StartDate: start, Approved: 1}); err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	media, err := ItemsAt(ctx, rdb, start)
	if err != nil {
		t.Fatalf("ItemsAt: %v", err)
	}
	if len(media) != 1 || media[0].Title != "show" {
		t.Fatalf("media lookup should return only the media item, got %+v", media)
	}

	pager, err := PagerItemsAt(ctx, rdb, start)
	if err != nil {
		t.Fatalf("PagerItemsAt: %v", err)
	}
	if len(pager) != 1 || pager[0].Message != "page" {
		t.Fatalf("pager lookup should return only the pager item, got %+v", pager)
	}
}
