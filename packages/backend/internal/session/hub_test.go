package session

import (
	"io"
	"log/slog"
	"testing"
	"time"
)

// waitSessions polls until the hub's session count reaches want or times out.
func waitSessions(t *testing.T, h *Hub, want int) {
	t.Helper()
	deadline := time.Now().Add(200 * time.Millisecond)
	for time.Now().Before(deadline) {
		h.mu.RLock()
		n := len(h.sessions)
		h.mu.RUnlock()
		if n == want {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	h.mu.RLock()
	n := len(h.sessions)
	h.mu.RUnlock()
	t.Fatalf("timeout waiting for %d sessions, got %d", want, n)
}

func newTestHub(t *testing.T) *Hub {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	hub := NewHub(logger)
	go hub.Run()
	return hub
}

func TestHubRegisterAddsSession(t *testing.T) {
	hub := newTestHub(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	sess := NewSession(hub, nil, nil, logger)
	hub.Register(sess)
	waitSessions(t, hub, 1)

	hub.mu.RLock()
	_, ok := hub.sessions[sess.id]
	hub.mu.RUnlock()
	if !ok {
		t.Fatal("registered session not found in hub.sessions")
	}
}

func TestHubUnregisterRemovesSession(t *testing.T) {
	hub := newTestHub(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	sess := NewSession(hub, nil, nil, logger)
	hub.Register(sess)
	waitSessions(t, hub, 1)

	hub.Unregister(sess)
	waitSessions(t, hub, 0)
}

func TestHubRegisterMultipleSessions(t *testing.T) {
	hub := newTestHub(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	const n = 5
	for i := 0; i < n; i++ {
		hub.Register(NewSession(hub, nil, nil, logger))
	}
	waitSessions(t, hub, n)
}

// TestHubNonBlockingOnSlowSession verifies that a session with a full tickCh
// does not stall the hub's tick fan-out. The hub uses a non-blocking send
// (select { case: default: }) so a slow session is silently skipped.
func TestHubNonBlockingOnSlowSession(t *testing.T) {
	hub := newTestHub(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	slow := NewSession(hub, nil, nil, logger)
	slow.tickCh <- struct{}{} // fill the buffer to simulate a slow session
	hub.Register(slow)
	waitSessions(t, hub, 1)

	// Wait for the hub ticker to fire (1s interval) and exercise the default branch.
	time.Sleep(1500 * time.Millisecond)

	// Hub must still be alive: register a second session successfully.
	fast := NewSession(hub, nil, nil, logger)
	hub.Register(fast)
	waitSessions(t, hub, 2)
}
