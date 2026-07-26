package chat

import (
	"strings"
	"testing"
)

func composeInput() ComposeInput {
	return ComposeInput{
		Profile: Profile{ScreenName: "skaterboi1988", DisplayName: "Danny"},
		Phase:   Phase{Tone: "rattled", Shock: 70, Coherence: 40, Verbosity: 20, TypoRate: 60, TopicFocus: 90},
		Digest: []Passage{
			{Tier: TierCurated, Text: "a plane hit the north tower", Certainty: "reported"},
		},
		Recent: []Passage{
			{Tier: TierBroadcast, Text: "we are getting reports of a second aircraft"},
		},
		History:     []Turn{{FromBuddy: false, Text: "are you seeing this"}, {FromBuddy: true, Text: "yeah"}},
		VirtualTime: at("13:10"),
		UserMessage: "is your mom ok",
	}
}

func TestComposeOrdersSegmentsByStability(t *testing.T) {
	got := Compose(composeInput())

	if len(got) < 3 {
		t.Fatalf("got %d segments, want at least persona, digest and the live turn", len(got))
	}
	if got[0].Stability != StabilityStable {
		t.Fatal("the stable persona block must come first so it can be cached")
	}
	if got[len(got)-1].Stability != StabilityVolatile {
		t.Fatal("the per-turn block must come last so it never invalidates the cached prefix")
	}

	// Stability must be non-increasing across the sequence, or a cache
	// breakpoint placed at a boundary would sit in front of volatile content.
	for i := 1; i < len(got); i++ {
		if got[i].Stability < got[i-1].Stability {
			t.Fatalf("segment %d (%v) is more stable than its predecessor (%v)", i, got[i].Stability, got[i-1].Stability)
		}
	}
}

func TestComposeNeverPutsTheClockInTheStableBlock(t *testing.T) {
	// The clock changes every turn. In the system block it would invalidate the
	// whole cached prefix on every message, which is the single most expensive
	// mistake available here.
	got := Compose(composeInput())
	for _, seg := range got {
		if seg.Stability == StabilityStable && strings.Contains(seg.Text, "13:10") {
			t.Fatal("the virtual clock must not appear in a stable segment")
		}
	}
}

func TestComposeRendersDialsAsLanguageNotNumbers(t *testing.T) {
	got := Compose(composeInput())
	joined := allText(got)
	if strings.Contains(joined, "70") || strings.Contains(joined, "Shock") {
		t.Fatal("dials must be rendered into prompt language, never emitted as raw numbers")
	}
	if !strings.Contains(strings.ToLower(joined), "rattled") {
		t.Fatal("the phase's prose tone must reach the prompt")
	}
}

func TestComposeLabelsTierThreeAsUncertain(t *testing.T) {
	in := composeInput()
	// Tier 3 has its own slot (Gap 1) rather than riding along in Digest.
	in.Timeline = append(in.Timeline, Passage{
		Tier: TierTimeline, Text: "NEADS scrambles fighters from Otis", Certainty: "confirmed",
	})
	got := Compose(in)
	joined := allText(got)

	if !strings.Contains(joined, "NEADS") {
		t.Fatal("tier 3 content should still be available to the model")
	}
	if !strings.Contains(strings.ToLower(joined), "vague") &&
		!strings.Contains(strings.ToLower(joined), "do not quote") {
		t.Fatal("tier 3 must carry an instruction to paraphrase vaguely — it is hindsight a civilian lacked")
	}
}

func TestComposeIncludesTheUserMessageLast(t *testing.T) {
	got := Compose(composeInput())
	last := got[len(got)-1]
	if !strings.Contains(last.Text, "is your mom ok") {
		t.Fatal("the user's message must be in the final segment")
	}
	if last.Role != "user" {
		t.Fatalf("final segment role = %q, want user", last.Role)
	}
}

