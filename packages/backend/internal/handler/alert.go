package handler

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"

	"classicy/streamer/internal/db"
	"classicy/streamer/internal/fanout"
	"classicy/streamer/internal/model"

	"github.com/jackc/pgx/v5/pgxpool"
)

// alertMaxBody bounds the request body. An alert is a headline plus a short
// HTML paragraph; anything approaching this is a mistake, not a legitimate
// alert.
const alertMaxBody = 64 << 10

const alertMaxTitle = 500

// alertSeverities are the only values the client can render (they select the
// ClassicyAlert icon). Anything else would fall back to "note" silently, so
// it is rejected instead.
var alertSeverities = map[string]struct{}{"note": {}, "caution": {}, "stop": {}}

type alertRequest struct {
	// ID broadcasts an existing alert_items row as-is. When set (>0), every
	// ad-hoc field below is ignored.
	ID int `json:"id"`

	Title        string `json:"title,omitempty"`
	Content      string `json:"content,omitempty"`
	Severity     string `json:"severity,omitempty"`
	Image        string `json:"image,omitempty"`
	ImageCaption string `json:"image_caption,omitempty"`
}

type alertResponse struct {
	ID    int    `json:"id"`
	Title string `json:"title"`
}

var errAlertNoTitle = errors.New("title is required (or pass an existing alert id)")
var errAlertLongTitle = errors.New("title too long")
var errAlertSeverity = errors.New("severity must be note, caution or stop")

// NewAlertHandler serves the operator push API for alerts:
//
//	POST /alert {"id":42}                                    → push alert_items row 42 to every connected client
//	POST /alert {"title":"…","content":"…","severity":"…"}   → push an ad-hoc alert, never persisted
//
// Requires the X-Alert-Key header to match key (constant-time). An empty key
// disables the feature entirely: every request 404s, mirroring /clock.
//
// This is a *push*, not authoring. Alert content stays in Directus and reaches
// every pod's Redis cache through the alert_items NOTIFY listener already; what
// that path cannot do is raise an alert out of schedule, because delivery is
// gated on the row's start_date against each client's virtual clock. This
// endpoint is the "now" path: it builds (or loads) the item once here, fans it
// out to every pod (see internal/fanout), and each pod restamps it per session.
//
// The row is loaded on this pod and published in full rather than by id alone,
// so the other pods do not each repeat the same query — and so an id that does
// not exist fails here, visibly to the operator, instead of silently on N pods.
//
// An ad-hoc alert has no database row, so it needs an id the client can key its
// dedupe and dismissed-set on. adHocSalt is a random value generated once per
// pod at startup; combined with a per-pod counter it keeps ad-hoc ids unique
// across every pod in the deployment (not just this one), which matters because
// the item — id included — is fanned out to all of them. Both halves are kept
// well clear of Directus' positive alert_items ids by staying strictly negative.
func NewAlertHandler(pool *pgxpool.Pool, bus *fanout.Bus[model.AlertItem], key string, logger *slog.Logger) http.HandlerFunc {
	adHocSalt := newAlertPodSalt()
	var adHocCounter atomic.Uint32

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

		var item *model.AlertItem
		if req.ID > 0 {
			var err error
			item, err = db.AlertItemByID(r.Context(), pool, req.ID)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			if item == nil {
				http.Error(w, "no such alert", http.StatusNotFound)
				return
			}
		} else {
			built, err := buildAdHocAlert(&req, adHocSalt, &adHocCounter)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			item = built
		}

		// Unlike the clock's publish, a failure here has no backstop: nothing
		// persists an ephemeral push, so no pod recovers it later. Surface it
		// to the operator rather than logging and returning success.
		if err := bus.Publish(r.Context(), *item); err != nil {
			logger.Error("alert push failed", "id", item.ID, "error", err)
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		logger.Info("alert pushed", "id", item.ID, "title", item.Title)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(alertResponse{ID: item.ID, Title: item.Title})
	}
}

// buildAdHocAlert validates the ad-hoc fields of req and assembles the item to
// broadcast. It is never persisted and never enters the Redis cache — it goes
// straight onto the bus.
func buildAdHocAlert(req *alertRequest, salt uint32, counter *atomic.Uint32) (*model.AlertItem, error) {
	title := strings.TrimSpace(req.Title)
	if title == "" {
		return nil, errAlertNoTitle
	}
	if len(title) > alertMaxTitle {
		return nil, errAlertLongTitle
	}
	severity := req.Severity
	if severity == "" {
		severity = "note"
	}
	if _, ok := alertSeverities[severity]; !ok {
		return nil, errAlertSeverity
	}

	return &model.AlertItem{
		MediaItem: model.MediaItem{
			ID:        nextAdHocAlertID(salt, counter),
			Title:     title,
			FullTitle: title,
			// Matches what curated alert_items rows carry, so an ad-hoc alert
			// is indistinguishable on the wire from a scheduled one.
			Format:       "modal",
			Content:      req.Content,
			Image:        req.Image,
			ImageCaption: req.ImageCaption,
			Approved:     1,
		},
		Severity: &severity,
	}, nil
}

// newAlertPodSalt returns a random 24-bit value, generated once per process.
// Falls back to 0 if the OS RNG is somehow unavailable — the counter alone
// still guarantees uniqueness within this pod, just not across pods, which is
// the same single-pod behavior an operator would see from a fresh deploy.
func newAlertPodSalt() uint32 {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return 0
	}
	return (uint32(b[0])<<16 | uint32(b[1])<<8 | uint32(b[2])) & 0xFFFFFF
}

// nextAdHocAlertID packs the pod salt and a per-pod counter into a single
// negative id, so ad-hoc alerts issued by different pods — all fanned out to
// every session in the deployment — can never collide with each other or with
// a positive Directus alert_items id. Both halves are kept to 24 bits so the
// packed value stays comfortably within int64, with no sign-bit ambiguity.
func nextAdHocAlertID(salt uint32, counter *atomic.Uint32) int {
	n := counter.Add(1) & 0xFFFFFF
	return -int((int64(salt) << 24) | int64(n))
}
