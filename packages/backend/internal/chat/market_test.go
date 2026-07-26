package chat

import (
	"reflect"
	"sort"
	"testing"
)

func srcSet() []BroadcastSource {
	id := func(n int) *int { return &n }
	return []BroadcastSource{
		// Network affiliates are NATIONAL: on 9/11 they carried their network's
		// feed all day, so their content was not market-exclusive.
		{ChannelID: id(18), Name: "WNYW", Reach: ReachNational},
		{ChannelID: id(20), Name: "WRC", Reach: ReachNational},
		{ChannelID: id(6), Name: "CNN", Reach: ReachNational},
		{ChannelID: id(3), Name: "BBC", Reach: ReachInternational},
		{ChannelID: id(19), Name: "WORLDNET", Reach: ReachOutbound},
		// The genuinely market-exclusive content in this corpus: New York news
		// radio, with its own newsroom and no national feed.
		{Slug: "mp3:144", Name: "WINS", Reach: ReachLocal, Market: "new_york"},
		{Slug: "mp3:200", Name: "WCBS", Reach: ReachLocal, Market: "new_york"},
	}
}

func TestAllowedForGivesLocalOnlyToItsOwnMarket(t *testing.T) {
	// A buddy in Columbus could not have been listening to 1010 WINS.
	got := AllowedFor(srcSet(), "columbus_oh")

	if len(got.Slugs) != 0 {
		t.Errorf("a Columbus buddy must hear no New York radio, got %v", got.Slugs)
	}
}

func TestNetworkAffiliatesReachEveryMarket(t *testing.T) {
	// The correction that matters: an affiliate is a local transmitter but
	// carried national programming, so someone watching CBS in Ohio saw
	// substantially what a Washington viewer saw. Classify by programming.
	got := AllowedFor(srcSet(), "columbus_oh")

	sort.Ints(got.ChannelIDs)
	if want := []int{3, 6, 18, 20}; !reflect.DeepEqual(got.ChannelIDs, want) {
		t.Errorf("channels = %v, want the affiliates + cable + international %v", got.ChannelIDs, want)
	}
}

func TestAllowedForIncludesOwnMarketLocals(t *testing.T) {
	got := AllowedFor(srcSet(), "new_york")

	sort.Strings(got.Slugs)
	if want := []string{"mp3:144", "mp3:200"}; !reflect.DeepEqual(got.Slugs, want) {
		t.Errorf("slugs = %v, want WINS + WCBS", got.Slugs)
	}
}

func TestOutboundReachesNobody(t *testing.T) {
	// WORLDNET was US international broadcasting, barred from domestic airing
	// by Smith-Mundt. No American buddy could have seen it, in any market.
	for _, market := range []string{"new_york", "columbus_oh", "washington_dc", ""} {
		got := AllowedFor(srcSet(), market)
		for _, id := range got.ChannelIDs {
			if id == 19 {
				t.Errorf("market %q received outbound WORLDNET: %v", market, got.ChannelIDs)
			}
		}
	}
}

func TestAllowedForWithNoMarketStillGetsNationalAndInternational(t *testing.T) {
	// An unset market is a curation gap, not a reason to leave a buddy deaf.
	got := AllowedFor(srcSet(), "")

	sort.Ints(got.ChannelIDs)
	if want := []int{3, 6, 18, 20}; !reflect.DeepEqual(got.ChannelIDs, want) {
		t.Errorf("channels = %v, want national + international", got.ChannelIDs)
	}
	if len(got.Slugs) != 0 {
		t.Errorf("no market must mean no local radio, got %v", got.Slugs)
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
