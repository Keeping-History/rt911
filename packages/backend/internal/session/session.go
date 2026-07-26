package session

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"sync"
	"time"

	"classicy/streamer/internal/cache"
	"classicy/streamer/internal/chat"
	"classicy/streamer/internal/db"
	"classicy/streamer/internal/model"

	"github.com/jackc/pgx/v5/pgxpool"
	goredis "github.com/redis/go-redis/v9"
	"github.com/vmihailenco/msgpack/v5"
)

const (
	sendBuf     = 256
	driftThresh = 3 * time.Second
)

// Opt-in subscription channels. Each is a side stream a session must subscribe
// to; nothing on a channel is delivered by default. HTML is planned.
const (
	ChannelPager   = "pager"
	ChannelMp3     = "mp3"
	ChannelNews    = "news"
	ChannelUsenet  = "usenet"
	ChannelFlights = "flights"
	ChannelWeather = "weather"
	ChannelAlerts  = "alerts"
	ChannelChat    = "chat"
)

// Look-ahead windowing. Instead of one Redis lookup + frame per virtual second,
// each channel refills a forward window of items in a single range query and the
// client reveal-gates them by its virtual clock. This cuts Redis lookups from
// 1/second to ~1/window per channel and de-syncs the per-tick burst — the failure
// mode at thousands of spread (unpinned) sessions.
//
// Windows are per-channel: dense media uses a shorter window; sparse instant
// channels (pager/news) use a longer one to refill even less often. leadSeconds
// is the shared headroom — a channel refills this far before its buffer drains so
// the client never starves. Data is immutable historical, so window size is
// bounded only by client buffer memory, not freshness.
const (
	leadSeconds = 30 * time.Second
	windowMedia = 300 * time.Second
	windowPager = 600 * time.Second
	// mp3/radio is sparse (a handful of durational clips per window) and the
	// Radio app surfaces this window as its "Coming Up" schedule, so it gets a
	// deliberately long look-ahead — 10× the dense-media window — to fill that
	// list well ahead of the clock. Data is immutable historical, so the only
	// cost is a slightly larger, less frequent refill frame (still tiny for mp3).
	windowMp3    = 3000 * time.Second
	windowNews   = 600 * time.Second
	windowUsenet = 600 * time.Second
	// flights are dense — ~600-900 airborne rows/min — so they get media's
	// shorter window, keeping refill frames at ~300-450 KB.
	windowFlights = 300 * time.Second
	// weather is sparse (hourly obs per station, occasional forecast products),
	// so it gets usenet/news scale rather than flights' shorter window.
	windowWeather = 600 * time.Second
	// alerts are rare and instant; reuse the news window.
	windowAlert = 600 * time.Second
)

// pgTickTimeout bounds a single windowed Postgres read on the tick path — the
// usenet and weather channels' DB dependency (hard rule #4 exception). A slow
// query is abandoned rather than allowed to pile up tick after tick.
const pgTickTimeout = 5 * time.Second

// SourceList carries the time-independent set of selectable sources for each
// client-side filter. The sources table does not record which media type a source
// belongs to, so each list is derived from actual usage in its table.
type SourceList struct {
	Video  []string                `json:"video"`  // TV: sources of approved m3u8 media items
	Audio  []string                `json:"audio"`  // RadioScanner: sources of approved mp3 items
	Pager  []string                `json:"pager"`  // Pager: providers of approved pager items
	Usenet []model.NewsgroupSource `json:"usenet"` // Newsgroups: name + precomputed message count
}

// outMsg is the envelope for every server→client message.
type outMsg struct {
	Type    string                 `json:"type"`
	Time    string                 `json:"time,omitempty"`
	Channel string                 `json:"channel,omitempty"`
	Items   []model.MediaItem      `json:"items,omitempty"`
	Pager   []model.PagerItem      `json:"pager,omitempty"`
	Usenet  []model.UsenetItem     `json:"usenet,omitempty"`
	Flights []model.FlightPosition `json:"flights,omitempty"`
	// Weather/WeatherForecasts carry the weather channel's tick batch
	// (SendWeather) and the on-demand weather_forecast reply (SendWeatherForecast).
	Weather          []model.WeatherObservation `json:"weather,omitempty"`
	WeatherForecasts []model.WeatherForecast    `json:"weather_forecasts,omitempty"`
	// Alerts carries the alerts channel's tick batch (SendAlerts). It rides its
	// own field rather than Items because AlertItem carries Severity, which
	// MediaItem lacks.
	Alerts  []model.AlertItem `json:"alerts,omitempty"`
	Sources *SourceList       `json:"sources,omitempty"`
	Msg     string            `json:"message,omitempty"`
	// ID/Body carry a single on-demand item body — a Usenet article (usenet_body)
	// or a news article (news_body). Both frames share these fields.
	ID   int    `json:"id,omitempty"`
	Body string `json:"body,omitempty"`
	// Done marks the final chunk of a flights_history reply (the ID field above
	// doubles as the echoed request id on those frames).
	Done bool `json:"done,omitempty"`
	// Forced-clock mode (see internal/clock): "clock" frames carry Active
	// (+Time while active); heartbeat_ack carries MasterTime while forced.
	Active     *bool  `json:"active,omitempty"`
	MasterTime string `json:"master_time,omitempty"`
	// Chat channel. Enabled/Reason ride chat_state; Buddies rides chat_roster;
	// Profile/Online ride chat_presence. Enabled and Online are pointers so a
	// false value is transmitted rather than dropped by omitempty. Direction,
	// Kind, and MessageID ride chat_typing/chat_message: Direction is "in"
	// (student) or "out" (buddy), Kind mirrors chat_messages.kind ("typed",
	// "generated", "stall", ...), and MessageID echoes the persisted
	// chat_messages.id (0 when persistence was skipped, e.g. no pool).
	Enabled   *bool         `json:"enabled,omitempty"`
	Reason    string        `json:"reason,omitempty"`
	Buddies   []model.Buddy `json:"buddies,omitempty"`
	Profile   int           `json:"profile,omitempty"`
	Online    *bool         `json:"online,omitempty"`
	Direction string        `json:"direction,omitempty"`
	Kind      string        `json:"kind,omitempty"`
	MessageID int           `json:"message_id,omitempty"`
}

