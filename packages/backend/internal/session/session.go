package session

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"classicy/streamer/internal/cache"
	"classicy/streamer/internal/model"

	goredis "github.com/redis/go-redis/v9"
)

const (
	sendBuf     = 256
	driftThresh = 3 * time.Second
)

// ChannelPager is the opt-in subscription channel for pager items. News, MP3,
// and HTML channels are planned and will be added alongside it.
const ChannelPager = "pager"

// outMsg is the envelope for every server→client message.
type outMsg struct {
	Type    string            `json:"type"`
	Time    string            `json:"time,omitempty"`
	Channel string            `json:"channel,omitempty"`
	Items   []model.MediaItem `json:"items,omitempty"`
	Pager   []model.PagerItem `json:"pager,omitempty"`
	Msg     string            `json:"message,omitempty"`
}

// Session holds all state for a single connected client.
type Session struct {
	id     string
	hub    *Hub
	rdb    *goredis.Client
	logger *slog.Logger

	mu            sync.Mutex
	virtualTime   time.Time
	paused        bool
	formatFilter  map[string]struct{} // nil = send all formats
	subscriptions map[string]struct{} // opt-in delivery channels (e.g. "pager")

	send      chan []byte
	tickCh    chan struct{}
	done      chan struct{}
	closeOnce sync.Once
}

func NewSession(hub *Hub, rdb *goredis.Client, logger *slog.Logger) *Session {
	id := newID()
	return &Session{
		id:     id,
		hub:    hub,
		rdb:    rdb,
		logger: logger.With("session", id),
		send:   make(chan []byte, sendBuf),
		tickCh: make(chan struct{}, 1),
		done:   make(chan struct{}),
	}
}

// Done returns a channel that is closed when the session ends.
func (s *Session) Done() <-chan struct{} { return s.done }

// Send returns the outbound message channel for the writePump.
func (s *Session) Send() <-chan []byte { return s.send }

// Close terminates the session exactly once.
func (s *Session) Close() {
	s.closeOnce.Do(func() {
		close(s.done)
		s.hub.Unregister(s)
	})
}

// SetFormatFilter sets the format whitelist for this session. A nil slice
// means all formats are delivered (no filter).
func (s *Session) SetFormatFilter(formats []string) {
	s.mu.Lock()
	if formats == nil {
		s.formatFilter = nil
	} else {
		ff := make(map[string]struct{}, len(formats))
		for _, f := range formats {
			ff[f] = struct{}{}
		}
		s.formatFilter = ff
	}
	s.mu.Unlock()
	s.send_(outMsg{Type: "filter_ack"})
}

// applyFormatFilter returns only items whose format matches the session's
// whitelist. If no filter is set, all items are returned unchanged.
func (s *Session) applyFormatFilter(items []model.MediaItem) []model.MediaItem {
	s.mu.Lock()
	ff := s.formatFilter
	s.mu.Unlock()

	if ff == nil {
		return items
	}
	out := make([]model.MediaItem, 0, len(items))
	for _, it := range items {
		if _, ok := ff[it.Format]; ok {
			out = append(out, it)
		}
	}
	return out
}

// Subscribe opts this session into delivery for the named channel and acks.
// Channels are opt-in side streams (currently "pager"; news/mp3/html are
// planned). For channels that carry a snapshot, the caller (handler) sends the
// initial batch, since that requires a Postgres query.
func (s *Session) Subscribe(channel string) {
	s.mu.Lock()
	if s.subscriptions == nil {
		s.subscriptions = make(map[string]struct{})
	}
	s.subscriptions[channel] = struct{}{}
	s.mu.Unlock()
	s.send_(outMsg{Type: "subscribe_ack", Channel: channel})
}

// Unsubscribe stops delivery for the named channel and acks.
func (s *Session) Unsubscribe(channel string) {
	s.mu.Lock()
	delete(s.subscriptions, channel)
	s.mu.Unlock()
	s.send_(outMsg{Type: "unsubscribe_ack", Channel: channel})
}

// Subscribed reports whether this session currently receives the named channel.
func (s *Session) Subscribed(channel string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.subscriptions[channel]
	return ok
}

