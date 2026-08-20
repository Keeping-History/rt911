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

// TestSelfInitiatedNeverRendersAsAReply is the fix-round-1 regression test for
// the misattribution finding: a scheduled beat's UserMessage is the curator's
// internal stage direction (chat_schedules.prompt), never something the
// student typed. Rendering it behind "They just said" would tell the model
// the student sent a message that never happened, and the model would answer
// a message nobody sent.
func TestSelfInitiatedNeverRendersAsAReply(t *testing.T) {
	in := composeInput()
	in.SelfInitiated = true
	in.UserMessage = "react to the second tower being hit"

	got := Compose(in)
	joined := allText(got)

	if strings.Contains(joined, "They just said") {
		t.Fatalf("a self-initiated beat must never render as a reply: %q", joined)
	}
	if !strings.Contains(joined, in.UserMessage) {
		t.Fatalf("the stage direction must still reach the prompt: %q", joined)
	}
	lower := strings.ToLower(joined)
	if !strings.Contains(lower, "messaging them first") && !strings.Contains(lower, "starting") &&
		!strings.Contains(lower, "opening message") {
		t.Fatalf("a self-initiated beat must tell the model it is initiating, not replying: %q", joined)
	}
}

func TestNonSelfInitiatedStillRendersTheyJustSaid(t *testing.T) {
	// The typed-reply path must keep today's behaviour exactly — only the new
	// SelfInitiated branch changes.
	got := Compose(composeInput())
	joined := allText(got)
	if !strings.Contains(joined, "They just said: is your mom ok") {
		t.Fatalf("a typed reply must still render as an answer to what was said: %q", joined)
	}
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

func TestDistressAddsAGentleDeflectionDirective(t *testing.T) {
	// The one moderation outcome that must NOT produce an ordinary reply. A
	// student signalling distress needs the character to notice and to point
	// them at a real person nearby.
	segs := Compose(ComposeInput{
		Profile:     Profile{ScreenName: "danny", Persona: "p"},
		Phase:       DefaultPhase,
		UserMessage: "i cant stop crying",
		Distress:    true,
	})

	live := segs[len(segs)-1].Text
	for _, want := range []string{"upset", "someone with you"} {
		if !strings.Contains(live, want) {
			t.Errorf("distress directive missing %q:\n%s", want, live)
		}
	}
	if !strings.Contains(live, "Do not describe") {
		t.Errorf("distress reply must be steered away from graphic detail:\n%s", live)
	}
}

func TestNoDistressLeavesTheTurnUnchanged(t *testing.T) {
	// The directive must not leak into ordinary conversation — every normal
	// reply would otherwise be told the student is upset.
	segs := Compose(ComposeInput{
		Profile:     Profile{ScreenName: "danny", Persona: "p"},
		Phase:       DefaultPhase,
		UserMessage: "did you see that",
	})

	live := segs[len(segs)-1].Text
	if strings.Contains(live, "upset") || strings.Contains(live, "someone with you") {
		t.Errorf("distress directive leaked into an ordinary turn:\n%s", live)
	}
}

func TestDistressStillCarriesWhatTheStudentSaid(t *testing.T) {
	// Deflecting is not ignoring: the character still sees the message, so the
	// reply is a response rather than a non-sequitur.
	segs := Compose(ComposeInput{
		Profile:     Profile{ScreenName: "danny", Persona: "p"},
		Phase:       DefaultPhase,
		UserMessage: "i cant stop crying",
		Distress:    true,
	})

	if !strings.Contains(segs[len(segs)-1].Text, "i cant stop crying") {
		t.Error("the student's own words must still reach the model")
	}
}

func TestPersonaSaysWhoTheBuddyIsTalkingTo(t *testing.T) {
	// Carol's persona says "You are Danny's aunt". With nothing in the prompt
	// about who is actually messaging her, the model picked the only other
	// person it had a name for and addressed the student as Danny.
	segs := Compose(ComposeInput{
		Profile:     Profile{ScreenName: "mrsbeckwithteaches", Persona: "You are Carol. You are Danny's aunt."},
		Phase:       DefaultPhase,
		UserName:    "Robbie",
		UserMessage: "are you safe",
	})

	sys := segs[0].Text
	if !strings.Contains(sys, "Robbie") {
		t.Errorf("persona never names the person being talked to:\n%s", sys)
	}
}

func TestPersonaAlwaysDeniesTheStudentIsSomeoneFromItsOwnBackground(t *testing.T) {
	// The load-bearing half. Naming the student is a nicety; this is the guard,
	// and it must hold even when no name is available -- otherwise any persona
	// that mentions another person invites the same misidentification.
	for _, name := range []string{"Robbie", ""} {
		segs := Compose(ComposeInput{
			Profile:     Profile{ScreenName: "mrsbeckwithteaches", Persona: "You are Danny's aunt."},
			Phase:       DefaultPhase,
			UserName:    name,
			UserMessage: "hi",
		})

		sys := segs[0].Text
		if !strings.Contains(sys, "not anyone described") {
			t.Errorf("UserName=%q: missing the not-someone-from-your-background guard:\n%s", name, sys)
		}
	}
}

func TestPersonaWithNoUserNameStillEstablishesASeparatePerson(t *testing.T) {
	segs := Compose(ComposeInput{
		Profile:     Profile{ScreenName: "danny"},
		Phase:       DefaultPhase,
		UserMessage: "hi",
	})

	if sys := segs[0].Text; !strings.Contains(sys, "buddy list") {
		t.Errorf("an unnamed student must still be established as someone else:\n%s", sys)
	}
}

func TestSystemPromptExtraReachesThePersona(t *testing.T) {
	// A curator's per-buddy addendum was loaded from Directus and then never
	// read, so typing one into the admin UI silently did nothing.
	segs := Compose(ComposeInput{
		Profile: Profile{
			ScreenName:        "danny",
			Persona:           "You are Danny.",
			SystemPromptExtra: "Never mention your father, it upsets you.",
		},
		Phase:       DefaultPhase,
		UserMessage: "hi",
	})

	if !strings.Contains(segs[0].Text, "Never mention your father") {
		t.Errorf("system_prompt_extra never reached the prompt:\n%s", segs[0].Text)
	}
}

func TestSystemPromptExtraSitsAfterTheOutputRules(t *testing.T) {
	// It is an override, so it has to come last: a curator writing "reply in
	// one word" must beat the generic instructions above it rather than being
	// silently contradicted by them.
	segs := Compose(ComposeInput{
		Profile:     Profile{ScreenName: "danny", SystemPromptExtra: "ZZEXTRAZZ"},
		Phase:       DefaultPhase,
		UserMessage: "hi",
	})

	sys := segs[0].Text
	if strings.Index(sys, "ZZEXTRAZZ") < strings.Index(sys, "Write only plain text") {
		t.Errorf("extra must come after the output rules it may override:\n%s", sys)
	}
}

func TestComposeRendersTheUserProfileInTheStableSegment(t *testing.T) {
	segs := Compose(ComposeInput{
		Profile:     Profile{ScreenName: "carol_nyc", Persona: "You are Danny's aunt."},
		UserName:    "Dave",
		UserMessage: "hi",
		UserProfile: UserProfile{Values: []UserValue{
			{Label: "city", Text: "Columbus"},
			{Label: "school", Text: "Lincoln High School"},
		}},
	})

	var stable string
	for _, s := range segs {
		if s.Stability == StabilityStable {
			stable = s.Text
		}
	}
	if stable == "" {
		t.Fatal("Compose emitted no stable segment")
	}
	for _, want := range []string{"city: Columbus", "school: Lincoln High School"} {
		if !strings.Contains(stable, want) {
			t.Errorf("stable segment missing %q:\n%s", want, stable)
		}
	}
	// Background, not script. A buddy that recites your school back at you is
	// worse than one that never knew it.
	if !strings.Contains(stable, "Do not bring these up unprompted") {
		t.Error("profile block is missing the do-not-volunteer instruction")
	}
	// The denial that stopped a persona written as "Danny's aunt" greeting
	// every user as Danny. A richer profile block makes it MORE load-bearing.
	if !strings.Contains(stable, "not anyone described in your own background") {
		t.Error("profile block displaced the who-you-are-talking-to denial")
	}
}

func TestComposeOrdersProfileValuesAsConfigured(t *testing.T) {
	segs := Compose(ComposeInput{
		Profile:     Profile{ScreenName: "carol_nyc"},
		UserMessage: "hi",
		UserProfile: UserProfile{Values: []UserValue{
			{Label: "first name", Text: "Dave"},
			{Label: "city", Text: "Columbus"},
			{Label: "school", Text: "Lincoln High School"},
		}},
	})
	stable := segs[0].Text
	first := strings.Index(stable, "first name: Dave")
	city := strings.Index(stable, "city: Columbus")
	school := strings.Index(stable, "school: Lincoln High School")
	if !(first < city && city < school) {
		t.Errorf("profile values are not in configured order:\n%s", stable)
	}
}

func TestComposeOmitsAnEmptyUserProfile(t *testing.T) {
	segs := Compose(ComposeInput{
		Profile:     Profile{ScreenName: "carol_nyc"},
		UserMessage: "hi",
	})
	stable := segs[0].Text
	if strings.Contains(stable, "Some things you know about them") {
		t.Errorf("empty profile still emitted a heading:\n%s", stable)
	}
	// The unnamed-friend denial must survive with no profile at all.
	if !strings.Contains(stable, "not anyone described in your own background") {
		t.Error("the denial is missing when there is no profile")
	}
}

// --- conversation rendering -------------------------------------------------

func TestHistoryRendersAsAlternatingRolesNotATranscriptBlock(t *testing.T) {
	in := composeInput()
	in.History = []Turn{
		{FromBuddy: false, Text: "are you seeing this"},
		{FromBuddy: true, Text: "yeah"},
	}

	got := Compose(in)

	var roles []string
	for _, seg := range got {
		if seg.Text == "are you seeing this" || seg.Text == "yeah" {
			roles = append(roles, seg.Role)
		}
	}
	if len(roles) != 2 || roles[0] != "user" || roles[1] != "assistant" {
		t.Fatalf("history roles = %v, want [user assistant]: the buddy's own reply must be an "+
			"assistant turn, not a line in a user block", roles)
	}

	// The old rendering glued every turn into one block with a "screenname:"
	// label per line and a header. That cost tokens on every message and, far
	// worse, made the conversation a new prefix every turn so it could never be
	// read back from cache.
	for _, seg := range got {
		if strings.Contains(seg.Text, "skaterboi1988: ") || strings.Contains(seg.Text, "them: ") {
			t.Fatalf("found a transcript label in %q; turns carry their role instead", seg.Text)
		}
	}
}

func TestKnowledgePrecedesTheConversation(t *testing.T) {
	// Tier 2 is the largest thing in the prompt. Behind the history it was
	// re-billed in full on every message, because the history changes every turn
	// and invalidates everything after it. Ahead of it, it is a cache read.
	got := Compose(composeInput())

	broadcast, firstTurn := -1, -1
	for i, seg := range got {
		if strings.Contains(seg.Text, "second aircraft") && broadcast < 0 {
			broadcast = i
		}
		if seg.Role == "assistant" && firstTurn < 0 {
			firstTurn = i
		}
	}
	if broadcast < 0 || firstTurn < 0 {
		t.Fatalf("expected both a broadcast block and an assistant turn, got %d and %d", broadcast, firstTurn)
	}
	if broadcast > firstTurn {
		t.Fatal("the broadcast block must sit ahead of the conversation, or the cached prefix ends before it")
	}
}

func TestConsecutiveSameRoleTurnsAreCoalesced(t *testing.T) {
	in := composeInput()
	in.UserMessage = "still there?"
	in.History = []Turn{
		{FromBuddy: false, Text: "hello"},
		{FromBuddy: true, Text: "hi"},
		{FromBuddy: true, Text: "sorry, phone was ringing"},
	}

	got := Compose(in)

	var assistant []string
	for _, seg := range got {
		if seg.Role == "assistant" {
			assistant = append(assistant, seg.Text)
		}
	}
	if len(assistant) != 1 {
		t.Fatalf("got %d assistant segments, want the two consecutive buddy turns coalesced into one", len(assistant))
	}
	if !strings.Contains(assistant[0], "hi") || !strings.Contains(assistant[0], "phone was ringing") {
		t.Fatalf("coalescing lost content: %q", assistant[0])
	}
}

func TestABuddyOpenedConversationStillStartsOnAUserTurn(t *testing.T) {
	// With no knowledge to precede it, a scheduled beat would put an assistant
	// message first. Dropping that opening line would silently rewrite the start
	// of the conversation, so it gets a minimal user frame instead.
	in := composeInput()
	in.Digest = nil
	in.Recent = nil
	in.History = []Turn{{FromBuddy: true, Text: "danny are you there"}}

	got := Compose(in)

	var first *PromptSegment
	for i := range got {
		if got[i].Role != "system" {
			first = &got[i]
			break
		}
	}
	if first == nil {
		t.Fatal("expected at least one message segment")
	}
	if first.Role != "user" {
		t.Fatalf("first message segment is %q; the conversation must open on a user turn", first.Role)
	}
	var found bool
	for _, seg := range got {
		if seg.Role == "assistant" && seg.Text == "danny are you there" {
			found = true
		}
	}
	if !found {
		t.Fatal("the buddy's opening message was dropped rather than framed")
	}
}

// --- the echoed-turn trim --------------------------------------------------

func TestTheStudentsMessageIsNotStatedTwice(t *testing.T) {
	// ChatSend persists the inbound message before it retrieves context, and
	// History is bounded by the same virtual time, so the message being answered
	// arrives as the last turn as well as in the live turn.
	in := composeInput()
	in.UserMessage = "is your mom ok"
	in.History = []Turn{
		{FromBuddy: true, Text: "yeah"},
		{FromBuddy: false, Text: "is your mom ok"},
	}

	got := Compose(in)

	var count int
	for _, seg := range got {
		count += strings.Count(seg.Text, "is your mom ok")
	}
	if count != 1 {
		t.Fatalf("the student's message appears %d times, want exactly once (in the live turn)", count)
	}
}

func TestSelfInitiatedNeverTrimsAStudentTurn(t *testing.T) {
	in := composeInput()
	in.SelfInitiated = true
	in.UserMessage = "react to the second impact"
	in.History = []Turn{{FromBuddy: false, Text: "react to the second impact"}}

	got := Compose(in)

	var found bool
	for _, seg := range got {
		if seg.Role == "user" && seg.Text == "react to the second impact" {
			found = true
		}
	}
	if !found {
		t.Fatal("a student turn was trimmed on a self-initiated beat")
	}
}

func TestAGenuineRepeatKeepsTheEarlierTurn(t *testing.T) {
	// Only the trailing turn is ever dropped. Someone typing the same thing
	// twice still has their earlier message in the conversation.
	in := composeInput()
	in.UserMessage = "what?"
	in.History = []Turn{
		{FromBuddy: false, Text: "what?"},
		{FromBuddy: true, Text: "the tower"},
		{FromBuddy: false, Text: "what?"},
	}

	got := Compose(in)

	var count int
	for _, seg := range got {
		count += strings.Count(seg.Text, "what?")
	}
	if count != 2 {
		t.Fatalf("got %d occurrences, want 2: the earlier repeat plus the live turn", count)
	}
}

// --- the live broadcast tail ----------------------------------------------

func TestLiveTailIsVolatileAndFollowsTheConversation(t *testing.T) {
	in := composeInput()
	in.Live = []Passage{{Tier: TierBroadcast, Text: "we are just hearing the pentagon"}}

	got := Compose(in)

	idx := -1
	for i, seg := range got {
		if strings.Contains(seg.Text, "just hearing the pentagon") {
			idx = i
		}
	}
	if idx < 0 {
		t.Fatal("the live tail never made it into the prompt")
	}
	if got[idx].Stability != StabilityVolatile {
		t.Fatalf("live tail stability = %v, want volatile: it moves every second and must never "+
			"sit inside a cached prefix", got[idx].Stability)
	}
	for i := 0; i < idx; i++ {
		if got[i].Role == "assistant" {
			return
		}
	}
	t.Fatal("the live tail must follow the conversation, not precede it")
}
