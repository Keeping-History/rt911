package db

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SessionCookieName is Directus's default session cookie. The frontend logs in
// with mode:"session" and SESSION_COOKIE_DOMAIN is ".911realtime.org", so the
// browser sends this on the WebSocket upgrade to stream-beta — cross-origin but
// same-site, which SameSite=lax permits.
const SessionCookieName = "directus_session_token"

// SessionTokenFrom pulls the Directus session token off an upgrade request.
//
// The cookie is NOT the session token. Directus session mode sets a signed JWT
// whose payload carries a `session` claim, and that claim is what
// directus_sessions.token holds -- a 64-character opaque string, against a
// ~420-character JWT. Treating the cookie value as the token makes the lookup
// miss for every user, so chat reports not_signed_in to someone who is
// demonstrably signed in and nothing in the logs says why.
//
// The signature is deliberately not verified here, and no Directus secret is
// needed. The database lookup is the real check: a forged JWT would have to
// carry a live, unexpired session token to resolve to anyone, which is exactly
// the bar an attacker could not clear anyway. Verifying the envelope would add
// a shared secret without adding a guarantee.
func SessionTokenFrom(r *http.Request) string {
	c, err := r.Cookie(SessionCookieName)
	if err != nil {
		return ""
	}
	return sessionClaim(c.Value)
}

// sessionClaim extracts the `session` claim from a Directus JWT. A value that
// is not a JWT is returned unchanged, so a bare token still works.
func sessionClaim(cookie string) string {
	parts := strings.Split(cookie, ".")
	if len(parts) != 3 {
		return cookie
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return cookie
	}
	var claims struct {
		Session string `json:"session"`
	}
	if err := json.Unmarshal(raw, &claims); err != nil {
		return cookie
	}
	// A JWT with no session claim resolves to nothing rather than to its own
	// text, which could never match a stored token in any case.
	return claims.Session
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
