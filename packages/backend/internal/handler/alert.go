package handler

import (
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net/http"

	"classicy/streamer/internal/db"
	"classicy/streamer/internal/fanout"
	"classicy/streamer/internal/model"

	"github.com/jackc/pgx/v5/pgxpool"
)

type alertRequest struct {
	ID int `json:"id"`
}

type alertResponse struct {
	ID    int    `json:"id"`
	Title string `json:"title"`
}

// NewAlertHandler serves the operator push API for alerts:
//
//	POST /alert {"id":42}   → push alert_items row 42 to every connected client
//
// Requires the X-Alert-Key header to match key (constant-time). An empty key
// disables the feature entirely: every request 404s, mirroring /clock.
//
// This is a *push*, not authoring. Alert content stays in Directus and reaches
// every pod's Redis cache through the alert_items NOTIFY listener already; what
// that path cannot do is raise an alert out of schedule, because delivery is
// gated on the row's start_date against each client's virtual clock. This
// endpoint is the "now" path: it reads the row once here, fans the whole item
// out to every pod (see internal/fanout), and each pod restamps it per session.
//
// The row is loaded on this pod and published in full rather than by id alone,
// so the other pods do not each repeat the same query — and so an id that does
// not exist fails here, visibly to the operator, instead of silently on N pods.
func NewAlertHandler(pool *pgxpool.Pool, bus *fanout.Bus[model.AlertItem], key string, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if key == "" {
			http.NotFound(w, r)
			return
		}
		provided := []byte(r.Header.Get("X-Alert-Key"))
		if subtle.ConstantTimeCompare(provided, []byte(key)) != 1 {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req alertRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
			return
		}
		if req.ID <= 0 {
			http.Error(w, "id required", http.StatusBadRequest)
			return
		}

		item, err := db.AlertItemByID(r.Context(), pool, req.ID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if item == nil {
			http.Error(w, "no such alert", http.StatusNotFound)
			return
		}

		// Unlike the clock's publish, a failure here has no backstop: nothing
		// persists an ephemeral push, so no pod recovers it later. Surface it
		// to the operator rather than logging and returning success.
		if err := bus.Publish(r.Context(), *item); err != nil {
			logger.Error("alert push failed", "id", req.ID, "error", err)
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		logger.Info("alert pushed", "id", req.ID, "title", item.Title)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(alertResponse{ID: item.ID, Title: item.Title})
	}
}