func TestComposeWithNoKnowledgeIsStillUsable(t *testing.T) {
	in := composeInput()
	in.Digest, in.Recent = nil, nil
	got := Compose(in)

	if len(got) < 2 {
		t.Fatalf("got %d segments — an empty knowledge set must still yield a usable prompt", len(got))
	}
	if !strings.Contains(allText(got), "is your mom ok") {
		t.Fatal("the user's message must survive an empty knowledge set")
	}
}

func TestComposeIsPure(t *testing.T) {
	in := composeInput()
	a, b := Compose(in), Compose(in)
	if allText(a) != allText(b) {
		t.Fatal("Compose must be deterministic — same input, same prompt")
	}
	if len(in.Digest) != 1 || len(in.History) != 2 {
		t.Fatal("Compose must not mutate its input")
	}
}

func TestComposeRendersTimelineSeparatelyFromBroadcast(t *testing.T) {
	segs := Compose(ComposeInput{
		Profile:  Profile{ScreenName: "danny", Persona: "p"},
		Phase:    DefaultPhase,
		Recent:   []Passage{{Tier: TierBroadcast, Medium: "tv", Text: "we are getting reports"}},
		Timeline: []Passage{{Tier: TierTimeline, Text: "investigators later concluded"}},
	})

	var broadcast, timeline string
	for _, s := range segs {
		if strings.Contains(s.Text, "we are getting reports") {
			broadcast = s.Text
		}
		if strings.Contains(s.Text, "investigators later concluded") {
			timeline = s.Text
		}
	}
	if broadcast == "" || timeline == "" {
		t.Fatalf("both passages must render; got broadcast=%q timeline=%q", broadcast, timeline)
	}
	if broadcast == timeline {
		t.Fatal("tier 2 and tier 3 must not share a segment")
	}
	// The misattribution this slot exists to prevent.
	if strings.Contains(timeline, "just heard") {
		t.Errorf("tier 3 rendered as something the buddy just heard: %q", timeline)
	}
	if !strings.Contains(timeline, "do not quote") {
		t.Errorf("tier 3 lost its paraphrase instruction: %q", timeline)
	}
}

func TestComposeLabelsRadioAsRadioNotTV(t *testing.T) {
	segs := Compose(ComposeInput{
		Profile: Profile{ScreenName: "danny", Persona: "p"},
		Phase:   DefaultPhase,
		Recent: []Passage{
			{Tier: TierBroadcast, Medium: "radio", Text: "ten-ten wins news time"},
		},
	})

	for _, s := range segs {
		if strings.Contains(s.Text, "ten-ten wins news time") {
			if strings.Contains(s.Text, "on TV") {
				t.Errorf("radio segment described as television: %q", s.Text)
			}
			if !strings.Contains(s.Text, "radio") {
				t.Errorf("radio segment not identified as radio: %q", s.Text)
			}
			return
		}
	}
	t.Fatal("radio passage did not render at all")
}

func TestComposeStabilityIsMonotonic(t *testing.T) {
	segs := Compose(ComposeInput{
		Profile:  Profile{ScreenName: "danny", Persona: "p"},
		Phase:    DefaultPhase,
		Digest:   []Passage{{Tier: TierCurated, Text: "a plane hit the north tower"}},
		Recent:   []Passage{{Tier: TierBroadcast, Medium: "tv", Text: "b"}},
		Timeline: []Passage{{Tier: TierTimeline, Text: "c"}},
		History:  []Turn{{FromBuddy: false, Text: "hi"}},
	})

	// Prefix caching depends on this: a volatile segment before a stable one
	// invalidates everything after it on every turn.
	for i := 1; i < len(segs); i++ {
		if segs[i].Stability < segs[i-1].Stability {
			t.Fatalf("segment %d (%d) is more stable than %d (%d)",
				i, segs[i].Stability, i-1, segs[i-1].Stability)
		}
	}
}

func allText(segs []PromptSegment) string {
	var b strings.Builder
	for _, s := range segs {
		b.WriteString(s.Text)
		b.WriteString("\n")
	}
	return b.String()
}
