package chat

import (
	"strings"
	"testing"
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