// Session holds all state for a single connected client.
type Session struct {
	id  string
	hub *Hub
	rdb *goredis.Client
	// pool backs the usenet and weather channels: usenet messages are too large to
	// cache in Redis, and weather data is sparse enough that a Redis cache isn't
	// worth building, so both read Postgres directly on the tick (see
	// UsenetItemsInRange / WeatherObsInRange / WeatherForecastsInRange). Every
	// other channel uses Redis via the tick path (hard rule #4).
	pool   *pgxpool.Pool
	logger *slog.Logger

	mu            sync.Mutex
	virtualTime   time.Time
	paused        bool
	formatFilter  map[string]struct{} // nil = send all formats
	subscriptions map[string]struct{} // opt-in delivery channels (e.g. "pager")

	// Per-channel look-ahead high-water marks: the exclusive upper edge of the
	// last window sent on each channel. Channels are subscribed at different
	// times, so each refills independently. All guarded by mu.
	mediaHorizon   time.Time
	pagerHorizon   time.Time
	mp3Horizon     time.Time
	newsHorizon    time.Time
	usenetHorizon  time.Time
	flightsHorizon time.Time
	weatherHorizon time.Time
	alertHorizon   time.Time
	// chatHorizon is the last virtual instant checked for scheduled beats
	// (chat_schedules): each tick evaluates the half-open (chatHorizon,
	// virtualTime] window so a beat fires exactly once as the clock advances.
	// Unlike the other horizons this never triggers a lookup -- schedules is
	// loaded once into memory (SetSchedules) and DueBetween is a pure filter --
	// so there is no window/lead tuning, just the half-open bound itself.
	chatHorizon time.Time

	// usenetGroups is the set of newsgroups the client is currently viewing. The
	// usenet channel is delivered only for these groups — a group can hold millions
	// of messages, so nothing is sent until the client selects one. Guarded by mu.
	usenetGroups map[string]struct{}

	// userID is the authenticated Directus user id ("" = anonymous). profiles is
	// the configured buddy roster, loaded once at connect time. beacons/phases
	// are the emotional-arc configuration (also loaded once, via SetPhaseData)
	// that resolves each profile's Phase for the virtual clock — without them a
	// buddy would render as chat.DefaultPhase all day regardless of the clock.
	// schedules is the proactive-beat configuration (loaded once, via
	// SetSchedules) that RunTimePump checks against chatHorizon each tick.
	// broadcastSources is the reach/market classification (loaded once, via
	// SetBroadcastSources) that decides which transcripts a buddy could have
	// received where they live — a kid in Columbus had cable and the networks,
	// not Channel 5 New York or 1010 WINS.
	// presenceSeen is the last online state sent per buddy id, so
	// syncChatPresence can emit only the buddies whose state actually changed.
	// All guarded by mu.
	userID       string
	profiles     []chat.Profile
	beacons      map[int]chat.Beacon
	phases       map[int][]chat.Phase
	schedules    []chat.Schedule
	bcastSources []chat.BroadcastSource
	presenceSeen map[int]bool

	// recentSends tracks this session's chat_send wall-clock timestamps for
	// CheckLocal's rate limit. Trimmed to chatRateTrimWindow on every send so it
	// cannot grow unbounded across a long connection. Guarded by mu.
	recentSends []time.Time

	send      chan []byte
	tickCh    chan struct{}
	done      chan struct{}
	closeOnce sync.Once
}

