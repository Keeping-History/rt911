package chat

import (
	"strings"
	"testing"
)

func TestHistorySQLFiltersByVirtualTimeAndUser(t *testing.T) {
	// Seeking backward must not leave a buddy remembering a conversation that
	// has not happened yet, and one user must never read another's log. The
	// query orders DESC (latest N turns, not the first N of a long
	// conversation) -- History reverses the scanned slice in Go before
	// returning, see TestReverseTurnsRestoresOldestFirstOrder.
	for _, want := range []string{
		`"user" = $1`,
		"profile = $2",
		"virtual_time <= $3",
		"ORDER BY virtual_time DESC, id DESC",
	} {
		if !strings.Contains(historySelect, want) {
			t.Errorf("historySelect missing %q:\n%s", want, historySelect)
		}
	}
}

// TestReverseTurnsRestoresOldestFirstOrder is the ordering test that a
// SQL-string grep cannot express: historySelect's ORDER BY ... DESC LIMIT
// correctly returns the *latest* N turns, but only reverseTurns proves those
// turns reach the composer oldest-first, which is what the prompt requires.
// A prior version of this test asserted "DESC" was absent from the SQL --
// that pinned the bug (oldest N turns, frozen after ~40 messages) instead of
// catching it, because it could not distinguish "returns the wrong page" from
// "returns the right page in the wrong order."
func TestReverseTurnsRestoresOldestFirstOrder(t *testing.T) {
	newestFirst := []Turn{
		{FromBuddy: true, Text: "third"},
		{FromBuddy: false, Text: "second"},
		{FromBuddy: true, Text: "first"},
	}
	got := reverseTurns(newestFirst)
	want := []Turn{
		{FromBuddy: true, Text: "first"},
		{FromBuddy: false, Text: "second"},
		{FromBuddy: true, Text: "third"},
	}
	if len(got) != len(want) {
		t.Fatalf("reverseTurns returned %d turns, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("reverseTurns[%d] = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestReverseTurnsHandlesEmptyAndSingleton(t *testing.T) {
	if got := reverseTurns(nil); len(got) != 0 {
		t.Errorf("reverseTurns(nil) = %+v, want empty", got)
	}
	one := []Turn{{FromBuddy: true, Text: "only"}}
	if got := reverseTurns(one); len(got) != 1 || got[0] != one[0] {
		t.Errorf("reverseTurns(singleton) = %+v, want %+v", got, one)
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
	// prompt but the wire still needs. Ordered DESC for the same "latest N,
	// not first N" reason as historySelect; HistoryDetailed reverses the
	// scanned slice before returning.
	for _, want := range []string{
		"id", "direction", "body", "virtual_time", "kind",
		`"user" = $1`, "profile = $2", "virtual_time <= $3",
		"ORDER BY virtual_time DESC, id DESC", "LIMIT",
	} {
		if !strings.Contains(historyDetailedSelect, want) {
			t.Errorf("historyDetailedSelect missing %q:\n%s", want, historyDetailedSelect)
		}
	}
}

func TestReverseMessagesRestoresOldestFirstOrder(t *testing.T) {
	// HistoryDetailed's counterpart to TestReverseTurnsRestoresOldestFirstOrder:
	// replayed chat_message frames must land on the wire oldest-first so a
	// client rendering them in arrival order shows the real conversation.
	newestFirst := []Message{
		{ID: 3, Body: "third"},
		{ID: 2, Body: "second"},
		{ID: 1, Body: "first"},
	}
	got := reverseMessages(newestFirst)
	if len(got) != 3 || got[0].ID != 1 || got[1].ID != 2 || got[2].ID != 3 {
		t.Errorf("reverseMessages = %+v, want ids [1 2 3]", got)
	}
}

func TestPriorContactRequiresTheStudentToHaveSpoken(t *testing.T) {
	// Without the direction filter a buddy's own scheduled beat counts as
	// contact and unlocks the next one, so a student who has never replied
	// still gets treated as mid-conversation.
	if !strings.Contains(priorContactSelect, "direction = 'in'") {
		t.Errorf("priorContactSelect must only count inbound messages:\n%s", priorContactSelect)
	}
}

// TestEveryReadPathHidesClearedMessages is the guard that makes "Delete Chat
// Data" trustworthy. Three separate queries read a conversation, and each one
// hides a different leak if it forgets the filter: historySelect would leave the
// cleared transcript in the buddy's prompt, historyDetailedSelect would redraw
// it on the next reconnect or seek, and priorContactSelect would keep a buddy
// treating the student as mid-conversation. A future fourth read path must be
// added here too.
func TestEveryReadPathHidesClearedMessages(t *testing.T) {
	for name, query := range map[string]string{
		"historySelect":         historySelect,
		"historyDetailedSelect": historyDetailedSelect,
		"priorContactSelect":    priorContactSelect,
	} {
		if !strings.Contains(query, "cleared_at IS NULL") {
			t.Errorf("%s must exclude cleared messages:\n%s", name, query)
		}
	}
}

func TestClearMessagesQuotesTheUserColumn(t *testing.T) {
	// `user` is a Postgres reserved word. Unquoted it resolves to CURRENT_USER,
	// so the UPDATE still parses and still succeeds while matching the wrong
	// rows -- a silent mis-scope on a destructive write, with no error to catch.
	if !strings.Contains(clearMessagesUpdate, `"user" = $1`) {
		t.Errorf("clearMessagesUpdate must quote the user column:\n%s", clearMessagesUpdate)
	}
}

func TestClearMessagesIsScopedAndIdempotent(t *testing.T) {
	// No profile predicate: the product action clears every buddy at once.
	if strings.Contains(clearMessagesUpdate, "profile") {
		t.Errorf("clearMessagesUpdate must not narrow to one buddy:\n%s", clearMessagesUpdate)
	}
	// Re-clearing must not rewrite the first clear's timestamp, which is the
	// only record of when an earlier conversation was cleared.
	if !strings.Contains(clearMessagesUpdate, "cleared_at IS NULL") {
		t.Errorf("clearMessagesUpdate must skip already-cleared rows:\n%s", clearMessagesUpdate)
	}
	// A soft delete that deletes is not a soft delete.
	if strings.Contains(strings.ToUpper(clearMessagesUpdate), "DELETE") {
		t.Errorf("clearMessagesUpdate must not delete rows:\n%s", clearMessagesUpdate)
	}
}
