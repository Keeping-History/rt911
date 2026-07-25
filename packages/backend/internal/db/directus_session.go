package db

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SessionCookieName is Directus's default session cookie. The frontend logs in
// with mode:"session" and SESSION_COOKIE_DOMAIN is ".911realtime.org", so the
// browser sends this on the WebSocket upgrade to stream-beta — cross-origin but
// same-site, which SameSite=lax permits.
const SessionCookieName = "directus_session_token"

// SessionTokenFrom pulls the Directus session token off an upgrade request.
func SessionTokenFrom(r *http.Request) string {
	c, err := r.Cookie(SessionCookieName)
	if err != nil {
		return ""
	}
	return c.Value
}

// LookupSessionUser resolves a session token to a Directus user UUID.
//
// This reads a Directus-internal table rather than calling the Directus API: the
// streamer already holds a pgxpool, and the API path has a documented history of
// latency and edge-caching problems here. The coupling is deliberate — a Directus
// major-version upgrade must re-verify this query.
//
// An unknown or expired token is not an error; it means "anonymous". Share-link
// sessions have a NULL user and are treated the same way.
func LookupSessionUser(ctx context.Context, pool *pgxpool.Pool, token string) (string, error) {
	if token == "" {
		return "", nil
	}
	var user *string
	err := pool.QueryRow(ctx,
		`SELECT "user" FROM directus_sessions WHERE token = $1 AND expires > now()`,
		token).Scan(&user)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("lookup directus session: %w", err)
	}
	if user == nil {
		return "", nil
	}
	return *user, nil
}
