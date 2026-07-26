package chat

import (
	"fmt"
	"strings"
	"time"
)

// Stability tells the provider adapter where a cache breakpoint may go. Every
// provider caches on a prefix match, so the ordering below is what pays off
// everywhere; only the explicit breakpoint markers are Anthropic-specific.
type Stability int

const (
	StabilityStable     Stability = 0 // per-profile, unchanged for the life of the conversation
	StabilityAppendOnly Stability = 1 // grows forward only, never rewritten
	StabilityVolatile   Stability = 2 // differs every turn
)

// PromptSegment is one ordered piece of the prompt. Compose emits these rather
// than a finished vendor payload so a single composer serves every provider.
type PromptSegment struct {
	Stability Stability
	Role      string
	Text      string
}

// Turn is one prior message in the conversation.
type Turn struct {
	FromBuddy bool
	Text      string
}

// ComposeInput is everything needed to build a prompt. It carries no clock and
// no connection: Compose is pure, which is what makes the prompt exhaustively
// testable without a database or a network.
type ComposeInput struct {
	Profile     Profile
	Phase       Phase
	Digest      []Passage
	Recent      []Passage
	Timeline    []Passage
	History     []Turn
	VirtualTime time.Time
	UserMessage string
}

// Compose renders the prompt as ordered, stability-tagged segments.
//
// The ordering is the load-bearing part: stable content first, append-only
// next, volatile last. The virtual clock and the user's message must never
// appear in a stable segment — they change every turn, and at the front of the
// prefix they would invalidate the entire cache on every message.
func Compose(in ComposeInput) []PromptSegment {
	segs := []PromptSegment{{
		Stability: StabilityStable,
		Role:      "system",
		Text:      persona(in.Profile),
	}}

	if len(in.Digest) > 0 {
		segs = append(segs, PromptSegment{
			Stability: StabilityAppendOnly,
			Role:      "user",
			Text:      knowledgeBlock(in.Digest),
		})
	}
	if len(in.History) > 0 {
		segs = append(segs, PromptSegment{
			Stability: StabilityAppendOnly,
			Role:      "user",
			Text:      historyBlock(in.Profile, in.History),
		})
	}
	if len(in.Recent) > 0 {
		segs = append(segs, PromptSegment{
			Stability: StabilityVolatile,
			Role:      "user",
			Text:      broadcastBlock(in.Recent),
		})
	}
	if len(in.Timeline) > 0 {
		segs = append(segs, PromptSegment{
			Stability: StabilityVolatile,
			Role:      "user",
			Text:      timelineBlock(in.Timeline),
		})
	}

	segs = append(segs, PromptSegment{
		Stability: StabilityVolatile,
		Role:      "user",
		Text:      liveTurn(in),
	})
	return segs
}

func persona(p Profile) string {
	var b strings.Builder
	fmt.Fprintf(&b, "You are %s", p.ScreenName)
	if p.DisplayName != "" {
		fmt.Fprintf(&b, " (%s)", p.DisplayName)
	}
	b.WriteString(", a real person on an instant messaging service in 2001.\n")
	if p.Persona != "" {
		b.WriteString(p.Persona + "\n")
	}
	if p.EducationLevel != "" {
		fmt.Fprintf(&b, "You write like someone at a %s education level.\n", p.EducationLevel)
	}
	if p.WritingStyle != "" {
		b.WriteString(p.WritingStyle + "\n")
	}
	if p.StyleExemplars != "" {
		b.WriteString("Messages you have sent before, for voice:\n" + p.StyleExemplars + "\n")
	}
	b.WriteString(
		"Write only plain text. No markdown, no formatting, no unicode emoji — " +
			"text emoticons like :-) and :-/ only. Never mention being an AI. " +
			"If you do not know something, say so the way a person would.\n")
	return b.String()
}

// knowledgeBlock renders the cumulative digest. Tier 3 no longer reaches this
// block — it has its own slot in timelineBlock — so this only ever sees tier 1.
func knowledgeBlock(passages []Passage) string {
	var b strings.Builder
	b.WriteString("What you know so far:\n")
	b.WriteString(passageLines(passages))
	return b.String()
}