func NewSession(hub *Hub, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) *Session {
	id := newID()
	return &Session{
		id:     id,
		hub:    hub,
		rdb:    rdb,
		pool:   pool,
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
	// Refill the media window from the current instant under the new whitelist;
	// the client clears its media buffer so future items selected under the old
	// filter don't surface.
	s.mediaHorizon = s.virtualTime
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
	// Point this channel's horizon at the current instant so its first tick sends
	// a forward window. Before init virtualTime is zero and ticks are no-ops; Init
	// resets all horizons, so a subscribe-before-init is covered there.
	if h := s.horizonFor(channel); h != nil {
		*h = s.virtualTime
	}
	s.mu.Unlock()
	s.send_(outMsg{Type: "subscribe_ack", Channel: channel})
}

// horizonFor returns a pointer to the named channel's horizon, or nil for an
// unknown channel. Caller must hold s.mu.
func (s *Session) horizonFor(channel string) *time.Time {
	switch channel {
	case ChannelPager:
		return &s.pagerHorizon
	case ChannelMp3:
		return &s.mp3Horizon
	case ChannelNews:
		return &s.newsHorizon
	case ChannelUsenet:
		return &s.usenetHorizon
	case ChannelFlights:
		return &s.flightsHorizon
	case ChannelWeather:
		return &s.weatherHorizon
	case ChannelAlerts:
		return &s.alertHorizon
	case ChannelChat:
		return &s.chatHorizon
	}
	return nil
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

// SendMp3 delivers a batch of mp3 items at time t on the mp3 channel. mp3 items
// reuse the MediaItem shape, so the frame reuses the Items field but carries a
// distinct "mp3" type so the client routes it to the Radio app, not the default
// media stream. No frame is sent for an empty batch.
func (s *Session) SendMp3(t time.Time, items []model.MediaItem) {
	if len(items) == 0 {
		return
	}
	s.send_(outMsg{Type: "mp3", Time: t.Format(time.RFC3339), Items: items})
}

// SendMp3History delivers the full past mp3 schedule (every item started by t)
// on the mp3_history frame. Unlike SendMp3, an empty batch IS sent: the client
// replaces its history state wholesale on every frame, so after a backward seek
// an empty frame is what clears out entries from the abandoned timeline.
func (s *Session) SendMp3History(t time.Time, items []model.MediaItem) {
	s.send_(outMsg{Type: "mp3_history", Time: t.Format(time.RFC3339), Items: items})
}

// SendNews delivers a batch of news items at time t on the news channel. Like
// mp3, news reuses the MediaItem shape and the Items field, with a distinct
// "news" type so the client routes it to the News app. No frame for an empty batch.
func (s *Session) SendNews(t time.Time, items []model.MediaItem) {
	if len(items) == 0 {
		return
	}
	s.send_(outMsg{Type: "news", Time: t.Format(time.RFC3339), Items: items})
}

// SendUsenet delivers a batch of Usenet messages at time t on the usenet channel.
// Each message carries its own newsgroup so the client routes it to the right
// group view. No frame is sent for an empty batch.
func (s *Session) SendUsenet(t time.Time, items []model.UsenetItem) {
	if len(items) == 0 {
		return
	}
	s.send_(outMsg{Type: "usenet", Time: t.Format(time.RFC3339), Usenet: items})
}

// SendUsenetBody delivers a single article body in reply to a usenet_body request.
// On success errMsg is "" and body carries the text; on failure errMsg explains why
// and body is empty, letting the client tell "unavailable" apart from an empty body.
// Touches no shared state, so no lock — same shape as the other Send* helpers.
func (s *Session) SendUsenetBody(id int, body, errMsg string) {
	s.send_(outMsg{Type: "usenet_body", ID: id, Body: body, Msg: errMsg})
}

// SendNewsBody delivers a single article body in reply to a news_body request.
// Mirrors SendUsenetBody: on success errMsg is "" and body carries the article
// HTML; on failure errMsg explains why and body is empty, letting the client tell
// "unavailable" apart from an article that is genuinely empty. Touches no shared
// state, so no lock — same shape as the other Send* helpers.
func (s *Session) SendNewsBody(id int, body, errMsg string) {
	s.send_(outMsg{Type: "news_body", ID: id, Body: body, Msg: errMsg})
}

// SendFlights delivers a batch of flight positions at time t on the flights
// channel. Positions are instant per-minute samples like pager items; no frame
// is sent for an empty batch (a minute with nobody airborne is silence).
func (s *Session) SendFlights(t time.Time, items []model.FlightPosition) {
	if len(items) == 0 {
		return
	}
	s.send_(outMsg{Type: "flights", Time: t.Format(time.RFC3339), Flights: items})
}

// SendFlightsHistory delivers one chunk of a flights_history reply, echoing the
// client's request id so chunks of a superseded request can be discarded. Unlike
// SendFlights, the done frame IS sent with an empty batch — it is the completion
// marker the client waits for.
func (s *Session) SendFlightsHistory(reqID int, t time.Time, items []model.FlightPosition, done bool) {
	if len(items) == 0 && !done {
		return
	}
	s.send_(outMsg{Type: "flights_history", ID: reqID, Time: t.Format(time.RFC3339), Flights: items, Done: done})
}

// SendWeather delivers a batch of weather observations and forecasts at time t
// on the weather channel. Sparse data (hourly obs, occasional forecast
// products) rides one frame carrying both lists, following the usenet Postgres
// exception. No frame is sent when both batches are empty.
func (s *Session) SendWeather(t time.Time, obs []model.WeatherObservation, forecasts []model.WeatherForecast) {
	if len(obs) == 0 && len(forecasts) == 0 {
		return
	}
	s.send_(outMsg{Type: "weather", Time: t.Format(time.RFC3339), Weather: obs, WeatherForecasts: forecasts})
}

// SendWeatherForecast delivers a single on-demand forecast lookup for a zone,
// echoing the client's request id. Unlike SendWeather, this always sends —
// even when fc is nil, the client must see an explicit "no forecast for this
// zone" reply (WeatherForecasts empty) rather than silence being ambiguous
// with "still loading."
func (s *Session) SendWeatherForecast(reqID int, t time.Time, fc *model.WeatherForecast) {
	var forecasts []model.WeatherForecast
	if fc != nil {
		forecasts = []model.WeatherForecast{*fc}
	}
	s.send_(outMsg{Type: "weather_forecast", ID: reqID, Time: t.Format(time.RFC3339), WeatherForecasts: forecasts})
}

// SendAlerts delivers a batch of alerts at time t on the alerts channel. Alerts
// reuse the AlertItem shape (MediaItem + severity) and ride their own "alerts"
// frame field so severity survives — Items stays typed []model.MediaItem for
// every other channel. No frame is sent for an empty batch.
func (s *Session) SendAlerts(t time.Time, items []model.AlertItem) {
	if len(items) == 0 {
		return
	}
	s.send_(outMsg{Type: "alerts", Time: t.Format(time.RFC3339), Alerts: items})
}

// SetUsenetGroups replaces the set of newsgroups the client is viewing on the
// usenet channel and acks. Resetting the usenet horizon to the current virtual time
// makes the next tick refill a fresh forward window for the new group(s); the
// handler follows up with a backlog snapshot (messages up to now). An empty set
// means "view nothing" — the channel then delivers no messages, which is the point:
// a group can hold millions of messages, so we never stream one the client isn't
// looking at.
func (s *Session) SetUsenetGroups(groups []string) {
	s.mu.Lock()
	g := make(map[string]struct{}, len(groups))
	for _, name := range groups {
		if name != "" {
			g[name] = struct{}{}
		}
	}
	s.usenetGroups = g
	s.usenetHorizon = s.virtualTime
	s.mu.Unlock()
	s.send_(outMsg{Type: "usenet_filter_ack"})
}

// ActiveUsenetGroups returns the newsgroups the client is currently viewing.
func (s *Session) ActiveUsenetGroups() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.usenetGroupsLocked()
}

// usenetGroupsLocked returns the active newsgroups as a slice. Caller holds s.mu.
func (s *Session) usenetGroupsLocked() []string {
	if len(s.usenetGroups) == 0 {
		return nil
	}
	out := make([]string, 0, len(s.usenetGroups))
	for g := range s.usenetGroups {
		out = append(out, g)
	}
	return out
}

// SendSources delivers the available-source lists for the client's filters. The
// lists are time-independent, so this is called once after init_ack. Failures
// in the caller are non-fatal: a missing list only degrades a filter UI.
func (s *Session) SendSources(video, audio, pager []string, usenet []model.NewsgroupSource) {
	s.send_(outMsg{Type: "sources", Sources: &SourceList{Video: video, Audio: audio, Pager: pager, Usenet: usenet}})
}

// Init sets the client's starting virtual time and sends the initial snapshot.
// The snapshot (active-now items, incl. the 5-min instant lookback) gives the
// client immediate playable state; resetting all horizons to t makes the first
// tick refill the forward window [t, t+window). A few boundary items may arrive
// twice (snapshot + first window) — the client dedups by id.
func (s *Session) Init(t time.Time, items []model.MediaItem) {
	s.mu.Lock()
	s.virtualTime = t
	s.paused = false
	s.resetHorizons(t)
	s.mu.Unlock()

	s.send_(outMsg{Type: "init_ack", Time: t.Format(time.RFC3339), Items: s.applyFormatFilter(items)})

	s.sendChatStateIfSubscribed()
	s.syncChatPresence()
}

// Seek moves the client's virtual clock to t and delivers the full set of
// items that are active at that time so the client can resync immediately.
// Like Init, horizons reset to t so windows refill forward from the new instant.
func (s *Session) Seek(t time.Time, items []model.MediaItem) {
	s.mu.Lock()
	s.virtualTime = t
	s.resetHorizons(t)
	s.mu.Unlock()

	s.send_(outMsg{Type: "seek_ack", Time: t.Format(time.RFC3339), Items: s.applyFormatFilter(items)})

	s.sendChatStateIfSubscribed()
	s.syncChatPresence()
}

// resetHorizons points every channel's high-water mark at t so the next tick
// refills a fresh forward window. Caller must hold s.mu.
func (s *Session) resetHorizons(t time.Time) {
	s.mediaHorizon = t
	s.pagerHorizon = t
	s.mp3Horizon = t
	s.newsHorizon = t
	s.usenetHorizon = t
	s.flightsHorizon = t
	s.weatherHorizon = t
	s.alertHorizon = t
	s.chatHorizon = t
}

// Pause freezes the client's virtual clock.
func (s *Session) Pause() {
	// The master clock never pauses; while forced, a client pause would only
	// desync it until the next heartbeat clamp. Ack (client protocol expects
	// it) but don't apply.
	if _, forced := s.hub.MasterNow(); forced {
		s.send_(outMsg{Type: "pause_ack"})
		return
	}
	s.mu.Lock()
	s.paused = true
	s.mu.Unlock()
	s.send_(outMsg{Type: "pause_ack"})
	s.sendChatStateIfSubscribed()
}

// Resume unfreezes the client's virtual clock.
func (s *Session) Resume() {
	s.mu.Lock()
	s.paused = false
	s.mu.Unlock()
	s.send_(outMsg{Type: "resume_ack"})
	s.sendChatStateIfSubscribed()
}

// Heartbeat corrects drift if the client's reported time diverges too far.
// While the master clock is forced, drift correction inverts: the server
// wins and pins virtualTime to master rather than trusting the client.
func (s *Session) Heartbeat(clientTime time.Time) {
	masterTime, forced := s.hub.MasterNow()

	s.mu.Lock()
	if forced {
		// Forced mode inverts drift correction: the server wins. Pin the
		// session clock to master so windowed queries track the broadcast.
		s.virtualTime = masterTime
	} else if drift := abs(clientTime.Sub(s.virtualTime)); drift > driftThresh {
		s.logger.Info("correcting drift", "drift", drift)
		s.virtualTime = clientTime
	}
	t := s.virtualTime
	s.mu.Unlock()

	m := outMsg{Type: "heartbeat_ack", Time: t.Format(time.RFC3339)}
	if forced {
		m.MasterTime = masterTime.Format(time.RFC3339)
	}
	s.send_(m)
}

// SendClock pushes the forced-clock state to this client. While active the
// client slaves its virtual clock to Time; on release it keeps ticking from
// wherever the master left it.
func (s *Session) SendClock(active bool, t time.Time) {
	m := outMsg{Type: "clock", Active: &active}
	if active {
		m.Time = t.Format(time.RFC3339)
	}
	s.send_(m)
}

// SendError delivers an error message to the client.
func (s *Session) SendError(msg string) {
	s.send_(outMsg{Type: "error", Msg: msg})
}

// SetUser records the Directus user this connection authenticated as. An empty
// id means anonymous, which is the steady state for most visitors — only the
// chat channel requires an identity.
func (s *Session) SetUser(id string) {
	s.mu.Lock()
	s.userID = id
	s.mu.Unlock()
}

// UserID returns the authenticated Directus user id, or "" when anonymous.
func (s *Session) UserID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.userID
}

