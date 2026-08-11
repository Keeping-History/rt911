package handler

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"

	"classicy/streamer/internal/db"
	"classicy/streamer/internal/model"
	"classicy/streamer/internal/session"

	"github.com/jackc/pgx/v5/pgxpool"
)

// alertMaxBody bounds the request body. An alert is a headline plus a short HTML
// paragraph; anything approaching this is a mistake, not a legitimate alert.
const alertMaxBody = 64 << 10

const alertMaxTitle = 500

// alertSeverities are the only values the client can render (they select the
// ClassicyAlert icon). Anything else would fall back to "note" silently, so it
// is rejected instead.
var alertSeverities = map[string]struct{}{"note": {}, "caution": {}, "stop": {}}

type alertRequest struct {
	// ID broadcasts an existing alert_items row as-is. When set, every other
	// field is ignored.
	ID int `json:"id,omitempty"`

	Title        string `json:"title,omitempty"`
	Content      string `json:"content,omitempty"`
	Severity     string `json:"severity,omitempty"`
	Image        string `json:"image,omitempty"`
	ImageCaption string `json:"image_caption,omitempty"`
}

type alertResponse struct {
	// Delivered counts the sessions the alert was handed to — i.e. connected
	// clients currently subscribed to the alerts channel, not an acknowledgement
	// that a modal was displayed.
	Delivered int             `json:"delivered"`
	Alert     model.AlertItem `json:"alert"`
}

// NewAlertsHandler serves the operator API for out-of-band alerts:
//
//	POST /alerts {"title":"…","content":"…","severity":"caution"}  → ad-hoc alert
//	POST /alerts {"id":42}                                          → fire an existing row now
//
// Guarded by the X-Alert-Key header (constant-time compare against key); an
// empty key disables the feature entirely and every request 404s — same shape as
// /clock, and for the same reason: `content` is rendered as HTML by the client's
// Alerts extension, so this endpoint is operator-only by construction.
//
// Unlike the scheduled alerts in alert_items, an ad-hoc alert is never persisted
// and never enters the Redis cache: it goes straight to the sessions connected
// to this pod. Broadcasting to every pod would need a Redis fan-out like the
// master clock's; until an operator has more than one pod to hit, the extra
// moving part isn't worth it.
func NewAlertsHandler(hub *session.Hub, pool *pgxpool.Pool, key string, logger *slog.Logger) http.HandlerFunc {
	// Ad-hoc alerts have no database row, so they need an id the client can key
	// its dedupe and dismissed-set on. Counting down from zero keeps them out of
	// the way of Directus' positive alert_items ids forever.
	var adHocID atomic.Int64

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
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, alertMaxBody)).Decode(&req); err != nil {
			http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
			return
		}

		item, status, err := buildAlert(r.Context(), pool, &req, &adHocID)
		if err != nil {
			http.Error(w, err.Error(), status)
			return
		}

		delivered := hub.BroadcastAlert(*item)
		logger.Info("alert broadcast", "id", item.ID, "title", item.Title,
			"severity", derefSeverity(item.Severity), "delivered", delivered)

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(alertResponse{Delivered: delivered, Alert: *item})
	}
}

// buildAlert turns a request into the item to broadcast, either by loading the
// referenced row or by assembling an ad-hoc one. On failure it returns the HTTP
// status the caller should report alongside the error.
func buildAlert(ctx context.Context, pool *pgxpool.Pool, req *alertRequest, adHocID *atomic.Int64) (*model.AlertItem, int, error) {
	if req.ID != 0 {
		item, err := db.AlertItemByID(ctx, pool, req.ID)
		if err != nil {
			return nil, http.StatusInternalServerError, err
		}
		if item == nil {
			return nil, http.StatusNotFound, errAlertNotFound
		}
		return item, 0, nil
	}

	req.Title = strings.TrimSpace(req.Title)
	if req.Title == "" {
		return nil, http.StatusBadRequest, errAlertNoTitle
	}
	if len(req.Title) > alertMaxTitle {
		return nil, http.StatusBadRequest, errAlertLongTitle
	}
	if req.Severity == "" {
		req.Severity = "note"
	}
	if _, ok := alertSeverities[req.Severity]; !ok {
		return nil, http.StatusBadRequest, errAlertSeverity
	}

	severity := req.Severity
	return &model.AlertItem{
		MediaItem: model.MediaItem{
			ID:        int(adHocID.Add(-1)),
			Title:     req.Title,
			FullTitle: req.Title,
			// Matches what curated alert_items rows carry, so an ad-hoc alert is
			// indistinguishable on the wire from a scheduled one.
			Format:       "modal",
			Content:      req.Content,
			Image:        req.Image,
			ImageCaption: req.ImageCaption,
			Approved:     1,
		},
		Severity: &severity,
	}, 0, nil
}

// derefSeverity renders a nullable severity for logs. Rows predating the column
// carry nil, which would otherwise log as a bare pointer address.
func derefSeverity(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

var (
	errAlertNotFound  = errors.New("no such alert")
	errAlertNoTitle   = errors.New("title is required (or pass an existing alert id)")
	errAlertLongTitle = errors.New("title too long")
	errAlertSeverity  = errors.New("severity must be note, caution or stop")
)
