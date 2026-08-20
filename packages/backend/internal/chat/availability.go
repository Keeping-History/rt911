package chat

import "time"

// Gate is every condition that decides whether a signed-in user may type. It is
// evaluated server-side on subscribe, pause, resume, seek, and window
// boundaries; the client disables its input from the resulting frame, but the
// server refusing is what actually enforces the rule.
type Gate struct {
	VirtualTime time.Time
	ClockSet    bool
	Paused      bool
	SignedIn    bool
	Blocked     bool
}

// Available reports whether chat is usable and, when it is not, the single
// reason to show. Reasons are ordered most to least fundamental so a user who
// is both signed out and outside the window is told the actionable thing.
func Available(g Gate) (bool, string) {
	switch {
	case !g.SignedIn:
		return false, "not_signed_in"
	case g.Blocked:
		return false, "blocked"
	case !g.ClockSet, g.VirtualTime.Before(WindowStart), !g.VirtualTime.Before(WindowEnd):
		return false, "outside_window"
	case g.Paused:
		return false, "paused"
	}
	return true, "ok"
}
