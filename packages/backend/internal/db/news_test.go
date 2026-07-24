package db

import (
	"testing"
	"time"
)

// NewsEpoch is the single date floor for the News app's back catalogue. It is
// pinned here because a wrong value is invisible at runtime — the app would just
// show a backlog that starts a few hours late.
func TestNewsEpochIsMidnightEasternOnSeptember9(t *testing.T) {
	want := time.Date(2001, 9, 9, 4, 0, 0, 0, time.UTC)
	if !NewsEpoch.Equal(want) {
		t.Fatalf("NewsEpoch = %s, want %s (2001-09-09 00:00 EDT)", NewsEpoch, want)
	}
}

// news_items.start_date is `timestamp without time zone`, and pgx encodes a
// time.Time to that type using its wall clock in its OWN location. A NewsEpoch
// built in any zone but UTC would shift the floor by that offset.
func TestNewsEpochIsUTC(t *testing.T) {
	if loc := NewsEpoch.Location(); loc != time.UTC {
		t.Fatalf("NewsEpoch location = %s, want UTC", loc)
	}
}
