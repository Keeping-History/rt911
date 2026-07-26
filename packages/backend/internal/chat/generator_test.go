package chat

import (
	"context"
	"errors"
	"log/slog"
	"strings"
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
	// a bug, which is why it is asserted on the wire rather than trusted.
	var seen Request
	p := &fakeProvider{reply: Reply{Body: "ok", Outcome: OutcomeOK}}
	p.capture = func(r Request) { seen = r }

	g := NewGenerator(nil, map[string]Provider{"anthropic": p}, ShippedDefaults, 0, 1, 4, slog.Default())
	defer g.Close()

	done := make(chan struct{})
	g.Enqueue(Job{
		Profile: Profile{ScreenName: "danny", Persona: "p"},
		Digest: []Passage{
			{Tier: TierCurated, Text: "safe to say", Sensitivity: "normal"},
			{Tier: TierCurated, Text: "GRAPHIC DETAIL", Sensitivity: "do_not_discuss"},
		},
		Deliver: func(Reply, error) { close(done) },
	})

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("no reply delivered")
	}

	for _, s := range seen.Segments {
		if strings.Contains(s.Text, "GRAPHIC DETAIL") {
			t.Fatalf("do_not_discuss passage reached the provider: %q", s.Text)
		}
	}
	// Guard against the test passing because nothing was sent at all.
	var any bool
	for _, s := range seen.Segments {
		if strings.Contains(s.Text, "safe to say") {
			any = true
		}
	}
	if !any {
		t.Error("redaction dropped the safe passage too")
	}
}
