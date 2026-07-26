package chat

import (
	"reflect"
	"sort"
	"testing"
)

func srcSet() []BroadcastSource {
	id := func(n int) *int { return &n }
	return []BroadcastSource{
		{ChannelID: id(18), Name: "WNYW", Reach: ReachLocal, Market: "new_york"},
		{ChannelID: id(20), Name: "WRC", Reach: ReachLocal, Market: "washington_dc"},
		{ChannelID: id(21), Name: "WSBK", Reach: ReachLocal, Market: "boston"},
		{ChannelID: id(6), Name: "CNN", Reach: ReachNational},
		{ChannelID: id(3), Name: "BBC", Reach: ReachInternational},
		{Slug: "mp3:144", Name: "WINS", Reach: ReachLocal, Market: "new_york"},
		{Slug: "mp3:200", Name: "WCBS", Reach: ReachLocal, Market: "new_york"},
	}
}

func TestAllowedForGivesLocalOnlyToItsOwnMarket(t *testing.T) {
	// The whole point: a buddy in Columbus cannot have been watching WNYW or
	// listening to 1010 WINS. Those are New York signals.
	got := AllowedFor(srcSet(), "columbus_oh")

	sort.Ints(got.ChannelIDs)
	if want := []int{3, 6}; !reflect.DeepEqual(got.ChannelIDs, want) {
		t.Errorf("channels = %v, want %v (national + international only)", got.ChannelIDs, want)
	}
	if len(got.Slugs) != 0 {
		t.Errorf("a Columbus buddy must hear no New York radio, got %v", got.Slugs)
	}
}

func TestAllowedForIncludesOwnMarketLocals(t *testing.T) {
	got := AllowedFor(srcSet(), "new_york")

	sort.Ints(got.ChannelIDs)
	if want := []int{3, 6, 18}; !reflect.DeepEqual(got.ChannelIDs, want) {
		t.Errorf("channels = %v, want %v", got.ChannelIDs, want)
	}
	sort.Strings(got.Slugs)
	if want := []string{"mp3:144", "mp3:200"}; !reflect.DeepEqual(got.Slugs, want) {
		t.Errorf("slugs = %v, want WINS + WCBS", got.Slugs)
	}
}

func TestAllowedForExcludesOtherMarketsLocals(t *testing.T) {
	got := AllowedFor(srcSet(), "washington_dc")

	for _, id := range got.ChannelIDs {
		if id == 18 || id == 21 {
			t.Errorf("a DC buddy must not receive New York (18) or Boston (21): %v", got.ChannelIDs)
		}
	}
	if len(got.Slugs) != 0 {
		t.Errorf("New York radio must not reach a DC buddy, got %v", got.Slugs)
	}
}

func TestAllowedForWithNoMarketStillGetsNationalAndInternational(t *testing.T) {
	// An unset market is a curation gap, not a reason to leave a buddy deaf.
	got := AllowedFor(srcSet(), "")

	sort.Ints(got.ChannelIDs)
	if want := []int{3, 6}; !reflect.DeepEqual(got.ChannelIDs, want) {
		t.Errorf("channels = %v, want national + international", got.ChannelIDs)
	}
}

func TestUnclassifiedSourcesAreCarriedNotDropped(t *testing.T) {
	// A source nobody has classified yet must keep reaching buddies, or adding
	// a channel silently makes it inaudible. Boot logs the gap instead.
	id := 99
	got := AllowedFor([]BroadcastSource{{ChannelID: &id, Name: "NEW"}}, "columbus_oh")

	if !reflect.DeepEqual(got.ChannelIDs, []int{99}) {
		t.Errorf("unclassified source dropped: %v", got.ChannelIDs)
	}
}

func TestNoClassificationAtAllIsUnfilteredNotSilent(t *testing.T) {
	// If the boot-time load failed or the columns are unpopulated, muting every
	// buddy's entire broadcast tier is far worse than a buddy hearing a station
	// slightly out of range. Only this case falls back to unfiltered.
	if got := AllowedFor(nil, "columbus_oh"); got != nil {
		t.Errorf("no classification must be unfiltered (nil), got %+v", got)
	}
}

func TestAPopulatedClassificationIsAppliedEvenWhenItPermitsNothing(t *testing.T) {
	// Past the point where a classification exists, silence is a curation
	// answer rather than an accident — so the filter must still be applied.
	// This is the trap this codebase already hit once: `if len(x) > 0` around a
	// filter turns "allow nothing" into "allow everything".
	id := 18
	onlyNewYorkLocal := []BroadcastSource{
		{ChannelID: &id, Name: "WNYW", Reach: ReachLocal, Market: "new_york"},
	}

	got := AllowedFor(onlyNewYorkLocal, "columbus_oh")

	if got == nil {
		t.Fatal("a populated classification must yield an applied filter, not nil")
	}
	if len(got.ChannelIDs) != 0 || len(got.Slugs) != 0 {
		t.Errorf("Columbus must receive nothing from a New-York-only set, got %+v", got)
	}
}

func TestUnclassifiedNamesReportsOnlyTheGaps(t *testing.T) {
	src := append(srcSet(), BroadcastSource{Name: "MYSTERY"})

	got := UnclassifiedNames(src)

	if !reflect.DeepEqual(got, []string{"MYSTERY"}) {
		t.Errorf("UnclassifiedNames = %v, want [MYSTERY]", got)
	}
}
