package handler

import (
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net/http"

	"classicy/streamer/internal/fanout"
	"classicy/streamer/internal/model"
)

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
// Requires the X-Room-Key header to match key (constant-time). An empty key
// disables the endpoint entirely: every request 404s, as with /clock and /alert.
//
// AUTHORISATION IS COARSE ON PURPOSE, AND IS THE KNOWN LIMIT OF THIS ENDPOINT.
// A shared key authenticates "an operator", not "the teacher who owns playlist
// 42" — anyone holding it can drive any room. Binding a command to the caller's
// Directus identity and that playlist's owner is a separate piece of work (the
// cookie→identity path in username.go is the seam it would build on); shipping
// a guessy version of it here would be worse than stating the gap plainly.
// Until then, treat the key as an operator credential, not a teacher one.
func NewRoomHandler(bus *fanout.Bus[model.RoomCommand], key string, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if key == "" {
			http.NotFound(w, r)
			return
		}
		provided := []byte(r.Header.Get("X-Room-Key"))
		if subtle.ConstantTimeCompare(provided, []byte(key)) != 1 {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

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

		cmd := model.RoomCommand{Room: req.Room, Action: req.Action, App: req.App, Message: req.Message}
		switch req.Action {
		case model.RoomActionJump:
			t, err := parseTime(req.Time)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			cmd.Time = t.UTC()
		case model.RoomActionFocus:
			if req.App == "" {
				http.Error(w, "app required", http.StatusBadRequest)
				return
			}
		case model.RoomActionMessage:
			if req.Message == "" {
				http.Error(w, "message required", http.StatusBadRequest)
				return
			}
		}

		// Nothing persists a room command, so a failed publish is simply a
		// command that never happened — report it rather than returning 202 for
		// an action no student will see.
		if err := bus.Publish(r.Context(), cmd); err != nil {
			logger.Error("room command publish failed", "room", req.Room, "action", req.Action, "error", err)
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		logger.Info("room command sent", "room", req.Room, "action", req.Action)
		w.WriteHeader(http.StatusAccepted)
	}
}
