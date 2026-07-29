package chat

import (
	"reflect"
	"testing"
)

func TestCacheBreakpointsSitAtStabilityBoundaries(t *testing.T) {
	segs := []PromptSegment{
		{Stability: StabilityStable},     // 0 persona
		{Stability: StabilityAppendOnly}, // 1 digest
		{Stability: StabilityAppendOnly}, // 2 history  <- last append-only
		{Stability: StabilityVolatile},   // 3 broadcast
		{Stability: StabilityVolatile},   // 4 live turn
	}

	got := cacheBreakpoints(segs)

	// Mark the end of each cacheable run; never mark a volatile segment, which
	// changes every turn and would pay the write premium for a guaranteed miss.
	want := []int{0, 2}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("cacheBreakpoints = %v, want %v", got, want)
	}
}

func TestCacheBreakpointsNeverExceedFour(t *testing.T) {
	var segs []PromptSegment
	for i := 0; i < 12; i++ {
		segs = append(segs, PromptSegment{Stability: Stability(i % 2)})
	}
	if got := cacheBreakpoints(segs); len(got) > 4 {
		t.Errorf("returned %d breakpoints, Anthropic permits 4", len(got))
	}
}

func TestOutcomeConstantsAreStable(t *testing.T) {
	// These strings are written to chat_messages.moderation and read by the
	// dev harness, so renaming one is a data migration, not a refactor.
	if OutcomeOK != "ok" || OutcomeRefused != "refused" ||
		OutcomeTruncated != "truncated" || OutcomeError != "error" {
		t.Error("outcome constants drifted from the wire contract")
	}
}

func TestCacheBreakpointsOnTheRealPromptLayout(t *testing.T) {
	// The shape Compose actually emits: persona, the two windowed knowledge
	// blocks, one segment per conversation turn, then the volatile tail.
	segs := []PromptSegment{
		{Stability: StabilityStable, Role: "system"},        // 0 persona
		{Stability: StabilityWindowed, Role: "user"},        // 1 digest
		{Stability: StabilityWindowed, Role: "user"},        // 2 broadcast  <- windowed run ends
		{Stability: StabilityAppendOnly, Role: "user"},      // 3
		{Stability: StabilityAppendOnly, Role: "assistant"}, // 4
		{Stability: StabilityAppendOnly, Role: "user"},      // 5 newest turn <- run ends
		{Stability: StabilityVolatile, Role: "user"},        // 6 live tail
		{Stability: StabilityVolatile, Role: "user"},        // 7 live turn
	}

	got := cacheBreakpoints(segs)

	want := []int{0, 2, 5}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("cacheBreakpoints = %v, want %v", got, want)
	}
}

func TestTheAppendOnlyBreakpointSitsOnTheNewestTurn(t *testing.T) {
	// This is what makes the conversation accrue instead of rebuild: the marker
	// goes on the last turn, so the lookup finds the entry the previous message
	// wrote and only the new turn pays the write premium. A marker anywhere
	// earlier in the run would leave the newest turns permanently uncached.
	segs := []PromptSegment{
		{Stability: StabilityStable},
		{Stability: StabilityAppendOnly},
		{Stability: StabilityAppendOnly},
		{Stability: StabilityAppendOnly},
		{Stability: StabilityVolatile},
	}

	got := cacheBreakpoints(segs)

	last := got[len(got)-1]
	if last != 3 {
		t.Errorf("last breakpoint at %d, want 3 (the newest append-only segment)", last)
	}
}

func TestNoBreakpointEverLandsOnAVolatileSegment(t *testing.T) {
	// A marker on volatile content pays 1.25x to write a prefix that is
	// guaranteed never to be read.
	segs := []PromptSegment{
		{Stability: StabilityStable},
		{Stability: StabilityWindowed},
		{Stability: StabilityAppendOnly},
		{Stability: StabilityVolatile},
		{Stability: StabilityVolatile},
	}
	for _, i := range cacheBreakpoints(segs) {
		if segs[i].Stability == StabilityVolatile {
			t.Errorf("breakpoint %d sits on a volatile segment", i)
		}
	}
}
