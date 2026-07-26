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
