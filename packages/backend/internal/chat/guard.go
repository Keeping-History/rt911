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

	// rateLimitCoolDown and tooLongCoolDown are short: both trip on ordinary,
	// non-hostile behavior (typing fast, pasting something long), so the
	// buddy should come back well within the same session.
	rateLimitCoolDown = 15 * time.Minute
	tooLongCoolDown   = 15 * time.Minute
	// abuseCoolDown is longer because the trigger is a deliberate term match,
	// but it is still a cool-down, not a silent permanent block -- a single
	// substring match (a 5-term list) is not evidence enough to justify never
	// un-blocking a buddy for a student. A zero CoolDown (see Decision) is
	// reserved for a teacher/admin action, which this package never produces.
	abuseCoolDown = time.Hour
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
// this design exists to prevent. CoolDown is how long a "block" outcome
// should last before it self-expires; zero means the caller must not invent a
// duration and should treat it as permanent. CheckLocal always sets CoolDown
// on a block, precisely so a substring match or rate limit can never produce
// a permanent block -- only a teacher/admin action (outside this package)
// does that, by passing expires: nil to CreateBlock directly.
type Decision struct {
	Outcome  string
	Reason   string
	Evidence string
	CoolDown time.Duration
}

// Block is one row from chat_blocks: a teacher- or system-imposed restriction
// on a user, either global or scoped to a single buddy profile.
type Block struct {
	Scope   string
	Profile *int
	Reason  string
	Expires *time.Time
}

// apostropheReplacer normalises every apostrophe variant a keyboard or
// autocorrect can produce out of a string by deleting rather than
// substituting, so "can't" folds onto the same "cant" shape as the term list
// regardless of which one a student typed: the straight apostrophe (U+0027),
// the curly closing one (U+2019, what iOS and Word autocorrect to), the curly
// opening one (U+2018, some autocorrect/typography configurations use it in
// contractions too), and the acute accent (U+00B4, what dead-key input and
// some non-US mobile keyboard layouts emit in place of an apostrophe).
var apostropheReplacer = strings.NewReplacer("'", "", "’", "", "‘", "", "´", "")

func stripApostrophes(s string) string {
	return apostropheReplacer.Replace(s)
}

// CheckLocal is the zero-cost, no-network moderation tier every inbound
// message passes through first. Order matters: length cap, then rate limit,
// then distress, then abuse -- so a message that reads as both distress and
// abuse escalates rather than blocks.
func CheckLocal(body string, now time.Time, recent []time.Time) Decision {
	if len([]rune(body)) > maxBodyRunes {
		return Decision{Outcome: "block", Reason: "too_long", CoolDown: tooLongCoolDown}
	}

	var inWindow int
	for _, t := range recent {
		if now.Sub(t) <= rateWindow {
			inWindow++
		}
	}
	if inWindow >= rateMaxInWindow {
		return Decision{Outcome: "block", Reason: "rate_limit", CoolDown: rateLimitCoolDown}
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
			return Decision{Outcome: "block", Reason: "abuse", Evidence: term, CoolDown: abuseCoolDown}
		}
	}
	return Decision{Outcome: "allow"}
}

const blocksSelect = `
	SELECT scope, profile, reason, expires
	FROM chat_blocks
	WHERE "user" = $1 AND (expires IS NULL OR expires > $2)`

// LoadBlocks reads every currently-unexpired block for a user. now must be
// wall-clock time, not the session's virtual clock: a moderation cool-down is
// about the real person waiting it out, not the simulated 2001 timeline, and
// the two would otherwise disagree the moment a TTL exists -- a student who
// pauses the virtual clock must not thereby freeze their own cool-down.
// BlocksApply re-checks expiry against wall-clock time.Now() for the same
// reason; both must agree or one becomes the accidental stricter gate. "user"
// is a reserved word in Postgres -- unquoted it silently resolves to
// CURRENT_USER and returns the wrong rows instead of failing.
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

const insertBlock = `
	INSERT INTO chat_blocks
		("user", scope, profile, reason, evidence, created_at, expires)
	VALUES
		($1, $2, $3, $4, $5, $6, $7)`

// CreateBlock persists a block so it outlives the single ChatSend call that
// triggered it. Without a row to load on the next message, a local `block`
// decision would evaporate on reconnect or on a slightly reworded resend --
// which is not a block at all. scope is "profile" (that buddy stops
// responding) or "global" (chat disabled outright); profileID is only
// meaningful for "profile" scope. expires is nil for a permanent block, until
// a teacher/admin clears the row. "user" is a reserved word in Postgres --
// unquoted it silently resolves to CURRENT_USER and writes against the wrong
// identity instead of failing.
func CreateBlock(ctx context.Context, pool *pgxpool.Pool, userID, scope string, profileID *int, reason, evidence string, expires *time.Time) error {
	if _, err := pool.Exec(ctx, insertBlock, userID, scope, profileID, reason, evidence, time.Now().UTC(), expires); err != nil {
		return fmt.Errorf("insert chat_blocks: %w", err)
	}
	return nil
}

// BlocksApply reports whether any block in the set currently applies to
// profileID, and if so, why. It re-checks expiry independently of the SQL
// filter in LoadBlocks so it stays correct when called on a slice built by
// hand (as tests do) rather than loaded fresh from the database. Deliberately
// wall-clock, matching LoadBlocks: see its doc comment for why a moderation
// cool-down must not be measured against the session's virtual clock.
func BlocksApply(blocks []Block, profileID int) (bool, string) {
	now := time.Now().UTC()
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
