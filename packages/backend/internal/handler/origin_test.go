package handler

import "testing"

func TestOriginAllowlistTrusted(t *testing.T) {
	a := NewOriginAllowlist("")

	tests := []struct {
		name   string
		origin string
		want   bool
	}{
		{"apex", "https://911realtime.org", true},
		// Retired in the apex cutover's cleanup step. www 301s at the edge, so
		// it can never produce a browser origin; beta 301s there too.
		{"www is retired", "https://www.911realtime.org", false},
		{"beta is retired", "https://beta.911realtime.org", false},
		{"pr previews", "https://keeping-history.github.io", true},
		{"absent origin is never trusted", "", false},
		{"unrelated site", "https://evil.example", false},
		// The whole point of the gate: a sibling host is same-site under
		// SameSite=lax, so the browser sends the cookie, but it must not
		// yield an identity.
		{"sibling host under the same registrable domain", "https://timemachine.911realtime.org", false},
		{"http scheme is a different origin", "http://911realtime.org", false},
		{"port makes a different origin", "https://911realtime.org:8443", false},
		{"path is not part of an origin", "https://911realtime.org/app", false},
		{"case is normalized", "HTTPS://911RealTime.org", true},
		{"trailing slash is tolerated", "https://911realtime.org/", true},
		{"whitespace is trimmed", "  https://911realtime.org  ", true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := a.Trusted(tc.origin); got != tc.want {
				t.Fatalf("Trusted(%q) = %v, want %v", tc.origin, got, tc.want)
			}
		})
	}
}

func TestOriginAllowlistExtras(t *testing.T) {
	a := NewOriginAllowlist("http://localhost:5173, https://preview.example/ ,, ")

	if !a.Trusted("http://localhost:5173") {
		t.Fatal("a dev origin from the env var should be trusted")
	}
	if !a.Trusted("https://preview.example") {
		t.Fatal("extras should be normalized like the defaults")
	}
	if !a.Trusted("https://911realtime.org") {
		t.Fatal("extras must add to the defaults, not replace them")
	}
	if a.Trusted("http://localhost:4173") {
		t.Fatal("a port not listed should not be trusted")
	}
	if a.Trusted("") {
		t.Fatal("blank entries in the env var must not make the empty origin trusted")
	}
}
