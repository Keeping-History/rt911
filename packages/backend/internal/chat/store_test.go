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

func TestInsertMessageSQLWritesUserQuoted(t *testing.T) {
	// "user" is a reserved word in Postgres; unquoted it silently resolves to
	// the CURRENT_USER function and the insert runs against the wrong
	// identity instead of failing -- exactly the failure mode this test
	// exists to catch before it reaches production.
	for _, want := range []string{
		`"user"`,
		"chat_messages",
		"profile", "direction", "body", "virtual_time", "created_at",
		"kind", "moderation", "model", "tokens_in", "tokens_out",
	} {
		if !strings.Contains(insertMessage, want) {
			t.Errorf("insertMessage missing %q:\n%s", want, insertMessage)
		}
	}
}

func TestPriorContactSQLFiltersByQuotedUser(t *testing.T) {
	// HasPriorContact backs chat_schedules.requires_prior_contact; an
	// unquoted "user" would silently check CURRENT_USER instead of the
	// student's own history, making every buddy think it has no prior
	// contact with anyone.
	for _, want := range []string{
		`"user" = $1`,
		"profile = $2",
		"virtual_time <= $3",
	} {
		if !strings.Contains(priorContactSelect, want) {
			t.Errorf("priorContactSelect missing %q:\n%s", want, priorContactSelect)
		}
	}
}

func TestHistoryDetailedSQLSelectsWireFieldsScopedToUser(t *testing.T) {
	// A chat_history reply replays turns as chat_message frames, which need id
	// (dedupe) and virtual_time (ordering, especially after a seek) alongside
	// direction/body/kind -- fields History's []Turn strips for the composer's
	// prompt but the wire still needs.
	for _, want := range []string{
		"id", "direction", "body", "virtual_time", "kind",
		`"user" = $1`, "profile = $2", "virtual_time <= $3", "LIMIT",
	} {
		if !strings.Contains(historyDetailedSelect, want) {
			t.Errorf("historyDetailedSelect missing %q:\n%s", want, historyDetailedSelect)
		}
	}
}
