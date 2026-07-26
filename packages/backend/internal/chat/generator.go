package chat

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// maxReplyRunes is the hard ceiling on a delivered message. A 2001 AIM window
// held far less than this; the prompt asks for brevity and this is the backstop.
const maxReplyRunes = 600

// ErrNoProvider is returned when the resolved settings name a provider that is
// not registered. It is delivered rather than silently substituted: using a
// different vendor than configured would produce a differently-characterised
// buddy and an unexplained bill.
var ErrNoProvider = errors.New("chat: no provider configured")

// ErrShuttingDown is delivered to a job that Enqueue accepted but that never
// started running before Close was called. It exists so every accepted job
// gets exactly one Deliver call -- success, refusal, or this -- rather than
// being silently dropped: the caller would otherwise wait forever on a reply
// that will never come.
var ErrShuttingDown = errors.New("chat: generator shutting down")

// Job is one buddy reply to generate. Deliver is called exactly once, from a
// worker goroutine, with either a usable Reply or a non-nil error.
type Job struct {
	UserID      string
	Profile     Profile
	Phase       Phase
	Body        string
	Kind        string
	VirtualTime time.Time
	Digest      []Passage
	Recent      []Passage
	Timeline    []Passage
	History     []Turn
	// SelfInitiated marks a proactive scheduled beat: Body is the curator's
	// stage direction (chat_schedules.prompt), not something the student
	// said. Carried straight into ComposeInput.SelfInitiated — see
	// composer.go's liveTurn for why the two must never be conflated.
	SelfInitiated bool
	Deliver       func(Reply, error)
}

// Generator is a bounded worker pool: the only place in this feature where
// blocking network I/O happens. Everything upstream — in particular the
// WebSocket session goroutine — must only ever call Enqueue, which never
// blocks.
type Generator struct {
	pool      *pgxpool.Pool
	providers map[string]Provider
	logger    *slog.Logger

	jobs chan Job
	wg   sync.WaitGroup

	// done signals shutdown. It is closed exactly once (closeOnce) and is
	// never the jobs channel itself: closing a channel producers may still be
	// mid-send on is a send-on-closed-channel panic waiting to happen. See
	// Enqueue and Close, and internal/session/session.go's send_/done for the
	// pattern this mirrors.
	done      chan struct{}
	closeOnce sync.Once

	// closeMu makes the closed transition atomic with respect to Enqueue's
	// send. Without it, an Enqueue that read closed==false could still be
	// preempted right before sending, race past the rest of Close (including
	// every worker draining and exiting), and land a job in jobs after
	// nothing is left to ever receive it -- silently breaking the "every
	// accepted job is delivered exactly once" invariant. Close holds the
	// write lock only long enough to flip the flag, so this never blocks
	// Enqueue for anything but the width of that single assignment.
	closeMu sync.RWMutex
	closed  bool

	// dropped counts jobs delivered ErrShuttingDown, logged exactly once
	// (logOnce) after every worker has exited, so a queued-but-unstarted
	// backlog at shutdown is visible to an operator instead of silent.
	dropped atomic.Int64
	logOnce sync.Once

	mu          sync.Mutex
	settings    Settings
	settingsAt  time.Time
	settingsTTL time.Duration
}

// NewGenerator starts a fixed pool of workers reading from a bounded queue. A
// nil pool means "never reload" — the seeded settings serve for the
// generator's lifetime, which is what keeps unit tests database-free.
func NewGenerator(pool *pgxpool.Pool, providers map[string]Provider, settings Settings, settingsTTL time.Duration, workers, queue int, logger *slog.Logger) *Generator {
	g := &Generator{
		pool:        pool,
		providers:   providers,
		logger:      logger,
		jobs:        make(chan Job, queue),
		done:        make(chan struct{}),
		settings:    settings,
		settingsAt:  time.Now(),
		settingsTTL: settingsTTL,
	}

	g.wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer g.wg.Done()
			for {
				select {
				case j := <-g.jobs:
					g.dispatch(j)
				case <-g.done:
					// jobs and done can both be ready at once here (a
					// backlog sitting behind a closed done), and select
					// picks between ready cases at random -- so this worker
					// cannot assume "done fired" means "jobs is empty".
					// Sweep whatever is left before actually exiting.
					g.drainQueued()
					return
				}
			}
		}()
	}
	return g
}

// Enqueue submits a job for generation. It never blocks: the caller is the
// session goroutine, and a full queue must become an in-character stall
// upstream rather than a stalled media stream. The read lock it briefly takes
// is not that kind of blocking -- Close only ever holds the write lock for a
// single assignment, never across a channel op or I/O.
//
// The closed check and the send happen under the same read lock so a job can
// never be sent after Close has committed to shutting down: see the closeMu
// field comment for why that matters.
func (g *Generator) Enqueue(j Job) bool {
	g.closeMu.RLock()
	defer g.closeMu.RUnlock()

	if g.closed {
		return false
	}
	select {
	case g.jobs <- j:
		return true
	default:
		return false
	}
}

