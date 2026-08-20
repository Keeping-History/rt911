package chat

import "testing"

func TestAvailable(t *testing.T) {
	base := Gate{VirtualTime: at("14:00"), ClockSet: true, SignedIn: true}

	tests := []struct {
		name       string
		mutate     func(*Gate)
		wantOK     bool
		wantReason string
	}{
		{"signed in, mid-window, running", func(g *Gate) {}, true, "ok"},
		{"not signed in", func(g *Gate) { g.SignedIn = false }, false, "not_signed_in"},
		{"blocked", func(g *Gate) { g.Blocked = true }, false, "blocked"},
		{"paused", func(g *Gate) { g.Paused = true }, false, "paused"},
		{"before the window", func(g *Gate) { g.VirtualTime = at("11:59") }, false, "outside_window"},
		{"at the window end", func(g *Gate) { g.VirtualTime = mustParse("2001-09-12T04:00:00Z") }, false, "outside_window"},
		{"clock not yet set", func(g *Gate) { g.ClockSet = false }, false, "outside_window"},
		{"not signed in outranks blocked", func(g *Gate) { g.SignedIn = false; g.Blocked = true }, false, "not_signed_in"},
		{"blocked outranks outside_window", func(g *Gate) { g.Blocked = true; g.VirtualTime = at("11:00") }, false, "blocked"},
		{"outside_window outranks paused", func(g *Gate) { g.Paused = true; g.VirtualTime = at("11:00") }, false, "outside_window"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			g := base
			tc.mutate(&g)
			ok, reason := Available(g)
			if ok != tc.wantOK || reason != tc.wantReason {
				t.Fatalf("Available() = (%v, %q), want (%v, %q)", ok, reason, tc.wantOK, tc.wantReason)
			}
		})
	}
}
