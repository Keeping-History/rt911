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
	StabilityWindowed   Stability = 1 // floored to a virtual minute: identical for every message in that minute
	StabilityAppendOnly Stability = 2 // grows forward only, never rewritten
	StabilityVolatile   Stability = 3 // differs every turn
)

// PromptSegment is one ordered piece of the prompt. Compose emits these rather
// than a finished vendor payload so a single composer serves every provider.
//
// Role is "system", "user", or "assistant". Prior buddy replies are genuinely
// assistant-role rather than transcript lines inside a user block: a cache read
// requires a byte-identical prefix, and one growing block is a new prefix on
// every turn, so a conversation rendered as a single block can never be reused.
// Split across per-turn blocks, everything but the newest turn is a cache hit.
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
	Profile  Profile
	Phase    Phase
	Digest   []Passage
	Recent   []Passage
	Timeline []Passage
	// Live is the tail of tier 2 that Recent cannot hold: the segments aired
	// since the top of the current virtual minute. Recent is floored to that
	// minute so it stays byte-identical (and therefore cacheable) for every
	// message sent within it, which necessarily leaves the partial minute out;
	// Live carries it, and is the one knowledge block that must stay volatile.
	Live        []Passage
	History     []Turn
	VirtualTime time.Time
	UserMessage string
	// SelfInitiated marks a proactive scheduled beat (chat_schedules): the
	// buddy is messaging first, not answering. UserMessage in this case is
	// the curator's internal stage direction (chat_schedules.prompt), never
	// something the student said — liveTurn must never present it as an
	// incoming message, and must tell the model it is the one starting the
	// conversation.
	SelfInitiated bool
	// Distress marks a message the guard escalated rather than allowed: the
	// student may be genuinely upset, not merely writing something raw. It
	// steers the reply toward a gentle in-character deflection instead of an
	// ordinary one, which is the whole reason escalate exists as a third
	// outcome alongside allow and block.
	Distress bool
	// UserName is how this buddy should address the student, when known. It
	// lives in the stable system segment because the person on the other end
	// does not change mid-conversation, so naming them costs no cache.
	UserName string
}

