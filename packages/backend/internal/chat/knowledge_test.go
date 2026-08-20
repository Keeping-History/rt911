package chat

import (
	"strings"
	"testing"
	"time"
)

func TestRedactDropsDoNotDiscussEntirely(t *testing.T) {
	in := []Passage{
		{Tier: TierCurated, Text: "keep", Sensitivity: "normal"},
		{Tier: TierCurated, Text: "drop", Sensitivity: "do_not_discuss"},
		{Tier: TierCurated, Text: "keep too", Sensitivity: "handle_with_care"},
	}
	got := Redact(in)
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	for _, p := range got {
		if p.Text == "drop" {
			t.Fatal("a do_not_discuss passage must never reach the prompt")
		}
	}
}

func TestBudgetDropsLowestTierFirst(t *testing.T) {
	// Tier 1 is authored and authoritative; tier 3 is retrospective and only a
	// fallback. Under pressure the fallback goes first.
	in := []Passage{
		{Tier: TierTimeline, Text: strings.Repeat("c", 100)},
		{Tier: TierCurated, Text: strings.Repeat("a", 100)},
		{Tier: TierBroadcast, Text: strings.Repeat("b", 100)},
	}
	got := Budget(in, 250)

	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	for _, p := range got {
		if p.Tier == TierTimeline {
			t.Fatal("tier 3 must be dropped before tiers 1 and 2")
		}
	}
}

func TestBudgetKeepsTierOrderStable(t *testing.T) {
	in := []Passage{
		{Tier: TierBroadcast, Text: "b"},
		{Tier: TierCurated, Text: "a1"},
		{Tier: TierCurated, Text: "a2"},
	}
	got := Budget(in, 1000)

	if len(got) != 3 {
		t.Fatalf("len = %d, want 3 — nothing should be dropped under a large budget", len(got))
	}
	if got[0].Tier != TierCurated || got[1].Tier != TierCurated || got[2].Tier != TierBroadcast {
		t.Fatal("passages must be ordered by tier so the composer can label provenance")
	}
	if got[0].Text != "a1" || got[1].Text != "a2" {
		t.Fatal("order within a tier must be preserved")
	}
}

func TestBudgetStopsAtTheFirstOverBudgetPassage(t *testing.T) {
	// It must not skip past a large tier-2 passage to squeeze in a small tier-3
	// one — that would keep the less authoritative source and drop the more
	// authoritative one, which is backwards.
	in := []Passage{
		{Tier: TierCurated, Text: strings.Repeat("a", 50)},
		{Tier: TierBroadcast, Text: strings.Repeat("b", 300)},
		{Tier: TierTimeline, Text: "tiny"},
	}
	got := Budget(in, 200)

	if len(got) != 1 || got[0].Tier != TierCurated {
		t.Fatalf("got %d passages (first tier %v), want only the tier-1 one", len(got), got[0].Tier)
	}
}

func TestBudgetNeverDropsEveryPassage(t *testing.T) {
	// An impossible budget must still yield the single most authoritative
	// passage rather than an empty prompt, which would read as "knows nothing".
	in := []Passage{
		{Tier: TierCurated, Text: strings.Repeat("a", 500)},
		{Tier: TierBroadcast, Text: strings.Repeat("b", 500)},
	}
	got := Budget(in, 10)
	if len(got) != 1 || got[0].Tier != TierCurated {
		t.Fatalf("got %d passages, want exactly the tier-1 one", len(got))
	}
}

func TestBudgetWithNoPassagesIsEmptyNotNil(t *testing.T) {
	if got := Budget(nil, 100); got == nil || len(got) != 0 {
		t.Fatalf("got %v, want an empty non-nil slice", got)
	}
}

func TestFloorMinuteTruncatesToTheTopOfTheMinute(t *testing.T) {
	// An upper bound that moves every second is what made the knowledge blocks
	// byte-different on every message and therefore impossible to cache.
	got := FloorMinute(time.Date(2001, 9, 11, 13, 3, 47, 500_000_000, time.UTC))
	want := time.Date(2001, 9, 11, 13, 3, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Errorf("FloorMinute = %s, want %s", got, want)
	}
}

func TestFloorMinuteIsStableAcrossASecondAndNormalizesToUTC(t *testing.T) {
	base := time.Date(2001, 9, 11, 13, 3, 0, 0, time.UTC)
	for _, sec := range []int{0, 1, 30, 59} {
		if got := FloorMinute(base.Add(time.Duration(sec) * time.Second)); !got.Equal(base) {
			t.Fatalf("second %d floored to %s, want %s — every message in a minute must "+
				"produce an identical bound", sec, got, base)
		}
	}
	// A non-UTC input must not shift the bound: the whole corpus is UTC, and a
	// zone-local floor would silently select a different minute.
	east := time.FixedZone("EDT", -4*60*60)
	if got := FloorMinute(base.In(east)); !got.Equal(base) {
		t.Errorf("FloorMinute in %v = %s, want %s", east, got, base)
	}
}

func TestDetailWindowKeepsRecentEntriesAndDropsOldOnes(t *testing.T) {
	now := time.Date(2001, 9, 11, 13, 0, 0, 0, time.UTC)
	window := 20 * time.Minute

	if !withinDetailWindow(now.Add(-5*time.Minute), now, window) {
		t.Error("an entry 5 minutes old must keep its detail — the buddy is still reacting to it")
	}
	if withinDetailWindow(now.Add(-90*time.Minute), now, window) {
		t.Error("an entry 90 minutes old must drop its detail; the cumulative digest holds the whole day")
	}
	// Exactly on the boundary counts as inside, so the rule has no one-second gap.
	if !withinDetailWindow(now.Add(-window), now, window) {
		t.Error("the boundary itself must be inside the window")
	}
	// A zero window means "no trimming at all" rather than "trim everything" —
	// the fail-open direction here is the safe one, since detail is content the
	// curator authored.
	if !withinDetailWindow(now.Add(-24*time.Hour), now, 0) {
		t.Error("a zero window must keep detail on everything")
	}
}
