package handler

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"classicy/streamer/internal/db"
	"classicy/streamer/internal/model"
	"classicy/streamer/internal/session"

	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
	goredis "github.com/redis/go-redis/v9"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 4096,
	// Allow all origins for local dev; restrict in production via env config.
	CheckOrigin: func(r *http.Request) bool { return true },
}

// inMsg is the envelope for every client→server message.
type inMsg struct {
	Type string `json:"type"`
	Time string `json:"time,omitempty"`
}

// filterMsg carries a format whitelist from the client.
// Formats nil or empty means "send all formats".
type filterMsg struct {
	Type    string   `json:"type"`
	Formats []string `json:"formats"`
}

// channelMsg carries the channel name for subscribe/unsubscribe. Valid channels
// are "pager", "mp3", "news" and "usenet".
type channelMsg struct {
	Type    string `json:"type"`
	Channel string `json:"channel"`
}

// usenetFilterMsg carries the set of newsgroups the client is currently viewing.
// The usenet channel only delivers messages from these groups (empty = none).
type usenetFilterMsg struct {
	Type       string   `json:"type"`
	Newsgroups []string `json:"newsgroups"`
}

// usenetMoreMsg requests the page of messages older than `before` (the oldest the
// client currently holds) for the viewed newsgroup(s) — backlog pagination.
type usenetMoreMsg struct {
	Type       string   `json:"type"`
	Newsgroups []string `json:"newsgroups"`
	Before     string   `json:"before"`
}

// usenetBodyMsg requests the full body of one archived message by id. The body is
// no longer carried in list frames; the client fetches it when a message opens.
type usenetBodyMsg struct {
	Type string `json:"type"`
	ID   int    `json:"id"`
}

// NewWSHandler returns an http.HandlerFunc that upgrades connections to WebSocket
// and drives a session for each client.
func NewWSHandler(hub *session.Hub, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			logger.Warn("websocket upgrade failed", "error", err, "remote", r.RemoteAddr)
			return
		}

		sess := session.NewSession(hub, rdb, pool, logger)
		hub.Register(sess)

		// writePump — runs until the session closes or a write fails.
		go func() {
			ping := time.NewTicker(30 * time.Second)
			defer ping.Stop()
			defer conn.Close()

			for {
				select {
				case <-sess.Done():
					return
				case msg := <-sess.Send():
					conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
					if err := conn.WriteMessage(websocket.BinaryMessage, msg); err != nil {
						sess.Close()
						return
					}
				case <-ping.C:
					conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
					if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
						sess.Close()
						return
					}
				}
			}
		}()

		// timePump — advances virtual time and dispatches scheduled items.
		go sess.RunTimePump()

		// readPump — blocks until the connection closes; drives session state.
		defer sess.Close()
		conn.SetReadLimit(4096)
		conn.SetReadDeadline(time.Now().Add(120 * time.Second))
		conn.SetPongHandler(func(string) error {
			conn.SetReadDeadline(time.Now().Add(120 * time.Second))
			return nil
		})

		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				break
			}
			conn.SetReadDeadline(time.Now().Add(120 * time.Second))

			var msg inMsg
			if err := json.Unmarshal(raw, &msg); err != nil {
				sess.SendError("malformed message")
				continue
			}

			switch msg.Type {

			case "init":
				t, err := parseTime(msg.Time)
				if err != nil {
					sess.SendError("invalid time: " + err.Error())
					continue
				}
				items, err := db.CurrentItems(r.Context(), pool, t)
				if err != nil {
					logger.Warn("current items query failed", "error", err)
					sess.SendError("internal error")
					continue
				}
				sess.Init(t, items)
				sendSubscribedSnapshots(r, sess, pool, t, logger)
				sendSources(r, sess, pool, logger)

			case "seek":
				t, err := parseTime(msg.Time)
				if err != nil {
					sess.SendError("invalid time: " + err.Error())
					continue
				}
				items, err := db.CurrentItems(r.Context(), pool, t)
				if err != nil {
					logger.Warn("seek items query failed", "error", err)
					sess.SendError("internal error")
					continue
				}
				sess.Seek(t, items)
				sendSubscribedSnapshots(r, sess, pool, t, logger)

			case "heartbeat":
				t, err := parseTime(msg.Time)
				if err != nil {
					sess.SendError("invalid time: " + err.Error())
					continue
				}
				sess.Heartbeat(t)

			case "filter":
				var fmsg filterMsg
				if err := json.Unmarshal(raw, &fmsg); err != nil {
					sess.SendError("malformed filter message")
					continue
				}
				sess.SetFormatFilter(fmsg.Formats)

			case "usenet_filter":
				var umsg usenetFilterMsg
				if err := json.Unmarshal(raw, &umsg); err != nil {
					sess.SendError("malformed usenet_filter message")
					continue
				}
				sess.SetUsenetGroups(umsg.Newsgroups)
				// Deliver the backlog for the newly-selected group(s) at the current
				// virtual time so the client immediately sees messages up to "now".
				if t, ok := sess.VirtualTime(); ok {
					sendUsenetSnapshot(r, sess, pool, t, logger)
				}

			case "usenet_more":
				var umsg usenetMoreMsg
				if err := json.Unmarshal(raw, &umsg); err != nil {
					sess.SendError("malformed usenet_more message")
					continue
				}
				before, err := parseTime(umsg.Before)
				if err != nil {
					sess.SendError("invalid time: " + err.Error())
					continue
				}
				sendUsenetOlder(r, sess, pool, umsg.Newsgroups, before, logger)

			case "usenet_body":
				var umsg usenetBodyMsg
				if err := json.Unmarshal(raw, &umsg); err != nil {
					sess.SendError("malformed usenet_body message")
					continue
				}
				sendUsenetBody(r, sess, pool, umsg.ID, logger)

			case "subscribe":
				var cmsg channelMsg
				if err := json.Unmarshal(raw, &cmsg); err != nil {
					sess.SendError("malformed subscribe message")
					continue
				}
				if !knownChannel(cmsg.Channel) {
					sess.SendError(fmt.Sprintf("unknown channel %q", cmsg.Channel))
					continue
				}
				sess.Subscribe(cmsg.Channel)
				// Deliver an immediate snapshot at the current virtual time so the
				// client gets the active items without waiting for the next tick.
				if t, ok := sess.VirtualTime(); ok {
					sendChannelSnapshot(r, sess, pool, cmsg.Channel, t, logger)
				}

			case "unsubscribe":
				var cmsg channelMsg
				if err := json.Unmarshal(raw, &cmsg); err != nil {
					sess.SendError("malformed unsubscribe message")
					continue
				}
				if !knownChannel(cmsg.Channel) {
					sess.SendError(fmt.Sprintf("unknown channel %q", cmsg.Channel))
					continue
				}
				sess.Unsubscribe(cmsg.Channel)

			case "pause":
				sess.Pause()

			case "resume":
				sess.Resume()

			default:
				sess.SendError(fmt.Sprintf("unknown message type %q", msg.Type))
			}
		}
	}
}