// broadcastBlock renders tier 2, grouped by medium so radio is never described
// as television — deterministic order, TV first.
func broadcastBlock(passages []Passage) string {
	var tv, radio []Passage
	for _, p := range passages {
		if p.Medium == "radio" {
			radio = append(radio, p)
			continue
		}
		tv = append(tv, p)
	}

	var b strings.Builder
	if len(tv) > 0 {
		b.WriteString("What you have just heard on TV:\n")
		b.WriteString(passageLines(tv))
	}
	if len(radio) > 0 {
		if b.Len() > 0 {
			b.WriteString("\n")
		}
		b.WriteString("What you have just heard on the radio:\n")
		b.WriteString(passageLines(radio))
	}
	return b.String()
}

// timelineBlock renders tier 3. It is deliberately not headed as something the
// buddy saw or heard: these passages are retrospective reporting, and a buddy
// on the day could not have had them. The instruction is what keeps the model
// from stating them as first-hand knowledge.
func timelineBlock(passages []Passage) string {
	var b strings.Builder
	b.WriteString("Background you are only half-aware of:\n")
	b.WriteString(passageLines(passages))
	b.WriteString("\nYou are not sure of these details. Refer to them vaguely if at " +
		"all, and do not quote them.\n")
	return b.String()
}

func passageLines(passages []Passage) string {
	var b strings.Builder
	for _, p := range passages {
		switch {
		case p.Tier == TierTimeline:
			fmt.Fprintf(&b, "- (uncertain) %s\n", p.Text)
		case p.Certainty == "rumor":
			fmt.Fprintf(&b, "- (people are saying) %s\n", p.Text)
		default:
			fmt.Fprintf(&b, "- %s\n", p.Text)
		}
	}
	return b.String()
}

func historyBlock(p Profile, turns []Turn) string {
	var b strings.Builder
	b.WriteString("Your conversation so far:\n")
	for _, t := range turns {
		who := "them"
		if t.FromBuddy {
			who = p.ScreenName
		}
		fmt.Fprintf(&b, "%s: %s\n", who, t.Text)
	}
	return b.String()
}

// liveTurn holds everything that changes every message: the clock, the phase
// directive, and what the user just said.
func liveTurn(in ComposeInput) string {
	var b strings.Builder
	fmt.Fprintf(&b, "It is %s.\n", in.VirtualTime.Format("3:04 PM"))
	if d := dialDirective(in.Phase); d != "" {
		b.WriteString(d + "\n")
	}
	fmt.Fprintf(&b, "They just said: %s\n", in.UserMessage)
	b.WriteString("Reply as one short instant message.\n")
	return b.String()
}

// dialDirective renders the numeric dials into language. The model never sees a
// number — "70" means nothing to it, while "badly shaken" does.
func dialDirective(p Phase) string {
	var parts []string
	if p.Tone != "" {
		parts = append(parts, "You feel "+p.Tone+".")
	}
	parts = append(parts, band(p.Shock,
		"You are not especially worried.",
		"You are unsettled.",
		"You are badly shaken."))
	parts = append(parts, band(p.Coherence,
		"You are struggling to finish a thought.",
		"You are a little scattered.",
		"You are thinking clearly."))
	parts = append(parts, band(p.Verbosity,
		"Answer in a few words.",
		"Answer in a sentence.",
		"Answer in two or three sentences."))
	parts = append(parts, band(p.TypoRate,
		"Your typing is clean.",
		"You make the occasional typo.",
		"You are typing fast and making mistakes."))
	parts = append(parts, band(p.TopicFocus,
		"You are talking about ordinary things.",
		"You drift between ordinary things and the news.",
		"You can only talk about what is happening."))
	return strings.Join(parts, " ")
}

func band(v int, low, mid, high string) string {
	switch {
	case v < 34:
		return low
	case v < 67:
		return mid
	default:
		return high
	}
}