// Compose renders the prompt as ordered, stability-tagged segments.
//
// The ordering is the load-bearing part, and it is ordered by *stability*, not
// by narrative: stable, then windowed, then append-only, then volatile. A cache
// read needs a byte-identical prefix, so a block is only ever reusable if every
// block ahead of it is also unchanged — which means the least-stable content has
// to come last or it invalidates everything behind it.
//
// That is why the knowledge tiers now precede the conversation. Tier 2 is the
// largest thing in the prompt by a wide margin, and behind the history it was
// re-billed in full on every single message; ahead of it, it is a cache read for
// every message sent in the same virtual minute. The virtual clock and the
// user's message stay in the final volatile segment, where they cost nothing but
// themselves.
func Compose(in ComposeInput) []PromptSegment {
	segs := []PromptSegment{{
		Stability: StabilityStable,
		Role:      "system",
		Text:      persona(in.Profile, in.UserName),
	}}

	if len(in.Digest) > 0 {
		segs = append(segs, PromptSegment{
			Stability: StabilityWindowed,
			Role:      "user",
			Text:      knowledgeBlock(in.Digest),
		})
	}
	if len(in.Recent) > 0 {
		segs = append(segs, PromptSegment{
			Stability: StabilityWindowed,
			Role:      "user",
			Text:      broadcastBlock(in.Recent),
		})
	}

	segs = append(segs, historySegments(trimEchoedTurn(in), len(segs) == 1)...)

	if len(in.Live) > 0 {
		segs = append(segs, PromptSegment{
			Stability: StabilityVolatile,
			Role:      "user",
			Text:      broadcastBlock(in.Live),
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

func persona(p Profile, userName string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "You are %s", p.ScreenName)
	if p.DisplayName != "" {
		fmt.Fprintf(&b, " (%s)", p.DisplayName)
	}
	b.WriteString(", a real person on an instant messaging service in 2001.\n")
	if p.Persona != "" {
		b.WriteString(p.Persona + "\n")
	}
	b.WriteString(whoTheyAreTalkingTo(userName))
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
	// Last, deliberately: this is a curator override, so it has to be able to
	// beat the generic rules above rather than be contradicted by them.
	if p.SystemPromptExtra != "" {
		b.WriteString(p.SystemPromptExtra + "\n")
	}
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

// whoTheyAreTalkingTo establishes the student as a separate person.
//
// Without this the prompt never says who is messaging, so the model reaches for
// the only other name it has -- which for a persona like "You are Danny's aunt"
// means greeting the student as Danny. The denial matters more than the name:
// it has to hold even when nobody is named, or any persona mentioning another
// person invites the same mistake.
func whoTheyAreTalkingTo(userName string) string {
	if userName != "" {
		return "You are talking to " + userName + ", someone on your buddy list. " +
			userName + " is not anyone described in your own background above — " +
			"do not call them by any other name.\n"
	}
	return "You are talking to someone on your buddy list. You do not know their " +
		"real name, only that they are a friend online. They are not anyone " +
		"described in your own background above — do not guess at who they are " +
		"or call them by a name.\n"
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

// trimEchoedTurn drops the trailing history turn when it is the very message the
// live turn is about to quote.
//
// ChatSend persists the student's message before it retrieves context — on
// purpose, so a message is recorded even if generation never happens — and
// History is bounded by the same virtual time, so the message just written is
// already the last turn. Left in, every prompt states it twice: once as the last
// line of the conversation and again as "They just said". Only an inbound turn is
// ever dropped, and never on a self-initiated beat, where UserMessage is the
// curator's stage direction and matching it against a student turn would be
// comparing two unrelated things.
func trimEchoedTurn(in ComposeInput) []Turn {
	if in.SelfInitiated || len(in.History) == 0 {
		return in.History
	}
	if last := in.History[len(in.History)-1]; !last.FromBuddy && last.Text == in.UserMessage {
		return in.History[:len(in.History)-1]
	}
	return in.History
}

// historySegments renders the conversation as real alternating turns.
//
// The buddy's own prior replies are assistant-role messages, not "screenname:"
// lines inside one user block. That is cheaper and more faithful at once: it
// drops a label from every line plus the block header, it lets the model see its
// own voice as its own, and — the reason it matters most — it makes the
// conversation cacheable. One block that grows by a line per turn is a different
// prefix every turn and can never be read back; per-turn blocks share every byte
// except the newest.
//
// leadsMessages says no knowledge block precedes these, in which case a
// buddy-opened conversation would put an assistant message first. The
// conversation has to open on a user turn, so the opening line gets a minimal
// frame instead of being dropped — silently discarding the buddy's own first
// message would rewrite the start of the conversation.
func historySegments(turns []Turn, leadsMessages bool) []PromptSegment {
	var segs []PromptSegment
	for _, t := range turns {
		role := "user"
		if t.FromBuddy {
			role = "assistant"
		}
		if leadsMessages && len(segs) == 0 && role == "assistant" {
			segs = append(segs, PromptSegment{
				Stability: StabilityAppendOnly,
				Role:      "user",
				Text:      "Your conversation so far:",
			})
		}
		// Coalesce consecutive same-role turns: two buddy messages in a row (a
		// scheduled beat then a reply) or two student messages in a row (the
		// first one stalled) are one side speaking twice, and back-to-back
		// same-role messages are not universally accepted.
		if n := len(segs); n > 0 && segs[n-1].Role == role {
			segs[n-1].Text += "\n" + t.Text
			continue
		}
		segs = append(segs, PromptSegment{
			Stability: StabilityAppendOnly,
			Role:      role,
			Text:      t.Text,
		})
	}
	return segs
}

// liveTurn holds everything that changes every message: the clock, the phase
// directive, and either what the user just said or, for a self-initiated
// beat, what the buddy is reacting to. The two must never share a branch —
// presenting UserMessage as something the student typed when it is actually
// the curator's stage direction (chat_schedules.prompt) is exactly the
// misattribution SelfInitiated exists to prevent.
func liveTurn(in ComposeInput) string {
	var b strings.Builder
	fmt.Fprintf(&b, "It is %s.\n", in.VirtualTime.Format("3:04 PM"))
	if d := dialDirective(in.Phase); d != "" {
		b.WriteString(d + "\n")
	}
	if in.SelfInitiated {
		fmt.Fprintf(&b, "Nobody has said anything to you. You are messaging them first, "+
			"unprompted, because: %s\n", in.UserMessage)
		b.WriteString("Send the opening message of the conversation — you are starting it, not replying to one.\n")
	} else {
		fmt.Fprintf(&b, "They just said: %s\n", in.UserMessage)
	}
	if in.Distress {
		// Deflect, do not ignore: the message above still reaches the model, so
		// the reply answers the person rather than changing the subject at them.
		b.WriteString("They sound genuinely upset, not just curious. Notice it. " +
			"Be kind and steady, say something that helps them feel less alone, " +
			"and gently suggest they talk to someone with you right now — a " +
			"parent, a teacher, whoever is nearby. Do not describe anything " +
			"graphic, do not dwell on how many people were hurt, and do not " +
			"pretend to be a grown-up who can fix it.\n")
	}
	b.WriteString("Send one short instant message.\n")
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
