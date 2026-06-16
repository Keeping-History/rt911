package handler

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"classicy/streamer/internal/db"
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

// channelMsg carries the channel name for subscribe/unsubscribe. Currently the
// only valid channel is "pager".
type channelMsg struct {
	Type    string `json:"type"`
	Channel string `json:"channel"`
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

		sess := session.NewSession(hub, rdb, logger)
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
					if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
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
				sendPagerSnapshot(r, sess, pool, t, logger)

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
				sendPagerSnapshot(r, sess, pool, t, logger)

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

			case "subscribe":
				var cmsg channelMsg
				if err := json.Unmarshal(raw, &cmsg); err != nil {
					sess.SendError("malformed subscribe message")
					continue
				}
				if cmsg.Channel != session.ChannelPager {
					sess.SendError(fmt.Sprintf("unknown channel %q", cmsg.Channel))
					continue
				}
				sess.Subscribe(cmsg.Channel)
				// Deliver an immediate snapshot at the current virtual time so the
				// client gets recent pager traffic without waiting for the next tick.
				if t, ok := sess.VirtualTime(); ok {
					sendPagerSnapshot(r, sess, pool, t, logger)
				}

			case "unsubscribe":
				var cmsg channelMsg
				if err := json.Unmarshal(raw, &cmsg); err != nil {
					sess.SendError("malformed unsubscribe message")
					continue
				}
				if cmsg.Channel != session.ChannelPager {
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
