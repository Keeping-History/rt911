package session

import (
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"classicy/streamer/internal/chat"
	"classicy/streamer/internal/clock"
	"classicy/streamer/internal/model"
)

// Hub manages all active sessions and drives the global 1-second clock tick.
// It dispatches ticks to each session's tickCh without blocking on slow sessions.
type Hub struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	reg      chan *Session
	unreg    chan *Session
	logger   *slog.Logger

	// master is the optional process-wide forced clock (nil when the feature
	// is disabled). Set once at boot via SetMaster; reads are nil-safe.
	master *clock.MasterClock

	// gen is the optional process-wide chat reply engine (nil when no provider
	// has a configured API key). Set once at boot via SetGenerator, mirroring
	// SetMaster; reads are nil-safe via Generator, and a nil generator degrades
	// ChatSend to the same in-character stall as a full queue, never an error.
	gen *chat.Generator

	// Load-shedding: maxSessions caps concurrently-admitted connections; 0 means
	// unlimited. active is the live count, maintained synchronously by
	// TryAcquire/Release — not the sessions map, which Run updates asynchronously
	// and so lags admission under a burst (the exact moment the cap must hold).
	maxSessions int64
	active      atomic.Int64

	// roomsMu guards roomStates: the last-known control state per room, fed by
	// BroadcastRoom and replayed to a session on JoinRoom. Its own mutex, not
	// h.mu — recording state must never contend with the tick fan-out, and
	// keeping the two separate means no lock ordering to get wrong.
	roomsMu    sync.Mutex
	roomStates map[string]*roomState
}

// roomState is the last-known control state for one room — exactly what a
// student who joins (or reconnects) late must still observe. Only the sticky
// actions are kept: a jump and a lock describe where the class *is*, and a
// reload marks that the published definition changed since page load. Focus
// and message are moments, not state, and are deliberately not replayed.
//
// The memory is per pod, fed by the fanout bus (every pod sees every publish,
// including its own), so all live pods converge; a pod that boots later starts
// empty and catches up on the teacher's next command. Entries are one command
// per action and keys are playlist ids that an authorised owner drove, so the
// map is bounded by real use — there is no client-controlled growth to prune.
type roomState struct {
	jump   *model.RoomCommand
	lock   *model.RoomCommand
	reload *model.RoomCommand
}

func NewHub(logger *slog.Logger, maxSessions int) *Hub {
	return &Hub{
		sessions:    make(map[string]*Session),
		reg:         make(chan *Session, 64),
		unreg:       make(chan *Session, 64),
		logger:      logger,
		maxSessions: int64(maxSessions),
		roomStates:  make(map[string]*roomState),
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

// SetMaster wires the forced master clock. Call once at boot, before Run.
func (h *Hub) SetMaster(m *clock.MasterClock) { h.master = m }

// SetGenerator wires the chat reply engine. Call once at boot; leaving it
// unset (a missing API key, checked non-fatally in cmd/server/main.go) is the
// normal way chat ships disabled while media streaming continues.
func (h *Hub) SetGenerator(g *chat.Generator) { h.gen = g }

// Generator returns the process-wide chat reply engine, or nil when chat is
// unconfigured.
func (h *Hub) Generator() *chat.Generator { return h.gen }

// MasterNow returns the forced master time, or false when the feature is
// disabled or inactive.
func (h *Hub) MasterNow() (time.Time, bool) {
	if h.master == nil {
		return time.Time{}, false
	}
	return h.master.Now()
}

// BroadcastClock pushes the forced-clock state to every connected session.
// RLock + non-blocking send_ per session — same discipline as the tick loop.
func (h *Hub) BroadcastClock(st clock.State) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, s := range h.sessions {
		if st.Active {
			s.SendClock(true, st.NowAt(time.Now().UTC()))
		} else {
			s.SendClock(false, time.Time{})
		}
	}
}

// BroadcastAlert pushes an operator alert to every session on this pod that is
// subscribed to the alerts channel. Only this pod's sessions — the caller is
// the fan-out subscriber (see internal/fanout), which is what carries the alert
// to the other pods' hubs.
//
// RLock + non-blocking send_ per session, the same discipline as the tick loop
// and BroadcastClock.
func (h *Hub) BroadcastAlert(item model.AlertItem) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, s := range h.sessions {
		s.PushAlert(item)
	}
}

// BroadcastRoom relays a teacher command to this pod's sessions in cmd.Room.
// A blank room matches nothing — it would otherwise address every session not
// following a playlist, which is the opposite of what an unset field means.
//
// Same RLock + non-blocking send_ discipline as the tick loop. The command is
// also recorded as the room's last-known state (see roomState) so a student
// who joins after it was sent still converges — the fanout bus delivers this
// call on every pod, so the record happens everywhere, even on pods with no
// member session at the time.
func (h *Hub) BroadcastRoom(cmd model.RoomCommand) {
	if cmd.Room == "" {
		return
	}
	h.recordRoomState(cmd)
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, s := range h.sessions {
		if s.Room() == cmd.Room {
			s.SendRoomCommand(cmd)
		}
	}
}

// recordRoomState keeps the sticky actions (jump/lock/reload) as the room's
// last-known state. Focus and message are transient and intentionally skipped.
func (h *Hub) recordRoomState(cmd model.RoomCommand) {
	var slot func(*roomState) **model.RoomCommand
	switch cmd.Action {
	case model.RoomActionJump:
		slot = func(st *roomState) **model.RoomCommand { return &st.jump }
	case model.RoomActionLock:
		slot = func(st *roomState) **model.RoomCommand { return &st.lock }
	case model.RoomActionReload:
		slot = func(st *roomState) **model.RoomCommand { return &st.reload }
	default:
		return
	}
	h.roomsMu.Lock()
	defer h.roomsMu.Unlock()
	st := h.roomStates[cmd.Room]
	if st == nil {
		st = &roomState{}
		h.roomStates[cmd.Room] = st
	}
	c := cmd
	*slot(st) = &c
}

// RoomState returns the commands a fresh member of room must replay to catch
// up, in application order: jump first (put the clock where the class is),
// then lock (pin it there), then reload (pick up a mid-class definition push).
// The order also means a replayed reload cannot be undone by a stale clock
// move landing after it. Empty when the room has no recorded state.
func (h *Hub) RoomState(room string) []model.RoomCommand {
	h.roomsMu.Lock()
	defer h.roomsMu.Unlock()
	st := h.roomStates[room]
	if st == nil {
		return nil
	}
	out := make([]model.RoomCommand, 0, 3)
	for _, c := range []*model.RoomCommand{st.jump, st.lock, st.reload} {
		if c != nil {
			out = append(out, *c)
		}
	}
	return out
}

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
