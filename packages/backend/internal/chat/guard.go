package chat

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	maxBodyRunes    = 2000
	rateWindow      = 60 * time.Second
	rateMaxInWindow = 15
)

// distressTerms escalate rather than block. This is a classroom product about
// a mass-casualty event: a student signalling distress needs a response, and
// silence is the worst thing the system can do.
var distressTerms = []string{
	"hurt myself", "kill myself", "want to die", "cant stop crying",
	"cant breathe", "panic attack", "going to be sick", "scared to death",
}

// abuseTerms is deliberately short. The escalation tier above exists so this
// list does not have to be comprehensive -- a long list here would false-positive
// on exactly the raw-but-legitimate grief and anger a student is entitled to.
var abuseTerms = []string{
	"fuck you", "stfu", "piece of shit", "you're an idiot", "shut your mouth",
}

// Decision is the outcome of inbound moderation. Outcome is one of "allow",
// "block", or "escalate" -- collapsing escalate into block is the one failure
// this design exists to prevent.
type Decision struct {
	Outcome  string
	Reason   string
	Evidence string
}

// Block is one row from chat_blocks: a teacher- or system-imposed restriction
// on a user, either global or scoped to a single buddy profile.
type Block struct {
	Scope   string
	Profile *int
	Reason  string
	Expires *time.Time
}

// apostropheReplacer normalises both the straight apostrophe (U+0027) and the
// curly one (U+2019, what iOS and Word autocorrect to) out of a string by
// deleting rather than substituting, so "can't" (straight) and "can’t" (curly)
// both fold onto the same "cant" shape as the term list.
var apostropheReplacer = strings.NewReplacer("'", "", "’", "")

func stripApostrophes(s string) string {
	return apostropheReplacer.Replace(s)
}

// CheckLocal is the zero-cost, no-network moderation tier every inbound
// message passes through first. Order matters: length cap, then rate limit,
// then distress, then abuse -- so a message that reads as both distress and
// abuse escalates rather than blocks.
func CheckLocal(body string, now time.Time, recent []time.Time) Decision {
	if len([]rune(body)) > maxBodyRunes {
		return Decision{Outcome: "block", Reason: "too_long"}
	}

	var inWindow int
	for _, t := range recent {
		if now.Sub(t) <= rateWindow {
			inWindow++
		}
	}
	if inWindow >= rateMaxInWindow {
		return Decision{Outcome: "block", Reason: "rate_limit"}
	}

	// Strip apostrophes (straight and curly) before matching so "can't" and
	// "can't" both collapse onto the term list's "cant" spelling -- autocorrect
	// on phones and Word both produce the curly form, and it is the more
	// natural spelling for a student to type regardless.
	lower := stripApostrophes(strings.ToLower(body))
	for _, term := range distressTerms {
		if strings.Contains(lower, stripApostrophes(term)) {
			return Decision{Outcome: "escalate", Reason: "distress", Evidence: term}
		}
	}
	for _, term := range abuseTerms {
		if strings.Contains(lower, stripApostrophes(term)) {
			return Decision{Outcome: "block", Reason: "abuse", Evidence: term}
		}
	}
	return Decision{Outcome: "allow"}
}

const blocksSelect = `
	SELECT scope, profile, reason, expires
	FROM chat_blocks
	WHERE "user" = $1 AND (expires IS NULL OR expires > $2)`

// LoadBlocks reads every currently-unexpired block for a user. "user" is a
// reserved word in Postgres -- unquoted it silently resolves to CURRENT_USER
// and returns the wrong rows instead of failing.
func LoadBlocks(ctx context.Context, pool *pgxpool.Pool, userID string, now time.Time) ([]Block, error) {
	rows, err := pool.Query(ctx, blocksSelect, userID, now)
	if err != nil {
		return nil, fmt.Errorf("query chat_blocks: %w", err)
	}
	defer rows.Close()

	var out []Block
	for rows.Next() {
		var (
			b      Block
			reason *string
		)
		if err := rows.Scan(&b.Scope, &b.Profile, &reason, &b.Expires); err != nil {
			return nil, fmt.Errorf("scan chat_blocks: %w", err)
		}
		b.Reason = derefStr(reason)
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate chat_blocks: %w", err)
	}
	return out, nil
}

// BlocksApply reports whether any block in the set currently applies to
// profileID, and if so, why. It re-checks expiry independently of the SQL
// filter in LoadBlocks so it stays correct when called on a slice built by
// hand (as tests do) rather than loaded fresh from the database.
func BlocksApply(blocks []Block, profileID int) (bool, string) {
	now := time.Now()
	for _, b := range blocks {
		if b.Expires != nil && b.Expires.Before(now) {
			continue
		}
		switch b.Scope {
		case "global":
			return true, b.Reason
		case "profile":
			if b.Profile != nil && *b.Profile == profileID {
				return true, b.Reason
			}
		}
	}
	return false, ""
}
