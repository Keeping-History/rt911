package chat

import (
	"bytes"
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

	// block, when non-nil, is read from before Generate returns -- a way for
	// a test to hold a job "in flight" (already inside Generate, past
	// capture) for as long as it wants, to pin down what a queued-but-not-
	// yet-started job looks like by contrast.
	block <-chan struct{}
}

func (f *fakeProvider) Name() string { return f.name }

func (f *fakeProvider) Generate(ctx context.Context, r Request) (Reply, error) {
	if f.capture != nil {
		f.capture(r)
	}
	atomic.AddInt32(&f.calls, 1)
	if f.block != nil {
		<-f.block
	}
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

func TestEveryAcceptedJobGetsExactlyOneDeliverWhenRacingClose(t *testing.T) {
	// Close must never close the jobs channel itself -- a send racing a
	// close of that channel panics, and Enqueue's default: branch does
	// nothing to prevent it, since the panic fires on the send attempt, not
	// as a "channel full" outcome. That's the panic this test used to guard
	// (and still does, implicitly: any panic fails the test under -race).
	//
	// But a no-op Deliver only proves the absence of a panic, not the
	// absence of a drop: a fix that stops the workers from ever closing
	// jobs can still let them exit while a queued backlog sits unclaimed,
	// silently orphaning every job in it. The real invariant is that every
	// job Enqueue accepts (returns true) gets exactly one Deliver call --
	// a real reply, a provider error, or ErrShuttingDown -- and never zero
	// or two. Counting accepted vs delivered under a Close racing many
	// concurrent Enqueue calls is what catches that; this is the test that
	// must keep standing guard here.
	for iter := 0; iter < 20; iter++ {
		g := NewGenerator(nil,
			map[string]Provider{"anthropic": &fakeProvider{reply: Reply{Outcome: OutcomeOK}}},
			ShippedDefaults, 0, 4, 4, slog.Default())

		var accepted, delivered int64
		var wg sync.WaitGroup
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for j := 0; j < 200; j++ {
					ok := g.Enqueue(Job{Deliver: func(Reply, error) {
						atomic.AddInt64(&delivered, 1)
					}})
					if ok {
						atomic.AddInt64(&accepted, 1)
					}
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

		if accepted != delivered {
			t.Fatalf("iteration %d: accepted=%d delivered=%d, want equal -- "+
				"every accepted job must be delivered exactly once", iter, accepted, delivered)
		}
	}
}

func TestQueuedBacklogGetsErrShuttingDownWithoutWaitingOnItsNetworkCall(t *testing.T) {
	// The design tradeoff this test pins down: full-drain-through-the-real-
	// provider would make Close's latency scale with queue depth (each item
	// a multi-second LLM call) -- fatal under Kubernetes, where a slow
	// shutdown gets SIGKILLed mid-rollout. So a job already inside Generate
	// when Close is called finishes normally (this test's "in-flight" job),
	// but anything still only sitting in the queue must be errored out
	// without a second network round trip per item.
	//
	// A single worker is used deliberately, not two: with a free second
	// worker, it is a genuine race whether it dequeues a "queued" job before
	// Close is ever called, at which point that job has legitimately started
	// and is in flight too -- an accurate but useless test would then assert
	// on whichever job happened to win the race. One worker makes which job
	// is in flight (the first one enqueued, and only that one) and which are
	// still queued (the rest, since the sole worker is provably busy)
	// unambiguous.
	release := make(chan struct{})
	started := make(chan struct{})
	p := &fakeProvider{
		reply:   Reply{Outcome: OutcomeOK},
		capture: func(Request) { close(started) },
		block:   release,
	}

	var buf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&buf, nil))
	g := NewGenerator(nil, map[string]Provider{"anthropic": p}, ShippedDefaults, 0, 1, 4, logger)

	inFlight := make(chan error, 1)
	if !g.Enqueue(Job{Deliver: func(_ Reply, err error) { inFlight <- err }}) {
		t.Fatal("enqueue of the in-flight job was rejected")
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("in-flight job never reached the provider")
	}

	type outcome struct {
		reply Reply
		err   error
	}
	queued := make(chan outcome, 2)
	for i := 0; i < 2; i++ {
		if !g.Enqueue(Job{Deliver: func(r Reply, err error) { queued <- outcome{r, err} }}) {
			t.Fatal("enqueue of a queued job was rejected")
		}
	}

	closeDone := make(chan struct{})
	go func() {
		g.Close()
		close(closeDone)
	}()

	// Sanity check on the setup itself: the sole worker is still blocked
	// inside the in-flight job's Generate call, so neither queued job can
	// have been touched yet. If this fires, the test's premise (that these
	// two jobs are genuinely still queued, not started) is false.
	select {
	case o := <-queued:
		t.Fatalf("a queued job was delivered before the in-flight job was released: %+v", o)
	case <-time.After(100 * time.Millisecond):
	}

	close(release)

	select {
	case err := <-inFlight:
		if err != nil {
			t.Errorf("in-flight job: got err %v, want nil (let it finish normally)", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("in-flight job never delivered")
	}

	for i := 0; i < 2; i++ {
		select {
		case o := <-queued:
			if !errors.Is(o.err, ErrShuttingDown) {
				t.Errorf("queued job %d: got err %v, want ErrShuttingDown", i, o.err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("queued job never delivered")
		}
	}

	select {
	case <-closeDone:
	case <-time.After(2 * time.Second):
		t.Fatal("Close never returned")
	}

	if !strings.Contains(buf.String(), "dropped queued jobs at shutdown") {
		t.Errorf("expected a warn log on the dropped backlog, got: %s", buf.String())
	}
	if !strings.Contains(buf.String(), "dropped=2") {
		t.Errorf("expected the dropped count (2) in the log line, got: %s", buf.String())
	}
}

func TestTypingDelayScalesWithMessageLengthAndSpeed(t *testing.T) {
	// The design treats the typing indicator as a latency budget, not
	// decoration: a fast reply is held back so a buddy does not answer a
	// paragraph in 200ms and read as a machine.
	slow := TypingDelay("hello there friend", 4)  // 18 chars at 4 cps
	fast := TypingDelay("hello there friend", 20) // same text, quick typist
	if slow <= fast {
		t.Errorf("a slower typist must take longer: slow=%v fast=%v", slow, fast)
	}

	long := TypingDelay(strings.Repeat("a", 200), 4)
	short := TypingDelay("hi", 4)
	if long <= short {
		t.Errorf("a longer message must take longer: long=%v short=%v", long, short)
	}
}

func TestTypingDelayIsBoundedAtBothEnds(t *testing.T) {
	// No delay at all breaks the illusion; an unbounded one strands a student
	// staring at "is typing" because a curator typed 1 into typing_speed.
	if d := TypingDelay("hi", 0); d < typingDelayMin {
		t.Errorf("unset typing_speed must still floor the delay, got %v", d)
	}
	if d := TypingDelay(strings.Repeat("a", 10000), 1); d > typingDelayMax {
		t.Errorf("delay must be capped, got %v", d)
	}
}