// SetProfiles installs the buddy roster for this session. Config is loaded once
// at connect time and handed in; sessions never query for it.
func (s *Session) SetProfiles(p []chat.Profile) {
	s.mu.Lock()
	s.profiles = p
	s.mu.Unlock()
}

// SetPhaseData installs the beacon and phase configuration used to resolve
// each buddy's emotional arc across the virtual clock. Config is loaded once
// at connect time and handed in, exactly like SetProfiles; sessions never
// query for it.
func (s *Session) SetPhaseData(beacons map[int]chat.Beacon, phases map[int][]chat.Phase) {
	s.mu.Lock()
	s.beacons = beacons
	s.phases = phases
	s.mu.Unlock()
}

// SetSchedules installs the proactive-beat configuration RunTimePump checks
// on every tick. Config is loaded once at connect time and handed in, exactly
// like SetPhaseData; sessions never query for it.
func (s *Session) SetSchedules(schedules []chat.Schedule) {
	s.mu.Lock()
	s.schedules = schedules
	s.mu.Unlock()
}

// SetBroadcastSources installs the reach/market classification used to decide
// which transcripts reach each buddy. Config is loaded once at connect time and
// handed in, exactly like SetPhaseData; sessions never query for it.
func (s *Session) SetBroadcastSources(sources []chat.BroadcastSource) {
	s.mu.Lock()
	s.bcastSources = sources
	s.mu.Unlock()
}

// chatGate evaluates the chat.Gate from live session state. Blocked is always
// false here — a per-user/per-profile block is a database fact, checked
// separately in ChatSend after this gate passes, not part of the in-memory
// session state this snapshot draws from.
func (s *Session) chatGate() (enabled bool, reason string) {
	s.mu.Lock()
	g := chat.Gate{
		VirtualTime: s.virtualTime,
		ClockSet:    !s.virtualTime.IsZero(),
		Paused:      s.paused,
		SignedIn:    s.userID != "",
	}
	s.mu.Unlock()
	return chat.Available(g)
}

// SendChatState emits the gate the client binds its input's disabled state to.
func (s *Session) SendChatState() {
	enabled, reason := s.chatGate()
	s.send_(outMsg{Type: "chat_state", Enabled: &enabled, Reason: reason})
}

// sendChatDisabled emits chat_state{enabled:false, reason} — the shape every
// ChatSend refusal path (gate failure, a chat_blocks hit, local moderation
// block) shares.
func (s *Session) sendChatDisabled(reason string) {
	enabled := false
	s.send_(outMsg{Type: "chat_state", Enabled: &enabled, Reason: reason})
}

// sendChatStateIfSubscribed re-evaluates the chat gate for clock transitions.
// Unlike SendChatState it respects the opt-in convention: a session that never
// subscribed to chat gets no chat frames.
func (s *Session) sendChatStateIfSubscribed() {
	s.mu.Lock()
	_, ok := s.subscriptions[ChannelChat]
	s.mu.Unlock()
	if !ok {
		return
	}
	s.SendChatState()
}

// SendChatRoster emits the full buddy list with each buddy's online state at the
// current virtual time.
func (s *Session) SendChatRoster() {
	s.mu.Lock()
	profiles, t := s.profiles, s.virtualTime
	s.mu.Unlock()

	buddies := chat.Roster(profiles, t)

	s.mu.Lock()
	if s.presenceSeen == nil {
		s.presenceSeen = make(map[int]bool, len(buddies))
	}
	for _, b := range buddies {
		s.presenceSeen[b.ID] = b.Online
	}
	s.mu.Unlock()

	s.send_(outMsg{Type: "chat_roster", Buddies: buddies})
}

// syncChatPresence emits one chat_presence frame per buddy whose online state
// changed since the last call. Most ticks emit nothing, so this stays cheap on
// the tick path.
func (s *Session) syncChatPresence() {
	s.mu.Lock()
	if _, ok := s.subscriptions[ChannelChat]; !ok {
		s.mu.Unlock()
		return
	}
	profiles, t := s.profiles, s.virtualTime
	if s.presenceSeen == nil {
		s.presenceSeen = make(map[int]bool, len(profiles))
	}
	var changed []model.Buddy
	for _, p := range profiles {
		online := p.OnlineAt(t)
		if was, seen := s.presenceSeen[p.ID]; !seen || was != online {
			s.presenceSeen[p.ID] = online
			changed = append(changed, model.Buddy{ID: p.ID, ScreenName: p.ScreenName, Online: online})
		}
	}
	s.mu.Unlock()

	for _, b := range changed {
		online := b.Online
		s.send_(outMsg{Type: "chat_presence", Profile: b.ID, Online: &online})
	}
}

