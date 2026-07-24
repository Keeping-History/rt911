package db

import (
	"testing"
	"time"
)

// NewsEpoch is the single date floor for the News app's back catalogue. It is
// pinned here because a wrong value is invisible at runtime — the app would just
// show a backlog that starts a few hours late.
//
// This is deliberately midnight UTC, NOT midnight ET (which would be 04:00Z).
// Articles dated 9/9 and 9/10 carry date-only timestamps (start_date exactly
// 00:00:00), so a "correct" ET-to-UTC floor of 04:00Z silently excludes every
// article dated 9/9 — verified against production, all 17 of them. Do not
// "fix" this back to 04:00Z.
func TestNewsEpochIsStartOfSeptember9(t *testing.T) {
	want := time.Date(2001, 9, 9, 0, 0, 0, 0, time.UTC)
	if !NewsEpoch.Equal(want) {
		t.Fatalf("NewsEpoch = %s, want %s (start of 2001-09-09 UTC)", NewsEpoch, want)
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
