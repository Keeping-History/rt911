package session

import (
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

// Hub manages all active sessions and drives the global 1-second clock tick.
// It dispatches ticks to each session's tickCh without blocking on slow sessions.
type Hub struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	reg      chan *Session
	unreg    chan *Session
	logger   *slog.Logger

	// Load-shedding: maxSessions caps concurrently-admitted connections; 0 means
	// unlimited. active is the live count, maintained synchronously by
	// TryAcquire/Release — not the sessions map, which Run updates asynchronously
	// and so lags admission under a burst (the exact moment the cap must hold).
	maxSessions int64
	active      atomic.Int64
}

func NewHub(logger *slog.Logger, maxSessions int) *Hub {
	return &Hub{
		sessions:    make(map[string]*Session),
		reg:         make(chan *Session, 64),
		unreg:       make(chan *Session, 64),
		logger:      logger,
		maxSessions: int64(maxSessions),
	}
}

// TryAcquire reserves one connection slot for load-shedding. It returns false when
// the hub is at capacity (maxSessions > 0 and already full); the caller must then
// reject the connection and MUST NOT call Release. On success the caller owns one
// slot and MUST call Release exactly once when the connection ends.
//
// It increments first and rolls back on overflow: concurrent callers that
// transiently overshoot the cap are each rejected, so the admitted count never
// settles above maxSessions — no lock needed.
func (h *Hub) TryAcquire() bool {
	n := h.active.Add(1)
	if h.maxSessions > 0 && n > h.maxSessions {
		h.active.Add(-1)
		return false
	}
	return true
}

// Release returns a slot reserved by a successful TryAcquire.
func (h *Hub) Release() { h.active.Add(-1) }

// Active reports the number of currently-admitted connections.
func (h *Hub) Active() int64 { return h.active.Load() }

func (h *Hub) Register(s *Session) {
	h.reg <- s
}

func (h *Hub) Unregister(s *Session) {
	h.unreg <- s
}

// Run is the hub's main loop. Call it in a dedicated goroutine.
func (h *Hub) Run() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			h.mu.RLock()
			for _, s := range h.sessions {
				// Non-blocking: if the session is busy processing the previous tick, skip.
				select {
				case s.tickCh <- struct{}{}:
				default:
				}
			}
			h.mu.RUnlock()

		case s := <-h.reg:
			h.mu.Lock()
			h.sessions[s.id] = s
			total := len(h.sessions)
			h.mu.Unlock()
			h.logger.Info("session joined", "id", s.id, "total", total)

		case s := <-h.unreg:
			h.mu.Lock()
			delete(h.sessions, s.id)
			total := len(h.sessions)
			h.mu.Unlock()
			h.logger.Info("session left", "id", s.id, "total", total)
		}
	}
}
