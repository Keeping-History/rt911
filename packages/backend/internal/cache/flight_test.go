package cache

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"classicy/streamer/internal/model"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestPutFlightBucketThenRangeRoundTrips(t *testing.T) {
	rdb, done := newTestRedis(t)
	defer done()
	ctx := context.Background()

	minute := time.Date(2001, 9, 11, 12, 46, 0, 0, time.UTC)
	items := []model.FlightPosition{
		{ID: 1, Flight: "AA11", Carrier: "AA", StartDate: minute, Lat: 40.7, Lon: -74.0, AltFt: 29000, Phase: "enroute"},
		{ID: 2, Flight: "UA175", Carrier: "UA", StartDate: minute.Add(10 * time.Second), Lat: 40.6, Lon: -74.1, AltFt: 31000, Phase: "enroute", Diverted: true},
	}
	if err := PutFlightBucket(ctx, rdb, minute, items); err != nil {
		t.Fatalf("PutFlightBucket: %v", err)
	}

	got, err := FlightPositionsInRange(ctx, rdb, minute, minute.Add(time.Minute), discardLogger())
	if err != nil {
		t.Fatalf("FlightPositionsInRange: %v", err)
	}
	if len(got) != 2 || got[0].Flight != "AA11" || got[1].AltFt != 31000 || !got[1].Diverted {
		t.Fatalf("expected the two stored positions back, got %+v", got)
	}
	if !got[0].StartDate.Equal(minute) {
		t.Fatalf("StartDate must round-trip exactly, got %v", got[0].StartDate)
	}
}

// The range contract is half-open [lo, hi) on item start_date, even when lo/hi
// are not minute-aligned — boundary buckets are fetched but their items filtered.
func TestFlightPositionsInRangeIsHalfOpenAndUnaligned(t *testing.T) {
	rdb, done := newTestRedis(t)
	defer done()
	ctx := context.Background()

	m0 := time.Date(2001, 9, 11, 13, 0, 0, 0, time.UTC)
	m1 := m0.Add(time.Minute)
	if err := PutFlightBucket(ctx, rdb, m0, []model.FlightPosition{
		{ID: 1, Flight: "A", StartDate: m0.Add(10 * time.Second)},
		{ID: 2, Flight: "B", StartDate: m0.Add(40 * time.Second)},
	}); err != nil {
		t.Fatalf("PutFlightBucket m0: %v", err)
	}
	if err := PutFlightBucket(ctx, rdb, m1, []model.FlightPosition{
		{ID: 3, Flight: "C", StartDate: m1.Add(20 * time.Second)},
	}); err != nil {
		t.Fatalf("PutFlightBucket m1: %v", err)
	}

	// [m0+30s, m1+20s): id 1 (before lo) and id 3 (at exclusive hi) are out.
	got, err := FlightPositionsInRange(ctx, rdb, m0.Add(30*time.Second), m1.Add(20*time.Second), discardLogger())
	if err != nil {
		t.Fatalf("FlightPositionsInRange: %v", err)
	}
	if len(got) != 1 || got[0].ID != 2 {
		t.Fatalf("expected only id 2 in [m0+30s, m1+20s), got %+v", got)
	}
}

// Missing minutes (nobody airborne / outside data range) are silently skipped;
// an empty or inverted range returns nothing.
func TestFlightPositionsInRangeMissingMinutesAndEmptyRange(t *testing.T) {
	rdb, done := newTestRedis(t)
	defer done()
	ctx := context.Background()

	m := time.Date(2001, 9, 11, 14, 0, 0, 0, time.UTC)
	if err := PutFlightBucket(ctx, rdb, m, []model.FlightPosition{{ID: 9, Flight: "X", StartDate: m}}); err != nil {
		t.Fatalf("PutFlightBucket: %v", err)
	}

	// Range spans 5 minutes; only one bucket exists.
	got, err := FlightPositionsInRange(ctx, rdb, m.Add(-2*time.Minute), m.Add(3*time.Minute), discardLogger())
	if err != nil {
		t.Fatalf("FlightPositionsInRange: %v", err)
	}
	if len(got) != 1 || got[0].ID != 9 {
		t.Fatalf("expected exactly the one stored position, got %+v", got)
	}

	if got, err := FlightPositionsInRange(ctx, rdb, m, m, discardLogger()); err != nil || len(got) != 0 {
		t.Fatalf("empty range must return nothing, got %+v err %v", got, err)
	}
}

// A corrupt bucket loses at most its own minute — the rest of the window survives.
func TestFlightPositionsInRangeSkipsCorruptBucket(t *testing.T) {
	rdb, done := newTestRedis(t)
	defer done()
	ctx := context.Background()

	m0 := time.Date(2001, 9, 11, 15, 0, 0, 0, time.UTC)
	m1 := m0.Add(time.Minute)
	if err := rdb.HSet(ctx, keyFlightMinutes, minuteKey(m0), "not msgpack").Err(); err != nil {
		t.Fatalf("HSet corrupt: %v", err)
	}
	if err := PutFlightBucket(ctx, rdb, m1, []model.FlightPosition{{ID: 4, Flight: "D", StartDate: m1}}); err != nil {
		t.Fatalf("PutFlightBucket: %v", err)
	}

	got, err := FlightPositionsInRange(ctx, rdb, m0, m1.Add(time.Minute), discardLogger())
	if err != nil {
		t.Fatalf("FlightPositionsInRange: %v", err)
	}
	if len(got) != 1 || got[0].ID != 4 {
		t.Fatalf("expected the good bucket's position only, got %+v", got)
	}
}

// Flight buckets live in their own keyspace — pager/media lookups never see them.
func TestFlightCacheIsolatedFromPager(t *testing.T) {
	rdb, done := newTestRedis(t)
	defer done()
	ctx := context.Background()

	at := time.Date(2001, 9, 11, 16, 0, 0, 0, time.UTC)
	if err := PutFlightBucket(ctx, rdb, at, []model.FlightPosition{{ID: 1, Flight: "E", StartDate: at}}); err != nil {
		t.Fatalf("PutFlightBucket: %v", err)
	}
	pager, err := PagerItemsAt(ctx, rdb, at)
	if err != nil {
		t.Fatalf("PagerItemsAt: %v", err)
	}
	if len(pager) != 0 {
		t.Fatalf("pager lookup must not see flight buckets, got %+v", pager)
	}
}

// A warm cache (HLEN > 0) must short-circuit before touching Postgres — proven
// here by passing a nil pool: any DB access would panic.
func TestWarmFlightCacheSkipsWhenAlreadyWarm(t *testing.T) {
	rdb, done := newTestRedis(t)
	defer done()
	ctx := context.Background()

	m := time.Date(2001, 9, 11, 12, 0, 0, 0, time.UTC)
	if err := PutFlightBucket(ctx, rdb, m, []model.FlightPosition{{ID: 1, Flight: "F", StartDate: m}}); err != nil {
		t.Fatalf("PutFlightBucket: %v", err)
	}

	if err := WarmFlightCache(ctx, rdb, nil, discardLogger()); err != nil {
		t.Fatalf("WarmFlightCache should skip when warm, got %v", err)
	}
}
