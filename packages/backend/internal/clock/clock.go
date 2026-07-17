// Package clock owns forced-clock-mode state: an operator-set master clock
// that every session is slaved to while active. State is persisted in Redis
// (survives pod restarts) and fanned out across pods via pub/sub.
package clock

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	goredis "github.com/redis/go-redis/v9"
)

const (
	redisKey     = "clock:master"
	redisChannel = "clock:master:changed"
)

// State is the persisted master-clock state. Current master time is
// VirtualAt + (wallNow − WallAt): two anchors, no ticker, drift-free.
type State struct {
	Active    bool      `json:"active"`
	VirtualAt time.Time `json:"virtual_at"`
	WallAt    time.Time `json:"wall_at"`
}

// NowAt returns the master virtual time at the given wall-clock instant.
func (st State) NowAt(wall time.Time) time.Time {
	return st.VirtualAt.Add(wall.Sub(st.WallAt))
}

func (st State) equal(other State) bool {
	return st.Active == other.Active &&
		st.VirtualAt.Equal(other.VirtualAt) &&
		st.WallAt.Equal(other.WallAt)
}

// MasterClock holds the in-process snapshot behind a mutex; Redis is the
// cross-process source of truth.
type MasterClock struct {
	rdb    *goredis.Client
	logger *slog.Logger

	mu sync.RWMutex
	st State

	// onChange fires after every applied state change (local Set/Release,
	// boot Load of an active state, or a pub/sub apply). The Hub hooks this
	// to broadcast a clock frame. Set once, before Load/Run.
	onChange func(State)
}

func New(rdb *goredis.Client, logger *slog.Logger) *MasterClock {
	return &MasterClock{rdb: rdb, logger: logger}
}

func (m *MasterClock) OnChange(fn func(State)) { m.onChange = fn }

// Now returns the current master time and whether forced mode is active.
func (m *MasterClock) Now() (time.Time, bool) {
	m.mu.RLock()
	st := m.st
	m.mu.RUnlock()
	if !st.Active {
		return time.Time{}, false
	}
	return st.NowAt(time.Now().UTC()), true
}

func (m *MasterClock) Snapshot() State {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.st
}

// Set enables forced mode at master time t (or jumps an already-active one).
func (m *MasterClock) Set(ctx context.Context, t time.Time) error {
	return m.apply(ctx, State{Active: true, VirtualAt: t.UTC(), WallAt: time.Now().UTC()})
}

// Release disables forced mode. Clients keep ticking from wherever the
// master left them; nothing jumps back.
func (m *MasterClock) Release(ctx context.Context) error {
	return m.apply(ctx, State{Active: false})
}

func (m *MasterClock) apply(ctx context.Context, st State) error {
	data, err := json.Marshal(st)
	if err != nil {
		return err
	}
	if err := m.rdb.Set(ctx, redisKey, data, 0).Err(); err != nil {
		return err
	}
	// Round-trip through JSON so the local copy matches what subscribers
	// decode (strips the monotonic wall-clock reading; keeps the setLocal
	// dedupe honest when our own publish echoes back).
	var canonical State
	if err := json.Unmarshal(data, &canonical); err != nil {
		return err
	}
	m.setLocal(canonical)
	// Publish failure is non-fatal: this pod has already applied and
	// broadcast; other pods recover on their next boot Load.
	if err := m.rdb.Publish(ctx, redisChannel, data).Err(); err != nil {
		m.logger.Warn("master clock publish failed", "error", err)
	}
	return nil
}

func (m *MasterClock) setLocal(st State) {
	m.mu.Lock()
	same := m.st.equal(st)
	m.st = st
	m.mu.Unlock()
	if same || m.onChange == nil {
		return
	}
	m.onChange(st)
}

// Load reads persisted state at boot so a restart mid-session stays forced.
func (m *MasterClock) Load(ctx context.Context) error {
	data, err := m.rdb.Get(ctx, redisKey).Bytes()
	if err == goredis.Nil {
		return nil
	}
	if err != nil {
		return err
	}
	var st State
	if err := json.Unmarshal(data, &st); err != nil {
		return err
	}
	m.setLocal(st)
	return nil
}

// Run applies published state changes for the process lifetime. go-redis
// PubSub reconnects internally; the loop exits when ctx is canceled.
func (m *MasterClock) Run(ctx context.Context) {
	sub := m.rdb.Subscribe(ctx, redisChannel)
	defer sub.Close()
	go func() { <-ctx.Done(); sub.Close() }()
	for msg := range sub.Channel() {
		var st State
		if err := json.Unmarshal([]byte(msg.Payload), &st); err != nil {
			m.logger.Warn("bad master clock notification", "payload", msg.Payload, "error", err)
			continue
		}
		m.setLocal(st)
	}
}
