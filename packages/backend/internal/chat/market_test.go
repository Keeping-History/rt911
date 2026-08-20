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
	got := AllowedFor(srcSet(), "columbus_oh", "")

	if len(got.Slugs) != 0 {
		t.Errorf("a Columbus buddy must hear no New York radio, got %v", got.Slugs)
	}
}

func TestNetworkAffiliatesReachEveryMarket(t *testing.T) {
	// The correction that matters: an affiliate is a local transmitter but
	// carried national programming, so someone watching CBS in Ohio saw
	// substantially what a Washington viewer saw. Classify by programming.
	got := AllowedFor(srcSet(), "columbus_oh", "")

	sort.Ints(got.ChannelIDs)
	if want := []int{3, 6, 18, 20}; !reflect.DeepEqual(got.ChannelIDs, want) {
		t.Errorf("channels = %v, want the affiliates + cable + international %v", got.ChannelIDs, want)
	}
}

func TestAllowedForIncludesOwnMarketLocals(t *testing.T) {
	got := AllowedFor(srcSet(), "new_york", "")

	sort.Strings(got.Slugs)
	if want := []string{"mp3:144", "mp3:200"}; !reflect.DeepEqual(got.Slugs, want) {
		t.Errorf("slugs = %v, want WINS + WCBS", got.Slugs)
	}
}

func TestPrivateTapesReachNobody(t *testing.T) {
	// ATC, NEADS/NORAD and cockpit recordings were never broadcast. This is the
	// same provenance rule that keeps them out of the transcript ingest: no
	// civilian could hear them on the day, so no buddy can have heard them.
	src := append(srcSet(), BroadcastSource{Slug: "mp3:900", Name: "NEADS/NORAD", Reach: ReachPrivate})

	for _, market := range []string{"new_york", "columbus_oh", ""} {
		for _, s := range AllowedFor(src, market, "").Slugs {
			if s == "mp3:900" {
				t.Errorf("market %q received a private ATC/military tape", market)
			}
		}
	}
}

func TestOutboundReachesNobody(t *testing.T) {
	// WORLDNET was US international broadcasting, barred from domestic airing
	// by Smith-Mundt. No American buddy could have seen it, in any market.
	for _, market := range []string{"new_york", "columbus_oh", "washington_dc", ""} {
		got := AllowedFor(srcSet(), market, "")
		for _, id := range got.ChannelIDs {
			if id == 19 {
				t.Errorf("market %q received outbound WORLDNET: %v", market, got.ChannelIDs)
			}
		}
	}
}

func TestAllowedForWithNoMarketStillGetsNationalAndInternational(t *testing.T) {
	// An unset market is a curation gap, not a reason to leave a buddy deaf.
	got := AllowedFor(srcSet(), "", "")

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
	got := AllowedFor([]BroadcastSource{{ChannelID: &id, Name: "NEW"}}, "columbus_oh", "")

	if !reflect.DeepEqual(got.ChannelIDs, []int{99}) {
		t.Errorf("unclassified source dropped: %v", got.ChannelIDs)
	}
}

func TestNoClassificationAtAllIsUnfilteredNotSilent(t *testing.T) {
	// If the boot-time load failed or the columns are unpopulated, muting every
	// buddy's entire broadcast tier is far worse than a buddy hearing a station
	// slightly out of range. Only this case falls back to unfiltered.
	if got := AllowedFor(nil, "columbus_oh", ""); got != nil {
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

	got := AllowedFor(onlyNewYorkLocal, "columbus_oh", "")

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

func TestWatchingNarrowsToTheChosenSource(t *testing.T) {
	// A person watches one channel, not twenty-two. This is what makes the
	// "what you have just heard" block coherent rather than a blend of CNN,
	// NHK and Mexican network audio.
	got := AllowedFor(srcSet(), "columbus_oh", "CNN")

	if !reflect.DeepEqual(got.ChannelIDs, []int{6}) {
		t.Errorf("channels = %v, want just CNN (6)", got.ChannelIDs)
	}
}

func TestWatchingAcceptsSeveralSources(t *testing.T) {
	// The TV on one thing and the radio on another is a real 9/11 household.
	got := AllowedFor(srcSet(), "new_york", "WNYW, WINS")

	if !reflect.DeepEqual(got.ChannelIDs, []int{18}) {
		t.Errorf("channels = %v, want just WNYW (18)", got.ChannelIDs)
	}
	if !reflect.DeepEqual(got.Slugs, []string{"mp3:144"}) {
		t.Errorf("slugs = %v, want just WINS", got.Slugs)
	}
}

func TestWatchingCannotReachOutsideTheMarket(t *testing.T) {
	// The rule that makes this safe: watching NARROWS within what the market
	// allows, never expands it. A curator typing WINS onto an Ohio buddy is a
	// mistake, and it must not become a way to hear New York radio.
	got := AllowedFor(srcSet(), "columbus_oh", "WINS")

	if len(got.Slugs) != 0 {
		t.Errorf("watching must not grant an out-of-market source: %v", got.Slugs)
	}
}

func TestUnwatchableWatchingFallsBackRatherThanGoingSilent(t *testing.T) {
	// An unreachable or misspelled name is a curation error. Falling back to the
	// full receivable set keeps the buddy talking; UnwatchableNames surfaces the
	// mistake at boot instead of letting it silently deafen someone.
	got := AllowedFor(srcSet(), "columbus_oh", "WINS")

	if len(got.ChannelIDs) == 0 {
		t.Fatal("an unreachable watching value must fall back, not go silent")
	}
	sort.Ints(got.ChannelIDs)
	if want := []int{3, 6, 18, 20}; !reflect.DeepEqual(got.ChannelIDs, want) {
		t.Errorf("fallback = %v, want the full receivable set %v", got.ChannelIDs, want)
	}
}

func TestUnwatchableNamesReportsOnlyRealProblems(t *testing.T) {
	profiles := []Profile{
		{ScreenName: "danny", Market: "columbus_oh", Watching: "CNN"},
		{ScreenName: "carol", Market: "columbus_oh", Watching: "WINS"},
		{ScreenName: "sam", Market: "new_york", Watching: "WINS"},
		{ScreenName: "pat", Market: "columbus_oh", Watching: "TYPO"},
		{ScreenName: "lee", Market: "columbus_oh"},
	}

	got := UnwatchableNames(srcSet(), profiles)

	if !reflect.DeepEqual(got, []string{"carol: WINS", "pat: TYPO"}) {
		t.Errorf("UnwatchableNames = %v, want only carol and pat", got)
	}
}
