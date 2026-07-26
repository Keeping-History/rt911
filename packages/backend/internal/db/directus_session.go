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

// displayName is the screen name a chat buddy calls this user, in the order the
// product settles on: the username they chose, then the part of their email
// before the @, then their name. It never invents one -- a random fallback has
// to be PERSISTED to be any use, so that belongs to the backfill script, not to
// a per-connection read that would hand the same person a different name every
// time they reconnect.
//
// Empty is a fine answer. The composer then establishes the student as an
// unnamed friend rather than guessing, which is the behaviour that stops a
// buddy reaching for a name out of its own persona.
func displayName(username, email, first, last *string) string {
	if s := deref(username); s != "" {
		return s
	}
	if s := deref(email); s != "" {
		if at := strings.IndexByte(s, '@'); at > 0 {
			return s[:at]
		}
	}
	if s := strings.TrimSpace(deref(first) + " " + deref(last)); s != "" {
		return s
	}
	return ""
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

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
func LookupSessionUser(ctx context.Context, pool *pgxpool.Pool, token string) (string, string, error) {
	if token == "" {
		return "", "", nil
	}
	var user, username, email, firstName, lastName *string
	err := pool.QueryRow(ctx,
		`SELECT s."user", u.username, u.email, u.first_name, u.last_name
		 FROM directus_sessions s
		 LEFT JOIN directus_users u ON u.id = s."user"
		 WHERE s.token = $1 AND s.expires > now()`,
		token).Scan(&user, &username, &email, &firstName, &lastName)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", nil
	}
	if err != nil {
		return "", "", fmt.Errorf("lookup directus session: %w", err)
	}
	if user == nil {
		return "", "", nil
	}
	return *user, displayName(username, email, firstName, lastName), nil
}
