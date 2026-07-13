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
	leadSeconds  = 30 * time.Second
	windowMedia  = 300 * time.Second
	windowPager  = 600 * time.Second
	windowMp3    = 300 * time.Second
	windowNews   = 600 * time.Second
	windowUsenet = 600 * time.Second
	// flights are dense — ~600-900 airborne rows/min — so they get media's
	// shorter window, keeping refill frames at ~300-450 KB.
	windowFlights = 300 * time.Second
	// weather is sparse (hourly obs per station, occasional forecast products),
	// so it gets usenet/news scale rather than flights' shorter window.
	windowWeather = 600 * time.Second
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
	Sources          *SourceList                `json:"sources,omitempty"`
	Msg              string                     `json:"message,omitempty"`
	// ID/Body carry a single on-demand Usenet article body (usenet_body frame).
	ID   int    `json:"id,omitempty"`
	Body string `json:"body,omitempty"`
	// Done marks the final chunk of a flights_history reply (the ID field above
	// doubles as the echoed request id on those frames).
	Done bool `json:"done,omitempty"`
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

	// usenetGroups is the set of newsgroups the client is currently viewing. The
	// usenet channel is delivered only for these groups — a group can hold millions
	// of messages, so nothing is sent until the client selects one. Guarded by mu.
	usenetGroups map[string]struct{}

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
			var usenetGroups []string
			if doUsenet {
				usenetGroups = s.usenetGroupsLocked()
			}
			s.mu.Unlock()

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
