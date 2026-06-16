package cache

import (
	"context"
	"testing"
	"time"

	"classicy/streamer/internal/model"
)

func TestUpsertNewsThenNewsItemsAt(t *testing.T) {
	rdb, done := newTestRedis(t)
	defer done()
	ctx := context.Background()

	start := time.Date(2001, 9, 11, 13, 30, 0, 0, time.UTC)
	item := model.MediaItem{ID: 9001, Title: "Headline", Format: "news", Approved: 1, StartDate: start}

	if err := UpsertNews(ctx, rdb, item); err != nil {
		t.Fatalf("UpsertNews: %v", err)
	}
	got, err := NewsItemsAt(ctx, rdb, start)
	if err != nil {
		t.Fatalf("NewsItemsAt: %v", err)
	}
	if len(got) != 1 || got[0].ID != 9001 || got[0].Title != "Headline" {
		t.Fatalf("expected one news item id=9001, got %+v", got)
	}
}

// All four caches use distinct Redis keyspaces; a write to one must never
// surface through another's lookup.
func TestNewsCacheIsolatedFromOthers(t *testing.T) {
	rdb, done := newTestRedis(t)
	defer done()
	ctx := context.Background()

	start := time.Unix(1000000000, 0).UTC()
	if err := UpsertNews(ctx, rdb, model.MediaItem{ID: 1, Title: "headline", Format: "news", StartDate: start, Approved: 1}); err != nil {
		t.Fatalf("UpsertNews: %v", err)
	}
	if err := UpsertMp3(ctx, rdb, model.MediaItem{ID: 1, Title: "radio", Format: "mp3", StartDate: start, Approved: 1}); err != nil {
		t.Fatalf("UpsertMp3: %v", err)
	}
	if err := Upsert(ctx, rdb, model.MediaItem{ID: 1, Title: "show", StartDate: start, Approved: 1}); err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	news, _ := NewsItemsAt(ctx, rdb, start)
	if len(news) != 1 || news[0].Title != "headline" {
		t.Fatalf("news lookup should return only the news item, got %+v", news)
	}
	mp3, _ := Mp3ItemsAt(ctx, rdb, start)
	if len(mp3) != 1 || mp3[0].Title != "radio" {
		t.Fatalf("mp3 lookup should return only the mp3 item, got %+v", mp3)
	}
	media, _ := ItemsAt(ctx, rdb, start)
	if len(media) != 1 || media[0].Title != "show" {
		t.Fatalf("media lookup should return only the media item, got %+v", media)
	}
}
