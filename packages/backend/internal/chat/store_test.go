package chat

import (
	"strings"
	"testing"
)

func TestHistorySQLFiltersByVirtualTimeAndUser(t *testing.T) {
	// Seeking backward must not leave a buddy remembering a conversation that
	// has not happened yet, and one user must never read another's log.
	for _, want := range []string{
		`"user" = $1`,
		"profile = $2",
		"virtual_time <= $3",
		"ORDER BY virtual_time",
	} {
		if !strings.Contains(historySelect, want) {
			t.Errorf("historySelect missing %q:\n%s", want, historySelect)
		}
	}
}

func TestTurnsAreReturnedOldestFirst(t *testing.T) {
	// The prompt reads top-to-bottom as a conversation; reversed history makes
	// the buddy answer the wrong question.
	if strings.Contains(historySelect, "DESC") {
		t.Errorf("history must reach the composer oldest-first:\n%s", historySelect)
	}
}

func TestHistoryIsLimited(t *testing.T) {
	// An unbounded history walks the whole conversation into the prompt and
	// silently inflates cost on every turn as a session goes on.
	if !strings.Contains(historySelect, "LIMIT") {
		t.Errorf("historySelect must bound its result:\n%s", historySelect)
	}
}
