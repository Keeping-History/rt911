package chat

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeProvider struct {
	name    string
	reply   Reply
	err     error
	calls   int32
	capture func(Request)
}

func (f *fakeProvider) Name() string { return f.name }

func (f *fakeProvider) Generate(ctx context.Context, r Request) (Reply, error) {
	if f.capture != nil {
		f.capture(r)
	}
	atomic.AddInt32(&f.calls, 1)
	return f.reply, f.err
}

func TestEnqueueReturnsFalseWhenTheQueueIsFull(t *testing.T) {
	// Queue-full must be reported, not blocked on: the caller is the session
	// goroutine, and blocking it violates hard rule #2.
	g := NewGenerator(nil, map[string]Provider{"anthropic": &fakeProvider{}}, ShippedDefaults, 0, 0, 1, slog.Default())
	defer g.Close()

	_ = g.Enqueue(Job{})
	if g.Enqueue(Job{}) {
		t.Error("second enqueue on a full queue must return false")
	}
}

func TestGeneratedReplyIsSanitized(t *testing.T) {
	p := &fakeProvider{reply: Reply{Body: "**omg** 😱 http://cnn.com", Outcome: OutcomeOK}}
	g := NewGenerator(nil, map[string]Provider{"anthropic": p}, ShippedDefaults, 0, 1, 4, slog.Default())
	defer g.Close()

	got := make(chan Reply, 1)
	g.Enqueue(Job{
		Profile: Profile{ScreenName: "danny"},
		Deliver: func(r Reply, err error) { got <- r },
	})

	select {
	case r := <-got:
		if strings.ContainsAny(r.Body, "*") || strings.Contains(r.Body, "http") {
			t.Errorf("unsanitized body reached the caller: %q", r.Body)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no reply delivered")
	}
}

func TestUnknownProviderFailsWithoutCallingAnother(t *testing.T) {
	p := &fakeProvider{name: "anthropic"}
	g := NewGenerator(nil, map[string]Provider{"anthropic": p}, Settings{Provider: "nope", Model: "m", MaxTokens: 10}, 0, 1, 4, slog.Default())
	defer g.Close()

	errc := make(chan error, 1)
	g.Enqueue(Job{Deliver: func(r Reply, err error) { errc <- err }})

	select {
	case err := <-errc:
		if !errors.Is(err, ErrNoProvider) {
			t.Errorf("got %v, want ErrNoProvider", err)
		}
		if atomic.LoadInt32(&p.calls) != 0 {
			t.Error("must not silently fall through to a different provider")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no result delivered")
	}
}

func TestDoNotDiscussPassagesNeverReachTheProvider(t *testing.T) {
	// Redact is advisory -- Compose accepts raw []Passage -- so the generator
	// is the only thing enforcing it. A leak here is a content incident, not
	// a bug, which is why it is asserted on the wire rather than trusted, and
	// why every one of the three slices gets its own do_not_discuss passage:
	// a Digest/Recent/Timeline cross-wiring bug would still leak the text,
	// just under a different block header, and a single-slice test would not
	// catch that (each safe passage is also asserted under its OWN header
	// below, for the same reason).
	var seen Request
	p := &fakeProvider{reply: Reply{Body: "ok", Outcome: OutcomeOK}}
	p.capture = func(r Request) { seen = r }

	g := NewGenerator(nil, map[string]Provider{"anthropic": p}, ShippedDefaults, 0, 1, 4, slog.Default())
	defer g.Close()

	done := make(chan struct{})
	g.Enqueue(Job{
		Profile: Profile{ScreenName: "danny", Persona: "p"},
		Digest: []Passage{
			{Tier: TierCurated, Text: "digest safe", Sensitivity: "normal"},
			{Tier: TierCurated, Text: "DIGEST BAD", Sensitivity: "do_not_discuss"},
		},
		Recent: []Passage{
			{Tier: TierBroadcast, Text: "recent safe", Sensitivity: "normal", Medium: "tv"},
			{Tier: TierBroadcast, Text: "RECENT BAD", Sensitivity: "do_not_discuss", Medium: "tv"},
		},
		Timeline: []Passage{
			{Tier: TierTimeline, Text: "timeline safe", Sensitivity: "handle_with_care"},
			{Tier: TierTimeline, Text: "TIMELINE BAD", Sensitivity: "do_not_discuss"},
		},
		Deliver: func(Reply, error) { close(done) },
	})

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("no reply delivered")
	}

	for _, bad := range []string{"DIGEST BAD", "RECENT BAD", "TIMELINE BAD"} {
		for _, s := range seen.Segments {
			if strings.Contains(s.Text, bad) {
				t.Fatalf("do_not_discuss passage reached the provider: %q", bad)
			}
		}
	}

	// Guard against the test passing because nothing was sent at all, AND
	// against a cross-wired assignment (e.g. Digest: j.Recent): each safe
	// passage must render under its own tier's block header, not merely
	// appear somewhere in the request.
	digest, ok := findSegment(seen.Segments, "What you know so far")
	if !ok || !strings.Contains(digest, "digest safe") {
		t.Errorf("digest safe passage missing from its own block: %q", digest)
	}
	broadcast, ok := findSegment(seen.Segments, "What you have just heard on TV")
	if !ok || !strings.Contains(broadcast, "recent safe") {
		t.Errorf("recent safe passage missing from its own block: %q", broadcast)
	}
	timeline, ok := findSegment(seen.Segments, "Background you are only half-aware of")
	if !ok || !strings.Contains(timeline, "timeline safe") {
		t.Errorf("timeline safe passage missing from its own block: %q", timeline)
	}
}

func findSegment(segs []PromptSegment, header string) (string, bool) {
	for _, s := range segs {
		if strings.Contains(s.Text, header) {
			return s.Text, true
		}
	}
	return "", false
}

func TestEnqueueDoesNotPanicWhenRacingClose(t *testing.T) {
	// Close must never close the jobs channel itself -- a send racing a
	// close of that channel panics, and Enqueue's default: branch does
	// nothing to prevent it, since the panic fires on the send attempt, not
	// as a "channel full" outcome. This hammers Enqueue from many goroutines
	// concurrently with Close across several iterations to make that
	// regression reliably visible under -race.
	for iter := 0; iter < 20; iter++ {
		g := NewGenerator(nil,
			map[string]Provider{"anthropic": &fakeProvider{reply: Reply{Outcome: OutcomeOK}}},
			ShippedDefaults, 0, 4, 4, slog.Default())

		var wg sync.WaitGroup
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for j := 0; j < 200; j++ {
					g.Enqueue(Job{Deliver: func(Reply, error) {}})
				}
			}()
		}

		closed := make(chan struct{})
		go func() {
			g.Close()
			close(closed)
		}()

		wg.Wait()
		<-closed
	}
}
