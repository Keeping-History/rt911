package chat

import (
	"strings"
	"testing"
	"time"
)

func TestDistressEscalatesRatherThanBlocks(t *testing.T) {
	// The distinction this whole unit exists for. A student in distress needs
	// a response; blocking them is the worst available outcome.
	for _, in := range []string{
		"i cant stop crying",
		"this is making me want to hurt myself",
		"i feel like i am going to be sick",
	} {
		got := CheckLocal(in, time.Now(), nil)
		if got.Outcome != "escalate" {
			t.Errorf("CheckLocal(%q).Outcome = %q, want escalate", in, got.Outcome)
		}
	}
}

func TestApostrophisedDistressStillEscalates(t *testing.T) {
	// Regression: "cant stop crying" / "cant breathe" in the term list must
	// still match the natural, apostrophised spelling a phone or Word
	// autocorrects to -- both the straight apostrophe (U+0027) and the curly
	// one (U+2019) -- rather than silently falling through to allow.
	for _, in := range []string{
		"i can't stop crying",
		"i can’t stop crying",
		"i can't breathe thinking about this",
		"i can’t breathe thinking about this",
	} {
		if got := CheckLocal(in, time.Now(), nil); got.Outcome != "escalate" {
			t.Errorf("CheckLocal(%q).Outcome = %q, want escalate", in, got.Outcome)
		}
	}
}

func TestRawButOnTopicInputIsAllowed(t *testing.T) {
	// Processing, not attacking. These must reach the buddy.
	for _, in := range []string{
		"i hate the hijackers so much",
		"why did they kill all those people",
		"were they trying to kill everyone",
	} {
		if got := CheckLocal(in, time.Now(), nil); got.Outcome != "allow" {
			t.Errorf("CheckLocal(%q).Outcome = %q, want allow", in, got.Outcome)
		}
	}
}

func TestRateLimitBlocksAFlood(t *testing.T) {
	now := time.Now()
	var recent []time.Time
	for i := 0; i < 20; i++ {
		recent = append(recent, now.Add(-time.Duration(i)*time.Second))
	}
	if got := CheckLocal("hi", now, recent); got.Outcome != "block" {
		t.Errorf("20 messages in 20s must rate-limit, got %q", got.Outcome)
	}
}

func TestOverlongInputIsBlocked(t *testing.T) {
	if got := CheckLocal(strings.Repeat("a", 5000), time.Now(), nil); got.Outcome != "block" {
		t.Errorf("oversized input must block, got %q", got.Outcome)
	}
}

func TestExpiredBlocksDoNotApply(t *testing.T) {
	past := time.Now().Add(-time.Hour)
	blocks := []Block{{Scope: "global", Expires: &past}}
	if applied, _ := BlocksApply(blocks, 1); applied {
		t.Error("an expired block must not still apply")
	}
}

func TestProfileScopedBlockOnlyAffectsThatProfile(t *testing.T) {
	p := 7
	blocks := []Block{{Scope: "profile", Profile: &p}}
	if applied, _ := BlocksApply(blocks, 7); !applied {
		t.Error("profile block must apply to its own profile")
	}
	if applied, _ := BlocksApply(blocks, 8); applied {
		t.Error("profile block must not leak to another profile")
	}
}

func TestDistressBeatsAbuseWhenBothPresent(t *testing.T) {
	// The ordering this task exists to get right: a message that reads as both
	// distress and abuse must escalate, never block.
	got := CheckLocal("stfu i just want to kill myself", time.Now(), nil)
	if got.Outcome != "escalate" {
		t.Errorf("CheckLocal with both distress and abuse terms = %q, want escalate", got.Outcome)
	}
}

func TestAbuseIsBlocked(t *testing.T) {
	got := CheckLocal("stfu you piece of shit", time.Now(), nil)
	if got.Outcome != "block" {
		t.Errorf("CheckLocal(abuse).Outcome = %q, want block", got.Outcome)
	}
}

func TestInsertBlockSQLWritesAllColumnsUserScoped(t *testing.T) {
	// A block that does not survive a reconnect is not a block: a student
	// could reword the same message and sail straight through. This asserts
	// the insert actually persists every field CreateBlock accepts, "user"
	// double-quoted so it targets the intended student rather than resolving
	// to the CURRENT_USER function.
	for _, want := range []string{
		`"user"`,
		"chat_blocks",
		"scope",
		"profile",
		"reason",
		"evidence",
		"created_at",
		"expires",
	} {
		if !strings.Contains(insertBlock, want) {
			t.Errorf("insertBlock missing %q:\n%s", want, insertBlock)
		}
	}
}

func TestBlocksSQLFiltersByUserAndExpiry(t *testing.T) {
	// "user" is a reserved word in Postgres; unquoted it silently resolves to
	// CURRENT_USER and returns the wrong rows instead of failing.
	for _, want := range []string{
		`"user" = $1`,
		"chat_blocks",
	} {
		if !strings.Contains(blocksSelect, want) {
			t.Errorf("blocksSelect missing %q:\n%s", want, blocksSelect)
		}
	}
}
