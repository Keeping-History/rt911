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
	// still match the natural, apostrophised spelling a phone, dead-key input,
	// or Word autocorrects to -- the straight apostrophe (U+0027), the curly
	// closing (U+2019) and opening (U+2018) forms, and the acute accent
	// (U+00B4) some non-US mobile layouts produce -- rather than silently
	// falling through to allow.
	for _, in := range []string{
		"i can't stop crying",
		"i can’t stop crying",
		"i can‘t stop crying",
		"i can´t stop crying",
		"i can't breathe thinking about this",
		"i can’t breathe thinking about this",
		"i can‘t breathe thinking about this",
		"i can´t breathe thinking about this",
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

func TestCheckLocalSetsACoolDownOnEveryBlockOutcome(t *testing.T) {
	// A substring match (5 abuse terms) or a rate limit must never be able to
	// silence a buddy forever with no recovery path -- see the design doc's
	// "expires for cool-downs or null for permanent." CheckLocal is the only
	// producer of these decisions, so it must always attach a duration; a
	// permanent (zero CoolDown, expires: nil) block is reserved for a
	// teacher/admin action this package never takes.
	now := time.Now()

	var flood []time.Time
	for i := 0; i < 20; i++ {
		flood = append(flood, now.Add(-time.Duration(i)*time.Second))
	}

	cases := []struct {
		name   string
		body   string
		recent []time.Time
		want   time.Duration
	}{
		{"too_long", strings.Repeat("a", 5000), nil, tooLongCoolDown},
		{"rate_limit", "hi", flood, rateLimitCoolDown},
		{"abuse", "stfu you piece of shit", nil, abuseCoolDown},
	}
	for _, c := range cases {
		got := CheckLocal(c.body, now, c.recent)
		if got.Outcome != "block" {
			t.Fatalf("%s: Outcome = %q, want block", c.name, got.Outcome)
		}
		if got.CoolDown != c.want {
			t.Errorf("%s: CoolDown = %v, want %v", c.name, got.CoolDown, c.want)
		}
	}
}

func TestCheckLocalSetsNoCoolDownWhenNotBlocking(t *testing.T) {
	// allow and escalate never write a chat_blocks row, so a non-zero CoolDown
	// on either would be a value nobody reads -- and a stray non-zero value
	// here is exactly the kind of thing that gets copy-pasted into a block
	// path later and silently changes behavior.
	if got := CheckLocal("i hate the hijackers so much", time.Now(), nil); got.CoolDown != 0 {
		t.Errorf("allow: CoolDown = %v, want 0", got.CoolDown)
	}
	if got := CheckLocal("i cant stop crying", time.Now(), nil); got.CoolDown != 0 {
		t.Errorf("escalate: CoolDown = %v, want 0", got.CoolDown)
	}
}

func TestCoolDownBlockAppliesThenExpires(t *testing.T) {
	// Models the lifecycle a ChatSend-triggered block actually goes through:
	// CreateBlock computes expires as (block time) + decision.CoolDown, so
	// BlocksApply must say "blocked" while still inside that window and "not
	// blocked" once it has passed -- the un-block path FIX 2 exists to add.
	profileID := 3
	stillCoolingDown := time.Now().Add(rateLimitCoolDown)
	blocks := []Block{{Scope: "profile", Profile: &profileID, Reason: "rate_limit", Expires: &stillCoolingDown}}
	if applied, reason := BlocksApply(blocks, profileID); !applied || reason != "rate_limit" {
		t.Errorf("BlocksApply before expiry = (%v, %q), want (true, \"rate_limit\")", applied, reason)
	}

	alreadyExpired := time.Now().Add(-time.Second)
	blocks = []Block{{Scope: "profile", Profile: &profileID, Reason: "rate_limit", Expires: &alreadyExpired}}
	if applied, _ := BlocksApply(blocks, profileID); applied {
		t.Error("BlocksApply after expiry = true, want false -- the block must not be permanent")
	}
}

func TestPermanentBlockWithNilExpiresStillApplies(t *testing.T) {
	// A teacher/admin block (the only path that may pass expires: nil to
	// CreateBlock) must still behave as permanent -- FIX 2 adds an un-block
	// path for automatic local blocks, not for this one.
	profileID := 9
	blocks := []Block{{Scope: "profile", Profile: &profileID, Reason: "teacher_action", Expires: nil}}
	if applied, reason := BlocksApply(blocks, profileID); !applied || reason != "teacher_action" {
		t.Errorf("BlocksApply(permanent) = (%v, %q), want (true, \"teacher_action\")", applied, reason)
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
