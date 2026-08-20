package session

import (
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
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
	hub := NewHub(logger, 0) // 0 = unlimited; admission caps are tested separately
	go hub.Run()
	return hub
}

func discardHub(maxSessions int) *Hub {
	return NewHub(slog.New(slog.NewTextHandler(io.Discard, nil)), maxSessions)
}

// TestHubTryAcquireUnlimited: with maxSessions=0 the hub admits without bound and
// still tracks the live count via Active.
func TestHubTryAcquireUnlimited(t *testing.T) {
	hub := discardHub(0)
	for i := 0; i < 1000; i++ {
		if !hub.TryAcquire() {
			t.Fatalf("unlimited hub rejected acquire #%d", i)
		}
	}
	if got := hub.Active(); got != 1000 {
		t.Fatalf("Active() = %d, want 1000", got)
	}
}

// TestHubTryAcquireEnforcesCap: admits exactly maxSessions, then rejects — and a
// rejected acquire must not leak a slot (rolled back), or the pod would wedge
// below its real capacity forever.
func TestHubTryAcquireEnforcesCap(t *testing.T) {
	const limit = 3
	hub := discardHub(limit)
	for i := 0; i < limit; i++ {
		if !hub.TryAcquire() {
			t.Fatalf("acquire #%d rejected below cap", i)
		}
	}
	if hub.TryAcquire() {
		t.Fatal("acquire above cap should have been rejected")
	}
	if got := hub.Active(); got != limit {
		t.Fatalf("Active() = %d, want %d (rejected acquire leaked a slot)", got, limit)
	}
}

// TestHubReleaseFreesSlot: a released slot is reusable, so a churning pod keeps
// serving instead of latching at capacity after the first cohort disconnects.
func TestHubReleaseFreesSlot(t *testing.T) {
	hub := discardHub(1)
	if !hub.TryAcquire() {
		t.Fatal("first acquire rejected")
	}
	if hub.TryAcquire() {
		t.Fatal("second acquire should be rejected at cap 1")
	}
	hub.Release()
	if !hub.TryAcquire() {
		t.Fatal("acquire after release rejected — slot not freed")
	}
}

// TestHubTryAcquireConcurrentNeverExceedsCap: the whole point of load-shedding is
// that a *burst* can't breach the cap. Race many concurrent acquires against a
// small limit and assert exactly `limit` win. Run with -race.
func TestHubTryAcquireConcurrentNeverExceedsCap(t *testing.T) {
	const limit = 50
	hub := discardHub(limit)
	var admitted atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 500; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if hub.TryAcquire() {
				admitted.Add(1)
			}
		}()
	}
	wg.Wait()
	if got := admitted.Load(); got != limit {
		t.Fatalf("admitted %d, want exactly %d", got, limit)
	}
	if got := hub.Active(); got != limit {
		t.Fatalf("Active() = %d, want %d", got, limit)
	}
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