const (
	// chatHistoryLimit bounds both the composer's rolling context (Turn slice
	// pulled per ChatSend) and a chat_history reply.
	chatHistoryLimit = 40
	// chatBroadcastLookback is how far back the tier-2 (recently broadcast)
	// retrieval reaches — long enough that "what you just heard on TV" still
	// reads as recent, short enough that it stays a rolling window rather than
	// the whole day's transcript.
	chatBroadcastLookback = 10 * time.Minute
	// chatTimelineLimit bounds the tier-3 fallback search, consulted only when
	// tiers 1 and 2 turn up nothing for this virtual time.
	chatTimelineLimit = 5
	// chatRateTrimWindow bounds recentSends' growth on a long-lived connection;
	// it only needs to outlive chat's own rate window (60s, guard.go), not the
	// whole session.
	chatRateTrimWindow = 5 * time.Minute
	// chatStallBody is the canned in-character line sent when the generator is
	// unavailable or its queue is full. Degradation must preserve the illusion,
	// not read as a system error.
	chatStallBody = "hang on, phones ringing"
)

// ChatSend accepts one student message addressed to profileID. The gate is
// evaluated and, on refusal, answered before anything else runs — in
// particular before any database read — so a nil pool (every unit test in
// this package) never sees a query for a message the gate was always going to
// reject. Enqueue never blocks: a full (or absent) generator degrades to an
// in-character stall rather than an error frame, preserving the illusion.
func (s *Session) ChatSend(profileID int, body string) {
	if enabled, reason := s.chatGate(); !enabled {
		s.sendChatDisabled(reason)
		return
	}

	now := time.Now().UTC()
	s.mu.Lock()
	userID, vTime, profiles := s.userID, s.virtualTime, s.profiles
	beacons, phases := s.beacons, s.phases
	bcastSources := s.bcastSources
	s.recentSends = append(s.recentSends, now)
	s.recentSends = trimBefore(s.recentSends, now.Add(-chatRateTrimWindow))
	recent := append([]time.Time(nil), s.recentSends...)
	s.mu.Unlock()

	ctx := context.Background()

	if s.pool != nil {
		// Wall-clock, not vTime: a moderation cool-down is about the student
		// waiting it out in real time, not the simulated 2001 clock -- see
		// chat.LoadBlocks' doc comment.
		if blocks, err := chat.LoadBlocks(ctx, s.pool, userID, now); err != nil {
			s.logger.Warn("chat: load blocks failed", "error", err)
		} else if blocked, _ := chat.BlocksApply(blocks, profileID); blocked {
			s.sendChatDisabled("blocked")
			return
		}
	}

	decision := chat.CheckLocal(body, now, recent)
	if decision.Outcome == "block" {
		s.persistInbound(ctx, userID, profileID, body, vTime, moderationOf(decision))
		// Persist the block itself, not just this message's moderation flag — a
		// block that only lasts for the ChatSend call that triggered it is not a
		// block: reconnecting or rewording the same message would sail straight
		// through. Scoped to this profile (not global): the design's "block"
		// outcome is "that buddy stops responding," not "chat disabled outright."
		// expires comes from decision.CoolDown (wall-clock, per chat.LoadBlocks'
		// doc comment) rather than nil: CheckLocal's triggers are a 5-term
		// substring match and a rate limit, neither reliable enough to silence a
		// buddy forever with no admin recovery path. A permanent block (expires
		// nil) stays possible, but only as a teacher/admin action outside this
		// package -- never as a side effect of local moderation.
		if s.pool != nil {
			pid := profileID
			var expires *time.Time
			if decision.CoolDown > 0 {
				t := now.Add(decision.CoolDown)
				expires = &t
			}
			if err := chat.CreateBlock(ctx, s.pool, userID, "profile", &pid, decision.Reason, decision.Evidence, expires); err != nil {
				s.logger.Warn("chat: create block failed", "error", err)
			}
		}
		s.sendChatDisabled("blocked")
		return
	}

	var moderation map[string]any
	if decision.Outcome != "allow" {
		moderation = moderationOf(decision)
	}
	s.persistInbound(ctx, userID, profileID, body, vTime, moderation)

	profile := findProfile(profiles, profileID)
	history, digest, recentPassages, timeline := s.retrieveContext(ctx, userID, profileID, vTime, body,
		chat.AllowedFor(bcastSources, profile.Market))

	s.send_(outMsg{Type: "chat_typing", Profile: profileID})

	job := buildChatJob(userID, profile, phases, beacons, body, "generated", false, vTime,
		digest, recentPassages, timeline, history, nil)
	job.Deliver = s.chatDeliver(userID, profileID, vTime, job.Kind)

	gen := s.hub.Generator()
	if gen == nil || !gen.Enqueue(job) {
		s.sendStall(ctx, userID, profileID, vTime)
	}
}

// retrieveContext loads the same three knowledge tiers and rolling history
// buildChatJob composes into every reply, whether the trigger is a typed
// ChatSend or a generated scheduled beat — grounding must never drift
// between the two paths, and duplicating this block was Task 10's original
// mistake. query drives the tier-3 fallback search consulted only when tiers
// 1 and 2 are both empty (knowledge.go's own contract for SearchTimeline):
// the student's own message for ChatSend, or the curator's Prompt for a beat
// in lieu of anything a student typed. Every value is the zero value when
// s.pool is nil, exactly like the inline block this replaced.
func (s *Session) retrieveContext(ctx context.Context, userID string, profileID int, vTime time.Time, query string, allow *chat.BroadcastFilter) (history []chat.Turn, digest, recentPassages, timeline []chat.Passage) {
	if s.pool == nil {
		return nil, nil, nil, nil
	}
	if h, err := chat.History(ctx, s.pool, userID, profileID, vTime, chatHistoryLimit); err != nil {
		s.logger.Warn("chat: history load failed", "error", err)
	} else {
		history = h
	}
	if d, err := chat.LoadCurated(ctx, s.pool, vTime); err != nil {
		s.logger.Warn("chat: load curated failed", "error", err)
	} else {
		digest = d
	}
	if r, err := chat.LoadBroadcast(ctx, s.pool, vTime, chatBroadcastLookback, allow); err != nil {
		s.logger.Warn("chat: load broadcast failed", "error", err)
	} else {
		recentPassages = r
	}
	// Tier 3 must land in Timeline, never Digest: retrospective investigative
	// reporting presented as something the buddy plainly knows is exactly the
	// misattribution the tier system exists to prevent. See buildChatJob and
	// its test.
	if len(digest) == 0 && len(recentPassages) == 0 {
		if tl, err := chat.SearchTimeline(ctx, s.pool, vTime, query, chatTimelineLimit); err != nil {
			s.logger.Warn("chat: search timeline failed", "error", err)
		} else {
			timeline = tl
		}
	}
	return history, digest, recentPassages, timeline
}

