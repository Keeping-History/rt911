package db

import (
	"net/http"
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
