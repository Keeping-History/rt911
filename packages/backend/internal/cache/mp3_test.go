package cache

import (
	"context"
	"testing"
	"time"

	"classicy/streamer/internal/model"
)

func TestUpsertMp3ThenMp3ItemsAt(t *testing.T) {
	rdb, done := newTestRedis(t)
	defer done()
	ctx := context.Background()

	start := time.Date(2001, 9, 11, 15, 26, 0, 0, time.UTC)
	item := model.MediaItem{ID: 5821, Title: "ID Rountree", Format: "mp3", URL: "x.mp3", Approved: 1, StartDate: start}

	if err := UpsertMp3(ctx, rdb, item); err != nil {
		t.Fatalf("UpsertMp3: %v", err)
	}
	got, err := Mp3ItemsAt(ctx, rdb, start)
	if err != nil {
		t.Fatalf("Mp3ItemsAt: %v", err)
	}
	if len(got) != 1 || got[0].ID != 5821 || got[0].Title != "ID Rountree" {
		t.Fatalf("expected one mp3 item id=5821, got %+v", got)
	}
}

// mp3, pager and media items each live in their own Redis keyspace; a write to
// one must never surface through another's lookup.
func TestMp3CacheIsolatedFromMediaAndPager(t *testing.T) {
	rdb, done := newTestRedis(t)
	defer done()
	ctx := context.Background()

	start := time.Unix(1000000000, 0).UTC()
	if err := UpsertMp3(ctx, rdb, model.MediaItem{ID: 1, Title: "radio", Format: "mp3", StartDate: start, Approved: 1}); err != nil {
		t.Fatalf("UpsertMp3: %v", err)
	}
	if err := Upsert(ctx, rdb, model.MediaItem{ID: 1, Title: "show", StartDate: start, Approved: 1}); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	if err := UpsertPager(ctx, rdb, model.PagerItem{ID: 1, Message: "page", StartDate: start, Approved: 1}); err != nil {
		t.Fatalf("UpsertPager: %v", err)
	}

	mp3, _ := Mp3ItemsAt(ctx, rdb, start)
	if len(mp3) != 1 || mp3[0].Title != "radio" {
		t.Fatalf("mp3 lookup should return only the mp3 item, got %+v", mp3)
	}
	media, _ := ItemsAt(ctx, rdb, start)
	if len(media) != 1 || media[0].Title != "show" {
		t.Fatalf("media lookup should return only the media item, got %+v", media)
	}
	pager, _ := PagerItemsAt(ctx, rdb, start)
	if len(pager) != 1 || pager[0].Message != "page" {
		t.Fatalf("pager lookup should return only the pager item, got %+v", pager)
	}
}