// chatDeliver builds the Generator's Deliver callback. It runs on a worker
// goroutine, not the session goroutine, but touches no field s.mu protects:
// everything it needs (userID, profileID, vTime) was already read under mu in
// ChatSend and closed over here, so it persists the reply and calls send_
// with no lock of its own — the shortest possible window is none at all.
//
// baseKind is the persisted/wire kind on a successful reply — the caller's
// Job.Kind, so a typed reply ("generated") and a scheduled beat's generated
// reply ("scheduled") are distinguishable in chat_messages.kind exactly as
// the schema's enum intends. The outcome-based overrides below still take
// priority over it: a refusal, truncation, or provider error is what it is
// regardless of what triggered the job.
func (s *Session) chatDeliver(userID string, profileID int, vTime time.Time, baseKind string) func(chat.Reply, error) {
	return func(reply chat.Reply, err error) {
		if err != nil {
			s.logger.Warn("chat: generation failed", "profile", profileID, "error", err)
		}
		kind := baseKind
		switch reply.Outcome {
		case chat.OutcomeRefused:
			kind = "refused"
		case chat.OutcomeTruncated:
			kind = "truncated"
		case chat.OutcomeError:
			kind = "stall"
			if reply.Body == "" {
				reply.Body = chatStallBody
			}
		}

		msgID := 0
		if s.pool != nil {
			id, appendErr := chat.AppendMessage(context.Background(), s.pool, userID, chat.Message{
				Profile: profileID, Direction: "out", Body: reply.Body, VirtualTime: vTime,
				Kind: kind, Model: reply.Model, TokensIn: reply.TokensIn, TokensOut: reply.TokensOut,
			})
			if appendErr != nil {
				s.logger.Warn("chat: append reply failed", "error", appendErr)
			} else {
				msgID = id
			}
		}

		s.send_(outMsg{
			Type: "chat_message", Profile: profileID, Direction: "out",
			Body: reply.Body, Time: vTime.Format(time.RFC3339), Kind: kind, MessageID: msgID,
		})
	}
}

// sendStall answers a job the generator never accepted (queue full, or no
// generator configured at all) with the same canned in-character line and
// chat_message shape a provider-side outage produces, so the client cannot
// tell the two degradations apart.
func (s *Session) sendStall(ctx context.Context, userID string, profileID int, vTime time.Time) {
	msgID := 0
	if s.pool != nil {
		id, err := chat.AppendMessage(ctx, s.pool, userID, chat.Message{
			Profile: profileID, Direction: "out", Body: chatStallBody, VirtualTime: vTime, Kind: "stall",
		})
		if err != nil {
			s.logger.Warn("chat: append stall failed", "error", err)
		} else {
			msgID = id
		}
	}
	s.send_(outMsg{
		Type: "chat_message", Profile: profileID, Direction: "out",
		Body: chatStallBody, Time: vTime.Format(time.RFC3339), Kind: "stall", MessageID: msgID,
	})
}

// fireBeats delivers every schedule dueBeats reported due, one at a time. It
// re-checks the same gate ChatSend answers on (signed in, unpaused, inside the
// chat window) before touching any of them -- a beat is exactly as unwelcome
// as an inbound reply would be under those conditions, and a session ticking
// while signed out or paused should not open with a proactive message either.
// requires_prior_contact then gates each beat individually via
// HasPriorContact -- with no pool to check against, a beat that requires
// prior contact is skipped rather than assumed safe. kind="static" delivers
// Text with no provider call; kind="generated" enqueues a Job through the
// generator using Prompt as the user message, grounded with the same
// knowledge-tier retrieval a typed reply gets (retrieveContext) and marked
// chat.Job.SelfInitiated so the composer renders it as the buddy speaking
// first rather than answering, following the same stall-on-full-queue
// degradation ChatSend uses.
func (s *Session) fireBeats(ctx context.Context, due []chat.Schedule, userID string, profiles []chat.Profile, beacons map[int]chat.Beacon, phases map[int][]chat.Phase, bcastSources []chat.BroadcastSource, t time.Time) {
	if len(due) == 0 {
		return
	}
	if enabled, _ := s.chatGate(); !enabled {
		return
	}

	for _, sc := range due {
		if s.pool != nil {
			// Wall-clock, not t (the virtual time this beat fired at): see
			// chat.LoadBlocks' doc comment on why a moderation cool-down must not
			// be measured against the simulated clock.
			if blocks, err := chat.LoadBlocks(ctx, s.pool, userID, time.Now().UTC()); err != nil {
				s.logger.Warn("chat: scheduled beat load blocks failed", "profile", sc.ProfileID, "error", err)
			} else if blocked, _ := chat.BlocksApply(blocks, sc.ProfileID); blocked {
				continue
			}
		}

		if sc.RequiresPriorContact {
			if s.pool == nil {
				continue
			}
			has, err := chat.HasPriorContact(ctx, s.pool, userID, sc.ProfileID, t)
			if err != nil {
				s.logger.Warn("chat: scheduled beat prior-contact check failed", "profile", sc.ProfileID, "error", err)
				continue
			}
			if !has {
				continue
			}
		}

		switch sc.Kind {
		case "static":
			s.deliverStaticBeat(ctx, userID, sc.ProfileID, t, sc.Text)
		case "generated":
			// Grounded exactly like a typed reply: same three knowledge tiers
			// and rolling history, via the same retrieveContext ChatSend uses.
			// query is sc.Prompt in place of a student's message, since none
			// exists for a beat the buddy is sending unprompted.
			profile := findProfile(profiles, sc.ProfileID)
			history, digest, recentPassages, timeline := s.retrieveContext(ctx, userID, sc.ProfileID, t, sc.Prompt,
				chat.AllowedFor(bcastSources, profile.Market))
			s.send_(outMsg{Type: "chat_typing", Profile: sc.ProfileID})
			job := buildChatJob(userID, profile, phases, beacons, sc.Prompt, "scheduled", true, t,
				digest, recentPassages, timeline, history, nil)
			job.Deliver = s.chatDeliver(userID, sc.ProfileID, t, job.Kind)
			gen := s.hub.Generator()
			if gen == nil || !gen.Enqueue(job) {
				s.sendStall(ctx, userID, sc.ProfileID, t)
			}
		default:
			s.logger.Warn("chat: scheduled beat has unknown kind", "id", sc.ID, "kind", sc.Kind)
		}
	}
}

// deliverStaticBeat sends a curator-authored beat verbatim -- no provider
// call, no risk of an LLM rewriting it -- persisting it the same way
// chatDeliver persists a generated reply so history and HasPriorContact stay
// consistent.
func (s *Session) deliverStaticBeat(ctx context.Context, userID string, profileID int, vTime time.Time, text string) {
	msgID := 0
	if s.pool != nil {
		id, err := chat.AppendMessage(ctx, s.pool, userID, chat.Message{
			Profile: profileID, Direction: "out", Body: text, VirtualTime: vTime, Kind: "static",
		})
		if err != nil {
			s.logger.Warn("chat: append static beat failed", "error", err)
		} else {
			msgID = id
		}
	}
	s.send_(outMsg{
		Type: "chat_message", Profile: profileID, Direction: "out",
		Body: text, Time: vTime.Format(time.RFC3339), Kind: "static", MessageID: msgID,
	})
}

