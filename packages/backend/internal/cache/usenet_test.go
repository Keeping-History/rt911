package cache

import (
	"context"
	"testing"
	"time"

	"classicy/streamer/internal/model"
)

func TestUpsertUsenetThenItemsAt(t *testing.T) {
	rdb, done := newTestRedis(t)
	defer done()
	ctx := context.Background()

	start := time.Date(2001, 9, 11, 13, 30, 0, 0, time.UTC)
	item := model.UsenetItem{ID: 7001, Newsgroup: "ntl.support.modems", Subject: "Re: dialup", Approved: 1, StartDate: start}

	if err := UpsertUsenet(ctx, rdb, item); err != nil {
		t.Fatalf("UpsertUsenet: %v", err)
	}
	got, err := UsenetItemsAt(ctx, rdb, "ntl.support.modems", start)
	if err != nil {
		t.Fatalf("UsenetItemsAt: %v", err)
	}
	if len(got) != 1 || got[0].ID != 7001 || got[0].Subject != "Re: dialup" {
		t.Fatalf("expected one usenet item id=7001, got %+v", got)
	}
}

// The time index is sharded per newsgroup: a message in one group must never
// surface through another group's lookup, even at the same instant.
func TestUsenetPerGroupIsolation(t *testing.T) {
	rdb, done := newTestRedis(t)
	defer done()
	ctx := context.Background()

	start := time.Unix(1000000000, 0).UTC()
	a := model.UsenetItem{ID: 1, Newsgroup: "ntl.discussion.gaming", Subject: "in A", StartDate: start, Approved: 1}
	b := model.UsenetItem{ID: 2, Newsgroup: "ntl.support.modems", Subject: "in B", StartDate: start, Approved: 1}
	if err := UpsertUsenet(ctx, rdb, a); err != nil {
		t.Fatalf("UpsertUsenet a: %v", err)
	}
	if err := UpsertUsenet(ctx, rdb, b); err != nil {
		t.Fatalf("UpsertUsenet b: %v", err)
	}

	gotA, _ := UsenetItemsAt(ctx, rdb, "ntl.discussion.gaming", start)
	if len(gotA) != 1 || gotA[0].ID != 1 {
		t.Fatalf("group A lookup should return only id=1, got %+v", gotA)
	}
	gotB, _ := UsenetItemsAt(ctx, rdb, "ntl.support.modems", start)
	if len(gotB) != 1 || gotB[0].ID != 2 {
		t.Fatalf("group B lookup should return only id=2, got %+v", gotB)
	}
}

// UsenetItemsInRange returns the half-open window [lo, hi) for one group only.
func TestUsenetItemsInRangeWindow(t *testing.T) {
	rdb, done := newTestRedis(t)
	defer done()
	ctx := context.Background()

	base := time.Date(2001, 9, 20, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 5; i++ {
		it := model.UsenetItem{ID: 100 + i, Newsgroup: "ntl.talk", StartDate: base.Add(time.Duration(i) * time.Minute), Approved: 1}
		if err := UpsertUsenet(ctx, rdb, it); err != nil {
			t.Fatalf("UpsertUsenet: %v", err)
		}
	}
	// Window [base+1m, base+3m): should include minutes 1 and 2, exclude 0 and 3.
	got, err := UsenetItemsInRange(ctx, rdb, "ntl.talk", base.Add(time.Minute), base.Add(3*time.Minute))
	if err != nil {
		t.Fatalf("UsenetItemsInRange: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 items in window, got %d: %+v", len(got), got)
	}
}

// ForgetUsenet must drop the message from its per-group ZSET (the group is read
// back from the stored JSON since DELETE carries only an id).
func TestForgetUsenetRemovesFromGroup(t *testing.T) {
	rdb, done := newTestRedis(t)
	defer done()
	ctx := context.Background()

	start := time.Unix(1000001234, 0).UTC()
	item := model.UsenetItem{ID: 42, Newsgroup: "ntl.feedback.general", StartDate: start, Approved: 1}
	if err := UpsertUsenet(ctx, rdb, item); err != nil {
		t.Fatalf("UpsertUsenet: %v", err)
	}
	if err := ForgetUsenet(ctx, rdb, 42); err != nil {
		t.Fatalf("ForgetUsenet: %v", err)
	}
	got, _ := UsenetItemsAt(ctx, rdb, "ntl.feedback.general", start)
	if len(got) != 0 {
		t.Fatalf("expected item evicted, got %+v", got)
	}
}
