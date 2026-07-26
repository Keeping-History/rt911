package chat

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"
)

// TestLiveGeneration is the only test in this package that spends money and
// touches the network. It is skipped unless CHAT_LIVE_SMOKE=1 and a key is
// present, so `go test ./...` stays free and offline.
//
// It exists because every other test in this feature uses a fake provider. The
// real path -- compose a prompt from a persona and real knowledge, call the
// vendor, sanitise what comes back -- had never run once before this. A wiring
// mistake anywhere along it would be invisible to the rest of the suite.
//
//	CHAT_LIVE_SMOKE=1 ANTHROPIC_API_KEY=... go test ./internal/chat/ -run LiveGeneration -v
func TestLiveGeneration(t *testing.T) {
	if os.Getenv("CHAT_LIVE_SMOKE") != "1" {
		t.Skip("set CHAT_LIVE_SMOKE=1 to run the live provider smoke test")
	}
	key := os.Getenv("ANTHROPIC_API_KEY")
	if key == "" {
		t.Fatal("CHAT_LIVE_SMOKE=1 but ANTHROPIC_API_KEY is unset")
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	p := NewAnthropicProvider(key, logger)

	// Danny at 9:15 a.m. ET: the second plane has hit, and the curated digest
	// still carries the small-plane rumour that has not yet been superseded.
	vTime := time.Date(2001, 9, 11, 13, 15, 0, 0, time.UTC)
	in := ComposeInput{
		Profile: Profile{
			ID: 1, ScreenName: "skaterboi1988", DisplayName: "Danny",
			Persona: "You are Danny, 13, in eighth grade in Columbus, Ohio. You are home " +
				"sick from school today with a cold, watching TV in the living room. Your " +
				"mom is at work. You are into skateboarding and Tony Hawk's Pro Skater.",
			EducationLevel: "middle",
			WritingStyle: "You type in lowercase without punctuation. You use AIM shorthand: " +
				"u, ur, r, brb, omg, wut. Short messages. Text emoticons only, like :-) and :-/.",
			StyleExemplars: "yo\ndid u see the new tony hawk\nmy mom wont let me get it lol\nbrb",
		},
		Phase: Phase{
			Tone:  "frightened and asking a lot of questions",
			Shock: 65, Coherence: 55, Verbosity: 25, TypoRate: 75, TopicFocus: 90,
		},
		Digest: []Passage{
			{Tier: TierCurated, Text: "A second plane has hit the other tower, live on television.", Certainty: "confirmed"},
			{Tier: TierCurated, Text: "Both planes were airliners, not small planes. This was done on purpose.", Certainty: "confirmed"},
			{Tier: TierCurated, Text: "Nobody knows yet who did this or whether more planes are coming.", Certainty: "reported"},
		},
		Recent: []Passage{
			{Tier: TierBroadcast, Medium: "tv", Text: "we are getting reports now that this was a second aircraft, and officials are telling us this cannot be an accident"},
		},
		History:     []Turn{{FromBuddy: false, Text: "r u watching this"}, {FromBuddy: true, Text: "ya my mom called"}},
		VirtualTime: vTime,
		UserMessage: "what happened to the other tower",
	}

	segs := Compose(in)
	req := Request{Segments: segs, Model: "claude-opus-5", MaxTokens: 2000, Effort: "low"}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	reply, err := p.Generate(ctx, req)
	if err != nil {
		t.Fatalf("Generate: %v (outcome %q)", err, reply.Outcome)
	}
	if reply.Outcome != OutcomeOK {
		t.Fatalf("outcome = %q, want ok; body %q", reply.Outcome, reply.Body)
	}

	body := Sanitize(reply.Body, maxReplyRunes)
	t.Logf("model=%s in=%d out=%d cached=%d", reply.Model, reply.TokensIn, reply.TokensOut, reply.CachedIn)
	t.Logf("reply: %q", body)

	if strings.TrimSpace(body) == "" {
		t.Fatal("sanitised reply is empty")
	}
	// The post-processor's guarantees, checked on real model output rather than
	// on a fixture: a 2001 AIM client could render none of these.
	for _, bad := range []string{"**", "http", "<thinking>", "’", "—"} {
		if strings.Contains(body, bad) {
			t.Errorf("sanitised reply still contains %q: %q", bad, body)
		}
	}
	for _, r := range body {
		if r > 127 {
			t.Errorf("non-ASCII rune %q survived sanitising: %q", r, body)
			break
		}
	}
	if term, found := HasAnachronism(body); found {
		t.Errorf("reply contains post-2001 slang %q: %q", term, body)
	}
}

// TestLiveCarolDoesNotThinkTheStudentIsDanny reproduces the misidentification
// that shipped: Carol's persona says "You are Danny's aunt", and with nothing in
// the prompt about who is messaging her, the model addressed the student as
// Danny. Only a real call can prove the guard works, since the failure is the
// model's inference rather than anything the code emits.
func TestLiveCarolDoesNotThinkTheStudentIsDanny(t *testing.T) {
	if os.Getenv("CHAT_LIVE_SMOKE") != "1" {
		t.Skip("set CHAT_LIVE_SMOKE=1 to run the live provider smoke test")
	}
	key := os.Getenv("ANTHROPIC_API_KEY")
	if key == "" {
		t.Fatal("CHAT_LIVE_SMOKE=1 but ANTHROPIC_API_KEY is unset")
	}
	p := NewAnthropicProvider(key, slog.New(slog.NewTextHandler(io.Discard, nil)))

	in := ComposeInput{
		Profile: Profile{
			ID: 2, ScreenName: "mrsbeckwithteaches", DisplayName: "Carol",
			Persona: "You are Carol, 41, a high school English teacher in Columbus, Ohio, " +
				"on a free period in the staff room. You are Danny's aunt. You have a " +
				"brother who travels for work and you are not certain where he is flying today.",
			EducationLevel: "adult",
			WritingStyle:   "You write in complete sentences with correct punctuation. You are warm but measured.",
		},
		Phase:       Phase{Tone: "shaken, working hard to stay steady", Shock: 60, Coherence: 85, Verbosity: 45, TypoRate: 10, TopicFocus: 85},
		Digest:      []Passage{{Tier: TierCurated, Text: "Both towers have collapsed.", Certainty: "confirmed"}},
		VirtualTime: time.Date(2001, 9, 11, 15, 0, 0, 0, time.UTC),
		UserName:    "Robbie",
		UserMessage: "Are you safe? What's going on?",
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	reply, err := p.Generate(ctx, Request{Segments: Compose(in), Model: "claude-opus-5", MaxTokens: 2000, Effort: "low"})
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	body := Sanitize(reply.Body, maxReplyRunes)
	t.Logf("reply: %q", body)

	if strings.Contains(strings.ToLower(body), "danny") {
		t.Errorf("Carol addressed the student as Danny again: %q", body)
	}
}
