package db

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSessionTokenFrom(t *testing.T) {
	tests := []struct {
		name   string
		cookie *http.Cookie
		want   string
	}{
		{"no cookie", nil, ""},
		{"session cookie present", &http.Cookie{Name: SessionCookieName, Value: "abc123"}, "abc123"},
		{"unrelated cookie", &http.Cookie{Name: "other", Value: "xyz"}, ""},
		{"empty value", &http.Cookie{Name: SessionCookieName, Value: ""}, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r, err := http.NewRequest(http.MethodGet, "/stream", nil)
			if err != nil {
				t.Fatal(err)
			}
			if tc.cookie != nil {
				r.AddCookie(tc.cookie)
			}
			if got := SessionTokenFrom(r); got != tc.want {
				t.Fatalf("SessionTokenFrom() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestSessionTokenFromUnwrapsTheJWTEnvelope(t *testing.T) {
	// Directus session mode does NOT put the session token in the cookie. It
	// puts a JWT whose payload carries a `session` claim, and THAT is what
	// directus_sessions.token holds. Treating the cookie value as the token
	// makes the lookup miss every time, for every user -- chat reports
	// not_signed_in to someone who is demonstrably signed in.
	payload := base64.RawURLEncoding.EncodeToString([]byte(
		`{"id":"user-uuid","session":"the-64-char-opaque-session-token","iss":"directus"}`))
	jwt := "eyJhbGciOiJIUzI1NiJ9." + payload + ".signature"

	r := httptest.NewRequest("GET", "/stream", nil)
	r.AddCookie(&http.Cookie{Name: SessionCookieName, Value: jwt})

	if got := SessionTokenFrom(r); got != "the-64-char-opaque-session-token" {
		t.Errorf("SessionTokenFrom = %q, want the session claim", got)
	}
}

func TestSessionTokenFromAcceptsARawOpaqueToken(t *testing.T) {
	// Anything that is not a JWT is passed through unchanged, so a caller
	// holding a bare session token still works.
	r := httptest.NewRequest("GET", "/stream", nil)
	r.AddCookie(&http.Cookie{Name: SessionCookieName, Value: "plain-opaque-token"})

	if got := SessionTokenFrom(r); got != "plain-opaque-token" {
		t.Errorf("SessionTokenFrom = %q, want the raw value", got)
	}
}

func TestSessionTokenFromIgnoresAJWTWithNoSessionClaim(t *testing.T) {
	// A JWT without a session claim resolves to nothing rather than to its own
	// raw text, which could never match a stored token anyway.
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"id":"user-uuid"}`))
	r := httptest.NewRequest("GET", "/stream", nil)
	r.AddCookie(&http.Cookie{Name: SessionCookieName, Value: "eyJ0eXAiOiJKV1QifQ." + payload + ".sig"})

	if got := SessionTokenFrom(r); got != "" {
		t.Errorf("SessionTokenFrom = %q, want empty", got)
	}
}
