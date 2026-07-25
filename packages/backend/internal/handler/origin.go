package handler

import (
	"strings"
)

// DefaultTrustedOrigins may carry a Directus session cookie into a chat
// identity. The list is deliberately short: SameSite=lax bounds the cookie to
// the *site*, not the origin, so every host under 911realtime.org — including
// ones that serve archived third-party content — can reach the streamer with a
// signed-in user's cookie attached. This allowlist is what narrows that back
// down to origins we actually publish.
//
// keeping-history.github.io hosts the PR previews, which dial the production
// streamer. Note that an Origin is scheme+host only: the preview path
// (/rt911/pr-preview/pr-<n>/) cannot be matched, so trusting this origin trusts
// everything that org publishes to GitHub Pages.
var DefaultTrustedOrigins = []string{
	"https://911realtime.org",
	"https://www.911realtime.org",
	"https://beta.911realtime.org",
	"https://keeping-history.github.io",
}

// OriginAllowlist decides which origins may authenticate. It gates *identity*,
// never the connection: an untrusted origin still streams media, flights, and
// every other channel anonymously. Tightening the WebSocket upgrader's
// CheckOrigin instead would break anonymous embedding, which is a supported use.
type OriginAllowlist struct {
	allowed map[string]struct{}
}

// NewOriginAllowlist builds the allowlist from the defaults plus a
// comma-separated extra list, intended for CHAT_TRUSTED_ORIGINS. Development
// and preview origins belong in the env var so they never ship in production
// config.
func NewOriginAllowlist(extra string) *OriginAllowlist {
	a := &OriginAllowlist{allowed: make(map[string]struct{}, len(DefaultTrustedOrigins)+4)}
	for _, o := range DefaultTrustedOrigins {
		a.allowed[normalizeOrigin(o)] = struct{}{}
	}
	for _, o := range strings.Split(extra, ",") {
		if n := normalizeOrigin(o); n != "" {
			a.allowed[n] = struct{}{}
		}
	}
	return a
}

// Trusted reports whether an Origin header may carry an identity. An absent
// Origin is never trusted: browsers always send one on a WebSocket handshake,
// so its absence means a non-browser client, which has no business presenting a
// browser's httpOnly cookie.
func (a *OriginAllowlist) Trusted(origin string) bool {
	n := normalizeOrigin(origin)
	if n == "" {
		return false
	}
	_, ok := a.allowed[n]
	return ok
}

// normalizeOrigin makes comparison forgiving of the ways an origin gets written
// in config. Scheme and host are case-insensitive per RFC 6454, and a trailing
// slash is a common hand-written mistake — an Origin header never carries one.
func normalizeOrigin(o string) string {
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(o)), "/")
}