// persistInbound writes the student's message and returns its id, or 0 when
// persistence is skipped (nil pool) or fails — the message still reaches the
// buddy either way, per the design's "chat_messages write fails: message
// still delivers" contract.
func (s *Session) persistInbound(ctx context.Context, userID string, profileID int, body string, vTime time.Time, moderation map[string]any) int {
	if s.pool == nil {
		return 0
	}
	id, err := chat.AppendMessage(ctx, s.pool, userID, chat.Message{
		Profile: profileID, Direction: "in", Body: body, VirtualTime: vTime,
		Kind: "typed", Moderation: moderation,
	})
	if err != nil {
		s.logger.Warn("chat: append inbound message failed", "error", err)
		return 0
	}
	return id
}

// ChatHistory replies to a request for prior turns with profileID, at or
// before `before`, as a sequence of chat_message frames terminated by one
// carrying Done — the same chunked-reply shape flights_history already uses.
// Context is always re-read fresh (never cached), which is what makes a seek
// rebuild it correctly: the next call sees the new virtual time.
func (s *Session) ChatHistory(profileID int, before time.Time, limit int) {
	s.mu.Lock()
	userID, vTime := s.userID, s.virtualTime
	s.mu.Unlock()

	// The client's own conversation can't leak 9/11 knowledge the way an
	// unclamped `before` could on the prompt path, but this path should still
	// enforce the same virtual-time boundary every other read enforces rather
	// than trusting whatever the client sends.
	before = clampChatHistoryBefore(before, vTime)

	if userID == "" || s.pool == nil {
		s.send_(outMsg{Type: "chat_history", Profile: profileID, Done: true})
		return
	}

	messages, err := chat.HistoryDetailed(context.Background(), s.pool, userID, profileID, before, limit)
	if err != nil {
		s.logger.Warn("chat: chat_history query failed", "error", err)
		s.send_(outMsg{Type: "chat_history", Profile: profileID, Done: true})
		return
	}

	for _, m := range messages {
		s.send_(outMsg{
			Type: "chat_message", Profile: profileID, Direction: m.Direction,
			Body: m.Body, Time: m.VirtualTime.Format(time.RFC3339), Kind: m.Kind, MessageID: m.ID,
		})
	}
	s.send_(outMsg{Type: "chat_history", Profile: profileID, Done: true})
}

// clampChatHistoryBefore bounds a client-supplied chat_history cursor to the
// session's own virtual time, so the boundary is enforced server-side rather
// than merely trusted. A zero virtualTime means the clock has not been set
// yet this connection -- there is no boundary to enforce, so before passes
// through unclamped rather than collapsing to the zero time and hiding every
// row.
func clampChatHistoryBefore(before, virtualTime time.Time) time.Time {
	if virtualTime.IsZero() {
		return before
	}
	if before.After(virtualTime) {
		return virtualTime
	}
	return before
}

// findProfile looks up a buddy by id in the session's cached roster. A miss
// (e.g. a stale client-side id, or — as in several unit tests — no roster
// loaded at all) falls back to a zero-value Profile carrying only the id: the
// generator still has enough to enqueue and reply, just without persona
// fields to render.
func findProfile(profiles []chat.Profile, id int) chat.Profile {
	for _, p := range profiles {
		if p.ID == id {
			return p
		}
	}
	return chat.Profile{ID: id}
}

// moderationOf projects a guard Decision to the JSON shape chat_messages.moderation
// stores. Reason/Evidence are omitted when empty so an "allow" (or a bare
// escalate/block with no term match) doesn't grow the column with empty keys.
func moderationOf(d chat.Decision) map[string]any {
	m := map[string]any{"outcome": d.Outcome}
	if d.Reason != "" {
		m["reason"] = d.Reason
	}
	if d.Evidence != "" {
		m["evidence"] = d.Evidence
	}
	return m
}

// buildChatJob assembles a Generator job from already-retrieved passages and
// configuration. It is a pure mapping — no I/O — precisely so tier crossing
// (see the package doc on chat.Tier) is a thing a test can catch directly:
// digest, recent, and timeline must land in Job.Digest, Job.Recent, and
// Job.Timeline respectively, with no reordering. It serves both a typed
// ChatSend (kind "generated", selfInitiated false) and a generated scheduled
// beat (kind "scheduled", selfInitiated true) — the only difference between
// the two is what the caller passes in, not a second code path.
//
// The phase is resolved here, from phases/beacons, rather than passed in
// pre-resolved: chat.PhaseAt already returns chat.DefaultPhase (ok == false)
// when profile has no phases configured, so there is nothing left for this
// function to do on a miss — a second fallback here would just be dead code
// shadowing PhaseAt's own.
func buildChatJob(userID string, profile chat.Profile, phases map[int][]chat.Phase, beacons map[int]chat.Beacon, body, kind string, selfInitiated bool, vTime time.Time,
	digest, recent, timeline []chat.Passage, history []chat.Turn, deliver func(chat.Reply, error)) chat.Job {
	phase, _ := chat.PhaseAt(phases[profile.ID], beacons, vTime)
	return chat.Job{
		UserID:        userID,
		Profile:       profile,
		Phase:         phase,
		Body:          body,
		Kind:          kind,
		SelfInitiated: selfInitiated,
		VirtualTime:   vTime,
		Digest:        digest,
		Recent:        recent,
		Timeline:      timeline,
		History:       history,
		Deliver:       deliver,
	}
}