// Close stops accepting new jobs, lets whatever each worker is already
// running finish normally, and errors out anything left queued rather than
// running it -- so shutdown cost is bounded by in-flight calls (at most
// `workers` of them), never by however deep the backlog happens to be.
// Closing done wakes any worker blocked on an empty queue; jobs itself is
// never closed (see the done field comment).
func (g *Generator) Close() {
	g.closeOnce.Do(func() {
		g.closeMu.Lock()
		g.closed = true
		g.closeMu.Unlock()
		close(g.done)
	})
	g.wg.Wait()

	g.logOnce.Do(func() {
		if n := g.dropped.Load(); n > 0 {
			g.logger.Warn("chat: dropped queued jobs at shutdown", "dropped", n)
		}
	})
}

// dispatch decides, per job, whether to run it or treat it as shutdown
// backlog. Checked per-job rather than once per worker so a job already
// running when Close was called finishes normally (Close waits for it) while
// one merely sitting in the queue never starts.
func (g *Generator) dispatch(j Job) {
	g.closeMu.RLock()
	closed := g.closed
	g.closeMu.RUnlock()

	if closed {
		g.deliverShutdown(j)
		return
	}
	g.run(j)
}

// drainQueued claims whatever remains in the buffered channel once a worker
// notices shutdown, so a job Enqueue accepted is never silently discarded.
// This never blocks and does no network I/O: closed is already true by the
// time this runs, so jobs can receive no further sends (see Enqueue), which
// means the channel's remaining contents are fixed and this loop terminates
// as soon as it observes empty.
func (g *Generator) drainQueued() {
	for {
		select {
		case j := <-g.jobs:
			g.deliverShutdown(j)
		default:
			return
		}
	}
}

func (g *Generator) deliverShutdown(j Job) {
	g.dropped.Add(1)
	reply := Reply{Outcome: OutcomeError}
	reply.Body = Sanitize(reply.Body, maxReplyRunes)
	j.Deliver(reply, ErrShuttingDown)
}

func (g *Generator) run(j Job) {
	settings := g.resolve().Merge(j.Profile)

	p, ok := g.providers[settings.Provider]
	if !ok {
		g.logger.Warn("chat: unknown provider", "provider", settings.Provider,
			"profile", j.Profile.ScreenName)
		// Sanitize here too, even though Body is always empty on this path
		// today: no Deliver call, including this one, is exempt from the
		// "never deliver raw model output" invariant.
		errReply := Reply{Outcome: OutcomeError}
		errReply.Body = Sanitize(errReply.Body, maxReplyRunes)
		j.Deliver(errReply, ErrNoProvider)
		return
	}

	// Redact BEFORE Compose. Redact is advisory -- Compose accepts raw
	// []Passage -- so this is the only thing standing between a
	// sensitivity:"do_not_discuss" row and the model. Every tier goes through
	// it, not just the curated one.
	in := ComposeInput{
		Profile:       j.Profile,
		Phase:         j.Phase,
		Digest:        Redact(j.Digest),
		Recent:        Redact(j.Recent),
		Timeline:      Redact(j.Timeline),
		History:       j.History,
		VirtualTime:   j.VirtualTime,
		UserMessage:   j.Body,
		SelfInitiated: j.SelfInitiated,
	}

	reply, err := p.Generate(context.Background(), Request{
		Segments:    Compose(in),
		Model:       settings.Model,
		MaxTokens:   settings.MaxTokens,
		Effort:      settings.Effort,
		Temperature: settings.Temperature,
	})

	// Sanitise inside the worker, not at the call site: no path can deliver
	// raw model output, including the error and refusal paths.
	reply.Body = Sanitize(reply.Body, maxReplyRunes)
	j.Deliver(reply, err)
}

// resolve returns the current global settings, re-reading chat_settings at most
// once every ttl. A single-row indexed query is negligible beside a
// multi-second provider call, and caching it forever would mean a settings
// change needed a restart -- which is exactly what this feature exists to
// avoid. A nil pool means reload is disabled entirely: the seeded settings are
// returned for the generator's lifetime.
func (g *Generator) resolve() Settings {
	g.mu.Lock()
	defer g.mu.Unlock()

	if g.pool == nil {
		return g.settings
	}
	if time.Since(g.settingsAt) < g.settingsTTL {
		return g.settings
	}
	s, err := LoadSettings(context.Background(), g.pool)
	if err != nil {
		// Keep serving on the last good value; a settings blip must not
		// silence every buddy.
		g.logger.Warn("chat: settings reload failed, using cached", "err", err)
		g.settingsAt = time.Now()
		return g.settings
	}
	g.settings, g.settingsAt = s, time.Now()
	return s
}