// parseTime accepts several common timestamp formats from clients.
var timeFormats = []string{
	time.RFC3339,
	"2006-01-02T15:04:05",
	"2006-01-02 15:04:05",
	"2006-01-02 15:04:05.000000",
}

func parseTime(s string) (time.Time, error) {
	for _, f := range timeFormats {
		if t, err := time.Parse(f, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("cannot parse %q as a timestamp", s)
}

// sendPagerSnapshot delivers the current pager lookback window to the session if
// it is subscribed to the pager channel. Called from init, seek, and subscribe.
// Pager snapshots use Postgres (like media init/seek), not the Redis tick cache.
func sendPagerSnapshot(r *http.Request, sess *session.Session, pool *pgxpool.Pool, t time.Time, logger *slog.Logger) {
	if !sess.Subscribed(session.ChannelPager) {
		return
	}
	items, err := db.CurrentPagerItems(r.Context(), pool, t)
	if err != nil {
		logger.Warn("current pager items query failed", "error", err)
		return
	}
	sess.SendPager(t, items)
}

// sendMp3Snapshot delivers the mp3 items active at t (overlap window) to the
// session if it is subscribed to the mp3 channel. Unlike pager, mp3 is durational
// audio, so the snapshot returns the recording playing at t (start ≤ t ≤ end) and
// the Radio app resumes it mid-file via the jump offset.
func sendMp3Snapshot(r *http.Request, sess *session.Session, pool *pgxpool.Pool, t time.Time, logger *slog.Logger) {
	if !sess.Subscribed(session.ChannelMp3) {
		return
	}
	items, err := db.CurrentMp3Items(r.Context(), pool, t)
	if err != nil {
		logger.Warn("current mp3 items query failed", "error", err)
		return
	}
	sess.SendMp3(t, items)
}

// sendNewsSnapshot delivers the news items active at t to the session if it is
// subscribed to the news channel. Like the media path, the snapshot uses an
// overlap window plus a 5-minute lookback for instant headlines (most news is
// instant), so a seek to t still shows recently-fired stories.
func sendNewsSnapshot(r *http.Request, sess *session.Session, pool *pgxpool.Pool, t time.Time, logger *slog.Logger) {
	if !sess.Subscribed(session.ChannelNews) {
		return
	}
	items, err := db.CurrentNewsItems(r.Context(), pool, t)
	if err != nil {
		logger.Warn("current news items query failed", "error", err)
		return
	}
	sess.SendNews(t, items)
}

// usenetSnapshotLimit bounds the backlog returned when a client opens a newsgroup:
// the most recent N messages up to the virtual clock. A group's full history can be
// large, so older messages are fetched on demand (pagination, future work).
const usenetSnapshotLimit = 500

// sendUsenetSnapshot delivers the backlog (most recent messages up to t) for every
// newsgroup the session is currently viewing, if it is subscribed to the usenet
// channel. Called from init, seek, subscribe, and usenet_filter. Reads Postgres
// (like the other snapshots), filtered to the active group(s) so a large group
// never floods the client.
func sendUsenetSnapshot(r *http.Request, sess *session.Session, pool *pgxpool.Pool, t time.Time, logger *slog.Logger) {
	if !sess.Subscribed(session.ChannelUsenet) {
		return
	}
	var batch []model.UsenetItem
	for _, g := range sess.ActiveUsenetGroups() {
		items, err := db.CurrentUsenetItems(r.Context(), pool, g, t, usenetSnapshotLimit)
		if err != nil {
			logger.Warn("current usenet items query failed", "group", g, "error", err)
			continue
		}
		batch = append(batch, items...)
	}
	sess.SendUsenet(t, batch)
}

// sendUsenetOlder delivers the page of messages older than `before` for the given
// newsgroup(s) if the session is subscribed to usenet. All such messages are ≤ the
// virtual clock, so they ride the normal usenet frame and the client merges them in.
func sendUsenetOlder(r *http.Request, sess *session.Session, pool *pgxpool.Pool, newsgroups []string, before time.Time, logger *slog.Logger) {
	if !sess.Subscribed(session.ChannelUsenet) {
		return
	}
	var batch []model.UsenetItem
	for _, g := range newsgroups {
		items, err := db.OlderUsenetItems(r.Context(), pool, g, before, usenetSnapshotLimit)
		if err != nil {
			logger.Warn("older usenet items query failed", "group", g, "error", err)
			continue
		}
		batch = append(batch, items...)
	}
	sess.SendUsenet(before, batch)
}

// sendUsenetBody fetches one message's body by id and replies on the usenet_body
// frame. Only approved messages are served; a missing/unapproved id, a query
// error, or a request from a client not subscribed to usenet all send an empty
// body with an explanatory message so the client shows an error line rather than
// hanging on "loading" — a body request always gets a reply.
func sendUsenetBody(r *http.Request, sess *session.Session, pool *pgxpool.Pool, id int, logger *slog.Logger) {
	if !sess.Subscribed(session.ChannelUsenet) {
		sess.SendUsenetBody(id, "", "message unavailable")
		return
	}
	item, err := db.UsenetItemByID(r.Context(), pool, id)
	if err != nil {
		logger.Warn("usenet body query failed", "id", id, "error", err)
		sess.SendUsenetBody(id, "", "message unavailable")
		return
	}
	if item == nil || item.Approved != 1 {
		sess.SendUsenetBody(id, "", "message unavailable")
		return
	}
	sess.SendUsenetBody(id, item.Body, "")
}

// sendSources delivers the time-independent available-source lists for client
// filters (TV channels, pager providers, newsgroups). Called once per init —
// sources don't change with virtual time, so seek does not resend them. Failures
// are non-fatal: a missing list only degrades a filter UI, it must not break streaming.
func sendSources(r *http.Request, sess *session.Session, pool *pgxpool.Pool, logger *slog.Logger) {
	video, err := db.AvailableVideoSources(r.Context(), pool)
	if err != nil {
		logger.Warn("available video sources query failed", "error", err)
	}
	audio, err := db.AvailableAudioSources(r.Context(), pool)
	if err != nil {
		logger.Warn("available audio sources query failed", "error", err)
	}
	providers, err := db.AvailablePagerProviders(r.Context(), pool)
	if err != nil {
		logger.Warn("available pager providers query failed", "error", err)
	}
	newsgroups, err := db.AvailableNewsgroups(r.Context(), pool)
	if err != nil {
		logger.Warn("available newsgroups query failed", "error", err)
	}
	sess.SendSources(video, audio, providers, newsgroups)
}

// knownChannel reports whether ch is a valid subscription channel.
func knownChannel(ch string) bool {
	return ch == session.ChannelPager || ch == session.ChannelMp3 ||
		ch == session.ChannelNews || ch == session.ChannelUsenet
}

// sendChannelSnapshot delivers the subscribe-time snapshot for a single channel.
func sendChannelSnapshot(r *http.Request, sess *session.Session, pool *pgxpool.Pool, channel string, t time.Time, logger *slog.Logger) {
	switch channel {
	case session.ChannelPager:
		sendPagerSnapshot(r, sess, pool, t, logger)
	case session.ChannelMp3:
		sendMp3Snapshot(r, sess, pool, t, logger)
	case session.ChannelNews:
		sendNewsSnapshot(r, sess, pool, t, logger)
	case session.ChannelUsenet:
		sendUsenetSnapshot(r, sess, pool, t, logger)
	}
}

// sendSubscribedSnapshots delivers snapshots for every channel the session is
// subscribed to. Called from init and seek; each helper no-ops if unsubscribed.
func sendSubscribedSnapshots(r *http.Request, sess *session.Session, pool *pgxpool.Pool, t time.Time, logger *slog.Logger) {
	sendPagerSnapshot(r, sess, pool, t, logger)
	sendMp3Snapshot(r, sess, pool, t, logger)
	sendNewsSnapshot(r, sess, pool, t, logger)
	sendUsenetSnapshot(r, sess, pool, t, logger)
}
