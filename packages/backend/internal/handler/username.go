package handler

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"classicy/streamer/internal/db"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/time/rate"
)

// usernameRe is the shape the Account app normalises to before asking. Anything
// else is a client bug rather than a name worth a database round trip.
//
// Two characters, not three: the backfill derived names from the email local
// part with no minimum, so real accounts hold "me" and "sa". A stricter rule
// here would call an existing user's own name malformed and lock them out of
// saving their profile at all.
var usernameRe = regexp.MustCompile(`^[a-z0-9_]{2,24}$`)

// usernameLimiter bounds the whole endpoint rather than tracking per user.
// Screen names are semi-public -- they are what a buddy calls you in chat -- so
// the disclosure is mild, but an authenticated client should still not be able
// to walk the whole table at speed. A global bucket avoids the unbounded map a
// per-user limiter needs, which is its own small leak.
var usernameLimiter = rate.NewLimiter(20, 40)

// NewUsernameAvailableHandler answers "may I take this screen name?".
//
// It exists because the client cannot answer it: reads on directus_users are
// scoped to $CURRENT_USER, so a lookup from the browser returns zero rows for
// every name, free or taken, and reporting "available" from that would be a
// confident lie.
//
// Authentication is required. Without it this is an open oracle for enumerating
// who holds which name, and the answer is cheap enough to script.
//
// The answer is advisory even so. Two people can ask about the same name in the
// same second and both be told yes; the unique index is what actually decides,
// and the Account app still handles RECORD_NOT_UNIQUE on save.
func NewUsernameAvailableHandler(pool *pgxpool.Pool, trustedOrigins *OriginAllowlist, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		// Same rule as the chat identity path: SameSite=lax bounds the cookie to
		// the site, not the origin, so only origins we publish may turn it into
		// an identity.
		if origin := r.Header.Get("Origin"); origin != "" && !trustedOrigins.Trusted(origin) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if !usernameLimiter.Allow() {
			http.Error(w, "slow down", http.StatusTooManyRequests)
			return
		}

		name := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("name")))
		if !usernameRe.MatchString(name) {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"available": false,
				"reason":    "malformed",
			})
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()

		uid, _, err := db.LookupSessionUser(ctx, pool, db.SessionTokenFrom(r))
		if err != nil {
			logger.Warn("username check: session lookup failed", "error", err)
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		if uid == "" {
			http.Error(w, "sign in first", http.StatusUnauthorized)
			return
		}

		free, err := db.UsernameAvailable(ctx, pool, name, uid)
		if err != nil {
			logger.Warn("username check failed", "error", err)
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"available": free})
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	// Never cached: an answer that was true a minute ago is exactly the answer
	// this endpoint must not give.
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
