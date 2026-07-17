package handler

import (
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"classicy/streamer/internal/clock"
)

type clockRequest struct {
	Active bool   `json:"active"`
	Time   string `json:"time,omitempty"`
}

type clockResponse struct {
	Active bool   `json:"active"`
	Time   string `json:"time,omitempty"`
}

// NewClockHandler serves the operator control API for forced clock mode:
//
//	GET  /clock                                  → current state
//	POST /clock {"active":true,"time":"..."}     → enable / jump
//	POST /clock {"active":false}                 → release
//
// Both verbs require the X-Clock-Key header to match key (constant-time).
// An empty key disables the feature entirely: every request 404s.
func NewClockHandler(mc *clock.MasterClock, key string, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if key == "" {
			http.NotFound(w, r)
			return
		}
		provided := []byte(r.Header.Get("X-Clock-Key"))
		if subtle.ConstantTimeCompare(provided, []byte(key)) != 1 {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}

		switch r.Method {
		case http.MethodGet:
			writeClockState(w, mc)

		case http.MethodPost:
			var req clockRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
				return
			}
			if req.Active {
				t, err := parseTime(req.Time)
				if err != nil {
					http.Error(w, err.Error(), http.StatusBadRequest)
					return
				}
				if err := mc.Set(r.Context(), t); err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				logger.Info("forced clock set", "time", t)
			} else {
				if err := mc.Release(r.Context()); err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				logger.Info("forced clock released")
			}
			writeClockState(w, mc)

		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	}
}

func writeClockState(w http.ResponseWriter, mc *clock.MasterClock) {
	resp := clockResponse{}
	if t, ok := mc.Now(); ok {
		resp.Active = true
		resp.Time = t.UTC().Format(time.RFC3339)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
