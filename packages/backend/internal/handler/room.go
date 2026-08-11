package handler

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"classicy/streamer/internal/db"
	"classicy/streamer/internal/fanout"
	"classicy/streamer/internal/model"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/time/rate"
)

// roomLimiter bounds the endpoint as a whole. Every request costs a session
// lookup and an ownership lookup *before* it can be rejected, so without this
// an anonymous caller can amplify one HTTP request into two queries at will.
// Global rather than per user for the same reason as usernameLimiter: a
// per-caller map is an unbounded leak keyed by something the caller chooses.
// Teacher commands are a handful of clicks per lesson, so the ceiling is far
// above real use.
var roomLimiter = rate.NewLimiter(20, 40)

type roomRequest struct {
	Room    string `json:"room"`
	Action  string `json:"action"`
	Time    string `json:"time,omitempty"`
	App     string `json:"app,omitempty"`
	Message string `json:"message,omitempty"`
}

// NewRoomHandler serves live teacher control over a room of students:
//
//	POST /room {"room":"42","action":"jump","time":"2001-09-11T13:03:00Z"}
//	POST /room {"room":"42","action":"focus","app":"TV.app"}
//	POST /room {"room":"42","action":"message","message":"Look at channel 4"}
//
// A room is a playlist id, and **only the Directus user who created that
// playlist may drive it**. Authorisation is per playlist, not a shared
// operator credential: the caller's Directus session cookie is resolved to a
// user id and compared against the playlist's user_created. Holding a session
// for some *other* playlist's owner grants nothing here.
//
// A playlist with no recorded creator is drivable by nobody. Treating an empty
// user_created as "unowned, so anyone" would make every seeded or imported row
// a public remote control for whoever found its id.
func NewRoomHandler(
	pool *pgxpool.Pool,
	bus *fanout.Bus[model.RoomCommand],
	trustedOrigins *OriginAllowlist,
	logger *slog.Logger,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		// Same rule as the chat identity and username paths: SameSite=lax bounds
		// the cookie to the site, not the origin, so only origins we publish may
		// turn it into an identity. Without this any page under the site's
		// domain could drive a teacher's classroom on their behalf.
		if origin := r.Header.Get("Origin"); origin != "" && !trustedOrigins.Trusted(origin) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if !roomLimiter.Allow() {
			http.Error(w, "slow down", http.StatusTooManyRequests)
			return
		}

		// Shape checking runs before authentication on purpose: it is pure —
		// no I/O and no information about who is signed in or which playlists
		// exist — and it keeps a malformed request off the database entirely.
		var req roomRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
			return
		}
		if req.Room == "" {
			http.Error(w, "room required", http.StatusBadRequest)
			return
		}
		if !model.ValidRoomAction(req.Action) {
			http.Error(w, "unknown action", http.StatusBadRequest)
			return
		}
		cmd, err := buildRoomCommand(req)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()

		uid, _, err := db.LookupSessionUser(ctx, pool, db.SessionTokenFrom(r))
		if err != nil {
			logger.Warn("room command: session lookup failed", "error", err)
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		if uid == "" {
			http.Error(w, "sign in first", http.StatusUnauthorized)
			return
		}

		owner, err := db.PlaylistOwner(ctx, pool, req.Room)
		if err != nil {
			logger.Warn("room command: owner lookup failed", "room", req.Room, "error", err)
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		// One 403 for "no such playlist", "playlist has no owner" and "not your
		// playlist" alike. Distinguishing them would turn this into an oracle
		// for which playlist ids exist and who owns them.
		if !mayDriveRoom(owner, uid) {
			logger.Info("room command refused", "room", req.Room, "user", uid)
			http.Error(w, "not your playlist", http.StatusForbidden)
			return
		}

		// Nothing persists a room command, so a failed publish is simply a
		// command that never happened — report it rather than returning 202 for
		// an action no student will see.
		if err := bus.Publish(ctx, cmd); err != nil {
			logger.Error("room command publish failed", "room", req.Room, "action", req.Action, "error", err)
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		logger.Info("room command sent", "room", req.Room, "action", req.Action, "user", uid)
		w.WriteHeader(http.StatusAccepted)
	}
}

// mayDriveRoom is the authorisation rule: a playlist is drivable only by the
// Directus user who created it.
//
// Both blanks are rejected explicitly rather than left to the equality check.
// An unowned playlist (no user_created) and an unauthenticated caller (no
// session) would otherwise compare equal as "" == "" and hand a stranger the
// controls for every seeded or imported playlist in the database.
func mayDriveRoom(owner, uid string) bool {
	return owner != "" && uid != "" && owner == uid
}

// buildRoomCommand validates the per-action payload and returns the command to
// publish. The action itself is already known valid.
func buildRoomCommand(req roomRequest) (model.RoomCommand, error) {
	cmd := model.RoomCommand{Room: req.Room, Action: req.Action, App: req.App, Message: req.Message}
	switch req.Action {
	case model.RoomActionJump:
		t, err := parseTime(req.Time)
		if err != nil {
			return cmd, err
		}
		cmd.Time = t.UTC()
	case model.RoomActionFocus:
		if req.App == "" {
			return cmd, errRoomAppRequired
		}
	case model.RoomActionMessage:
		if req.Message == "" {
			return cmd, errRoomMessageRequired
		}
	}
	return cmd, nil
}

type roomError string

func (e roomError) Error() string { return string(e) }

const (
	errRoomAppRequired     = roomError("app required")
	errRoomMessageRequired = roomError("message required")
)
