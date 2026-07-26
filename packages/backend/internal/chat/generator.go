package chat

import (
	"context"
	"errors"
	"log/slog"
	"sync"
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
	Deliver     func(Reply, error)
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
		settings:    settings,
		settingsAt:  time.Now(),
		settingsTTL: settingsTTL,
	}

	g.wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer g.wg.Done()
			for j := range g.jobs {
				g.run(j)
			}
		}()
	}
	return g
}

// Enqueue submits a job for generation. It never blocks: the caller is the
// session goroutine, and a full queue must become an in-character stall
// upstream rather than a stalled media stream.
func (g *Generator) Enqueue(j Job) bool {
	select {
	case g.jobs <- j:
		return true
	default:
		return false
	}
}

// Close stops accepting new jobs and waits for in-flight ones to finish.
func (g *Generator) Close() {
	close(g.jobs)
	g.wg.Wait()
}

func (g *Generator) run(j Job) {
	settings := g.resolve().Merge(j.Profile)

	p, ok := g.providers[settings.Provider]
	if !ok {
		g.logger.Warn("chat: unknown provider", "provider", settings.Provider,
			"profile", j.Profile.ScreenName)
		j.Deliver(Reply{Outcome: OutcomeError}, ErrNoProvider)
		return
	}

	// Redact BEFORE Compose. Redact is advisory -- Compose accepts raw
	// []Passage -- so this is the only thing standing between a
	// sensitivity:"do_not_discuss" row and the model. Every tier goes through
	// it, not just the curated one.
	in := ComposeInput{
		Profile:     j.Profile,
		Phase:       j.Phase,
		Digest:      Redact(j.Digest),
		Recent:      Redact(j.Recent),
		Timeline:    Redact(j.Timeline),
		History:     j.History,
		VirtualTime: j.VirtualTime,
		UserMessage: j.Body,
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
