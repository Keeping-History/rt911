package cache

import (
	"context"
	"testing"
	"time"

	"classicy/streamer/internal/model"
)

func strptr(s string) *string { return &s }

func TestAlertItemsInRangeAndForget(t *testing.T) {
	ctx := context.Background()
	rdb, cleanup := newTestRedis(t) // same helper the other *_test.go files use
	defer cleanup()

	base := time.Date(2001, 9, 11, 12, 40, 0, 0, time.UTC)
	items := []model.AlertItem{
		{MediaItem: model.MediaItem{ID: 1, Title: "First", StartDate: base}, Severity: strptr("caution")},
		{MediaItem: model.MediaItem{ID: 2, Title: "Second", StartDate: base.Add(30 * time.Second)}},
	}
	for _, it := range items {
		if err := UpsertAlert(ctx, rdb, it); err != nil {
			t.Fatalf("UpsertAlert: %v", err)
		}
	}

	got, err := AlertItemsInRange(ctx, rdb, base, base.Add(60*time.Second))
	if err != nil {
		t.Fatalf("AlertItemsInRange: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 items in range, got %d", len(got))
	}
	if got[0].Severity == nil || *got[0].Severity != "caution" {
		t.Fatalf("severity not round-tripped: %+v", got[0].Severity)
	}

	if err := ForgetAlert(ctx, rdb, 1); err != nil {
		t.Fatalf("ForgetAlert: %v", err)
	}
	got, _ = AlertItemsInRange(ctx, rdb, base, base.Add(60*time.Second))
	if len(got) != 1 || got[0].ID != 2 {
		t.Fatalf("forget did not remove id 1: %+v", got)
	}
}