// trimBefore drops every timestamp strictly before cutoff, preserving order.
func trimBefore(ts []time.Time, cutoff time.Time) []time.Time {
	i := 0
	for i < len(ts) && ts[i].Before(cutoff) {
		i++
	}
	return ts[i:]
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
			// Decide refills under the lock (horizons are shared with the
			// readPump's Init/Seek/Subscribe/Filter), then do all Redis I/O and
			// sends after releasing it (hard rules #2/#3). Most ticks refill
			// nothing — the lookups happen ~once per window, not per second.
			s.mu.Lock()
			if s.paused || s.virtualTime.IsZero() {
				s.mu.Unlock()
				continue
			}
			s.virtualTime = s.virtualTime.Add(time.Second)
			t := s.virtualTime
			mediaLo, mediaHi, doMedia := planRefill(&s.mediaHorizon, t, windowMedia)
			pagerLo, pagerHi, doPager := s.planChannelRefill(ChannelPager, &s.pagerHorizon, t, windowPager)
			mp3Lo, mp3Hi, doMp3 := s.planChannelRefill(ChannelMp3, &s.mp3Horizon, t, windowMp3)
			newsLo, newsHi, doNews := s.planChannelRefill(ChannelNews, &s.newsHorizon, t, windowNews)
			usenetLo, usenetHi, doUsenet := s.planChannelRefill(ChannelUsenet, &s.usenetHorizon, t, windowUsenet)
			flightsLo, flightsHi, doFlights := s.planChannelRefill(ChannelFlights, &s.flightsHorizon, t, windowFlights)
			weatherLo, weatherHi, doWeather := s.planChannelRefill(ChannelWeather, &s.weatherHorizon, t, windowWeather)
			alertLo, alertHi, doAlert := s.planChannelRefill(ChannelAlerts, &s.alertHorizon, t, windowAlert)
			var usenetGroups []string
			if doUsenet {
				usenetGroups = s.usenetGroupsLocked()
			}
			due := s.dueBeats(t)
			var beatUserID string
			var beatProfiles []chat.Profile
			var beatBeacons map[int]chat.Beacon
			var beatPhases map[int][]chat.Phase
			var beatSources []chat.BroadcastSource
			if len(due) > 0 {
				beatUserID, beatProfiles, beatBeacons, beatPhases = s.userID, s.profiles, s.beacons, s.phases
				beatSources = s.bcastSources
			}
			s.mu.Unlock()

			s.syncChatPresence()
			s.fireBeats(ctx, due, beatUserID, beatProfiles, beatBeacons, beatPhases, beatSources, t)

			if doMedia {
				if items, err := cache.ItemsInRange(ctx, s.rdb, mediaLo, mediaHi); err != nil {
					s.logger.Warn("media range lookup failed", "error", err)
				} else if filtered := s.applyFormatFilter(items); len(filtered) > 0 {
					s.send_(outMsg{Type: "items", Time: t.Format(time.RFC3339), Items: filtered})
				}
			}

			// Each side channel rides its own Redis cache and refills its own
			// forward window. SendPager/SendMp3/SendNews suppress empty batches.
			if doPager {
				if items, err := cache.PagerItemsInRange(ctx, s.rdb, pagerLo, pagerHi); err != nil {
					s.logger.Warn("pager range lookup failed", "error", err)
				} else {
					s.SendPager(t, items)
				}
			}
			if doMp3 {
				if items, err := cache.Mp3ItemsInRange(ctx, s.rdb, mp3Lo, mp3Hi); err != nil {
					s.logger.Warn("mp3 range lookup failed", "error", err)
				} else {
					s.SendMp3(t, items)
				}
			}
			if doNews {
				if items, err := cache.NewsItemsInRange(ctx, s.rdb, newsLo, newsHi); err != nil {
					s.logger.Warn("news range lookup failed", "error", err)
				} else {
					s.SendNews(t, items)
				}
			}
			if doAlert {
				if items, err := cache.AlertItemsInRange(ctx, s.rdb, alertLo, alertHi); err != nil {
					s.logger.Warn("alert range lookup failed", "error", err)
				} else {
					s.SendAlerts(t, items)
				}
			}
			if doFlights {
				if items, err := cache.FlightPositionsInRange(ctx, s.rdb, flightsLo, flightsHi, s.logger); err != nil {
					s.logger.Warn("flights range lookup failed", "error", err)
				} else {
					s.SendFlights(t, items)
				}
			}
			// usenet refills per active group, reading Postgres directly (not Redis):
			// messages carry full bodies and are too large to cache, and delivery is
			// gated to the group(s) the client is viewing, so the query volume is low.
			if doUsenet && len(usenetGroups) > 0 && s.pool != nil {
				// Bound the per-tick Postgres reads so a slow query is abandoned
				// rather than piling up across ticks.
				qctx, cancel := context.WithTimeout(ctx, pgTickTimeout)
				var batch []model.UsenetItem
				for _, g := range usenetGroups {
					items, err := db.UsenetItemsInRange(qctx, s.pool, g, usenetLo, usenetHi)
					if err != nil {
						s.logger.Warn("usenet range lookup failed", "group", g, "error", err)
						continue
					}
					batch = append(batch, items...)
				}
				cancel()
				s.SendUsenet(t, batch)
			}
			// weather refills read Postgres directly (not Redis), the same exception
			// as usenet: observations/forecasts are sparse enough that per-tick query
			// volume is low, so there is no Redis cache/listener/warm to build.
			if doWeather && s.pool != nil {
				qctx, cancel := context.WithTimeout(ctx, pgTickTimeout)
				obs, obsErr := db.WeatherObsInRange(qctx, s.pool, weatherLo, weatherHi)
				if obsErr != nil {
					s.logger.Warn("weather obs range lookup failed", "error", obsErr)
				}
				forecasts, fcErr := db.WeatherForecastsInRange(qctx, s.pool, weatherLo, weatherHi)
				if fcErr != nil {
					s.logger.Warn("weather forecast range lookup failed", "error", fcErr)
				}
				cancel()
				s.SendWeather(t, obs, forecasts)
			}
		}
	}
}

// planRefill reports whether a window refill is due for the given horizon and, if
// so, returns the half-open [lo, hi) range to fetch and advances *horizon to hi.
// A refill fires once the clock comes within leadSeconds of the horizon, so the
// client's buffer is topped up before it drains. Caller must hold s.mu.
func planRefill(horizon *time.Time, vTime time.Time, window time.Duration) (lo, hi time.Time, due bool) {
	if vTime.Add(leadSeconds).Before(*horizon) {
		return time.Time{}, time.Time{}, false
	}
	lo, hi = *horizon, vTime.Add(window)
	*horizon = hi
	return lo, hi, true
}

// planChannelRefill is planRefill gated on an active subscription: an unsubscribed
// channel never refills. Caller must hold s.mu.
func (s *Session) planChannelRefill(channel string, horizon *time.Time, vTime time.Time, window time.Duration) (lo, hi time.Time, due bool) {
	if _, ok := s.subscriptions[channel]; !ok {
		return time.Time{}, time.Time{}, false
	}
	return planRefill(horizon, vTime, window)
}

// dueBeats is planChannelRefill's counterpart for chat_schedules: gated on the
// chat subscription like every other channel, but with no window/lookup to
// plan -- schedules is already resident in memory (SetSchedules), so the
// half-open (chatHorizon, t] slice is computed directly and chatHorizon
// advances to t in the same step. An empty schedules slice (the live table's
// steady state until a curator adds rows) returns nil with no work done, so
// this stays silent on every ordinary tick rather than logging noise. Caller
// must hold s.mu.
func (s *Session) dueBeats(t time.Time) []chat.Schedule {
	if _, ok := s.subscriptions[ChannelChat]; !ok {
		return nil
	}
	if len(s.schedules) == 0 {
		return nil
	}
	from := s.chatHorizon
	s.chatHorizon = t
	return chat.DueBetween(s.schedules, s.beacons, from, t)
}

// encodeMsg serialises an outbound envelope as a MessagePack binary frame.
// SetCustomStructTag("json") reuses the existing json: struct tags as msgpack
// field names, so the wire keys (and the frontend TS interfaces) stay identical.
// time.Time fields encode as the msgpack timestamp extension; the client decodes
// them back to ISO strings.
func encodeMsg(m outMsg) ([]byte, error) {
	var buf bytes.Buffer
	enc := msgpack.NewEncoder(&buf)
	enc.SetCustomStructTag("json")
	if err := enc.Encode(m); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func (s *Session) send_(m outMsg) {
	// Don't write to a closed session.
	select {
	case <-s.done:
		return
	default:
	}

	data, err := encodeMsg(m)
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