// VirtualTime returns the session's current virtual time. ok is false before
// the session has been initialised (virtual time still zero).
func (s *Session) VirtualTime() (t time.Time, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.virtualTime, !s.virtualTime.IsZero()
}

// SendPager delivers a batch of pager items at time t. No frame is sent for an
// empty batch — silence is meaningful, exactly as with media items frames.
func (s *Session) SendPager(t time.Time, items []model.PagerItem) {
	if len(items) == 0 {
		return
	}
	s.send_(outMsg{Type: "pager", Time: t.Format(time.RFC3339), Pager: items})
}

// Init sets the client's starting virtual time and sends the initial snapshot.
func (s *Session) Init(t time.Time, items []model.MediaItem) {
	s.mu.Lock()
	s.virtualTime = t
	s.paused = false
	s.mu.Unlock()

	s.send_(outMsg{Type: "init_ack", Time: t.Format(time.RFC3339), Items: s.applyFormatFilter(items)})
}

// Seek moves the client's virtual clock to t and delivers the full set of
// items that are active at that time so the client can resync immediately.
func (s *Session) Seek(t time.Time, items []model.MediaItem) {
	s.mu.Lock()
	s.virtualTime = t
	s.mu.Unlock()
	s.send_(outMsg{Type: "seek_ack", Time: t.Format(time.RFC3339), Items: s.applyFormatFilter(items)})
}

// Pause freezes the client's virtual clock.
func (s *Session) Pause() {
	s.mu.Lock()
	s.paused = true
	s.mu.Unlock()
	s.send_(outMsg{Type: "pause_ack"})
}

// Resume unfreezes the client's virtual clock.
func (s *Session) Resume() {
	s.mu.Lock()
	s.paused = false
	s.mu.Unlock()
	s.send_(outMsg{Type: "resume_ack"})
}

// Heartbeat corrects drift if the client's reported time diverges too far.
func (s *Session) Heartbeat(clientTime time.Time) {
	s.mu.Lock()
	if drift := abs(clientTime.Sub(s.virtualTime)); drift > driftThresh {
		s.logger.Info("correcting drift", "drift", drift)
		s.virtualTime = clientTime
	}
	t := s.virtualTime
	s.mu.Unlock()

	s.send_(outMsg{Type: "heartbeat_ack", Time: t.Format(time.RFC3339)})
}

// SendError delivers an error message to the client.
func (s *Session) SendError(msg string) {
	s.send_(outMsg{Type: "error", Msg: msg})
}

// RunTimePump advances virtual time on each hub tick and dispatches new items.
// Call in a dedicated goroutine.
func (s *Session) RunTimePump() {
	ctx := context.Background()
	for {
		select {
		case <-s.done:
			return
		case <-s.tickCh:
			s.mu.Lock()
			if s.paused || s.virtualTime.IsZero() {
				s.mu.Unlock()
				continue
			}
			s.virtualTime = s.virtualTime.Add(time.Second)
			t := s.virtualTime
			s.mu.Unlock()

			items, err := cache.ItemsAt(ctx, s.rdb, t)
			if err != nil {
				s.logger.Warn("cache lookup failed", "error", err)
			} else {
				filtered := s.applyFormatFilter(items)
				if len(filtered) > 0 {
					s.send_(outMsg{Type: "items", Time: t.Format(time.RFC3339), Items: filtered})
				}
			}

			// Pager items ride a separate Redis cache and an opt-in channel, so
			// the media tick above never scans the large pager set.
			if s.Subscribed(ChannelPager) {
				pagerItems, err := cache.PagerItemsAt(ctx, s.rdb, t)
				if err != nil {
					s.logger.Warn("pager cache lookup failed", "error", err)
					continue
				}
				s.SendPager(t, pagerItems)
			}
		}
	}
}

func (s *Session) send_(m outMsg) {
	// Don't write to a closed session.
	select {
	case <-s.done:
		return
	default:
	}

	data, err := json.Marshal(m)
	if err != nil {
		return
	}

	select {
	case s.send <- data:
	case <-s.done:
	default:
		s.logger.Warn("send buffer full, dropping message", "type", m.Type)
	}
}

func newID() string {
	b := make([]byte, 8)
	rand.Read(b) //nolint:errcheck // crypto/rand never fails on supported platforms
	return hex.EncodeToString(b)
}

func abs(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}
