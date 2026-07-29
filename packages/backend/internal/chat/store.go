package chat

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Message is one row written to chat_messages, either a student's send or a
// buddy's reply.
type Message struct {
	ID          int
	Profile     int
	Direction   string
	Body        string
	VirtualTime time.Time
	Kind        string
	Model       string
	TokensIn    int
	TokensOut   int
	// CachedIn is how much of TokensIn the provider served from its prompt
	// cache. Without it there is no way to tell whether the prompt's whole
	// stability-ordered, breakpointed layout is doing anything at all: a prefix
	// too short to cache, or one invalidated by a block that changes every turn,
	// both fail silently — the API reports zero cached tokens and raises nothing.
	// This is the only signal that distinguishes "caching works" from "caching
	// has never once hit", so it is persisted rather than logged and dropped.
	CachedIn   int
	Moderation map[string]any
}

const insertMessage = `
	INSERT INTO chat_messages
		("user", profile, direction, body, virtual_time, created_at, kind, moderation, model, tokens_in, tokens_out, cached_in)
	VALUES
		($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
	RETURNING id`

// AppendMessage writes one turn of the conversation. created_at is real
// wall-clock time, independent of m.VirtualTime — the two timelines never
// derive from each other. See the package-level notes on why both exist.
func AppendMessage(ctx context.Context, pool *pgxpool.Pool, userID string, m Message) (int, error) {
	var moderation any
	if m.Moderation != nil {
		moderation = m.Moderation
	}

	var id int
	err := pool.QueryRow(ctx, insertMessage,
		userID, m.Profile, m.Direction, m.Body, m.VirtualTime, time.Now().UTC(),
		m.Kind, moderation, m.Model, m.TokensIn, m.TokensOut, m.CachedIn,
	).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("insert chat_messages: %w", err)
	}
	return id, nil
}

// historySelect orders DESC and LIMITs so a long conversation yields its most
// recent N turns, not its first N -- the same "latest page, then reverse in
// Go" shape as db.OlderUsenetItems. History reverses the scanned slice before
// returning so the composer still sees the conversation oldest-first.
// cleared_at IS NULL is what makes "Delete Chat Data" mean anything on the
// prompt path: a cleared conversation must leave the buddy's context, or the
// buddy answers from a transcript the student can no longer see. See
// ClearMessages for why the rows survive the clear.
const historySelect = `
	SELECT direction, body
	FROM chat_messages
	WHERE "user" = $1 AND profile = $2 AND virtual_time <= $3
	  AND cleared_at IS NULL
	ORDER BY virtual_time DESC, id DESC
	LIMIT $4`

// History rebuilds the conversation the composer folds into the prompt. The
// virtual_time <= $3 filter is load-bearing: without it, seeking backward
// leaves a buddy remembering a conversation that has not happened yet.
func History(ctx context.Context, pool *pgxpool.Pool, userID string, profileID int, before time.Time, limit int) ([]Turn, error) {
	rows, err := pool.Query(ctx, historySelect, userID, profileID, before, limit)
	if err != nil {
		return nil, fmt.Errorf("query chat_messages: %w", err)
	}
	defer rows.Close()

	var newestFirst []Turn
	for rows.Next() {
		var direction, body string
		if err := rows.Scan(&direction, &body); err != nil {
			return nil, fmt.Errorf("scan chat_messages: %w", err)
		}
		newestFirst = append(newestFirst, Turn{FromBuddy: direction == "out", Text: body})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate chat_messages: %w", err)
	}
	return reverseTurns(newestFirst), nil
}

// reverseTurns turns the newest-first slice historySelect's DESC LIMIT
// produces into the oldest-first order the composer's prompt requires -- the
// prompt reads top-to-bottom as a conversation, so reversed history makes the
// buddy answer the wrong question. Pulled out as a pure helper so the
// ordering is directly testable without a database.
func reverseTurns(newestFirst []Turn) []Turn {
	out := make([]Turn, len(newestFirst))
	for i, t := range newestFirst {
		out[len(newestFirst)-1-i] = t
	}
	return out
}

// historyDetailedSelect orders DESC and LIMITs for the same reason
// historySelect does: a long conversation must yield its latest N messages,
// not its first N. HistoryDetailed reverses the scanned slice before
// returning so replayed chat_message frames arrive in conversation order.
// cleared_at IS NULL here is what empties the transcript on screen: this is the
// query a reconnecting or seeking client replays its conversation from, so a
// cleared history that still matched would reappear on the next chat_history.
const historyDetailedSelect = `
	SELECT id, direction, body, virtual_time, kind
	FROM chat_messages
	WHERE "user" = $1 AND profile = $2 AND virtual_time <= $3
	  AND cleared_at IS NULL
	ORDER BY virtual_time DESC, id DESC
	LIMIT $4`

// HistoryDetailed returns prior turns with the wire fields a chat_history
// reply needs to replay them as chat_message frames: id (so a client can
// dedupe) and virtual_time (so it can order them, in particular after a seek)
// alongside direction/body/kind. History strips all of that down to []Turn
// because the composer's prompt has no use for it; this function exists
// specifically so that stripping doesn't also happen on the wire, where a
// replayed turn otherwise carries message_id: 0 -- indistinguishable from "no
// database pool" and unable to dedupe or order at all.
func HistoryDetailed(ctx context.Context, pool *pgxpool.Pool, userID string, profileID int, before time.Time, limit int) ([]Message, error) {
	rows, err := pool.Query(ctx, historyDetailedSelect, userID, profileID, before, limit)
	if err != nil {
		return nil, fmt.Errorf("query chat_messages: %w", err)
	}
	defer rows.Close()

	var newestFirst []Message
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.Direction, &m.Body, &m.VirtualTime, &m.Kind); err != nil {
			return nil, fmt.Errorf("scan chat_messages: %w", err)
		}
		m.Profile = profileID
		m.VirtualTime = m.VirtualTime.UTC()
		newestFirst = append(newestFirst, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate chat_messages: %w", err)
	}
	return reverseMessages(newestFirst), nil
}

// reverseMessages is HistoryDetailed's counterpart to reverseTurns: it turns
// the newest-first slice historyDetailedSelect's DESC LIMIT produces into the
// oldest-first order replayed chat_message frames must arrive in.
func reverseMessages(newestFirst []Message) []Message {
	out := make([]Message, len(newestFirst))
	for i, m := range newestFirst {
		out[len(newestFirst)-1-i] = m
	}
	return out
}

// cleared_at IS NULL completes the clean slate: after clearing, a buddy the
// student had spoken to reverts to never-contacted, so it re-introduces itself
// instead of opening on an intimate beat about a conversation that is gone from
// the student's screen. The cost is deliberate -- scheduled beats gated on
// prior contact stay locked until the student speaks again.
const priorContactSelect = `
	SELECT EXISTS(
		SELECT 1
		FROM chat_messages
		WHERE "user" = $1 AND profile = $2 AND virtual_time <= $3
		  AND direction = 'in'
		  AND cleared_at IS NULL
	)`

// clearMessagesUpdate marks a user's whole history "old" instead of deleting
// it: the transcript leaves the product while the log survives. This is NOT
// account deletion -- Account → Special genuinely erases chat_messages, because
// that action is a data-erasure request. This one is a reset.
//
// The quotes around "user" are load-bearing. Unquoted, `user` is a Postgres
// reserved word that resolves to CURRENT_USER: the statement would still parse,
// still succeed, and mark the wrong rows (or none) without ever erroring.
//
// `AND cleared_at IS NULL` makes the write idempotent and, more importantly,
// preserves the FIRST clear's timestamp -- a second clear must not rewrite when
// an earlier conversation was cleared, since that timestamp is the only record
// of it.
const clearMessagesUpdate = `
	UPDATE chat_messages
	SET cleared_at = $2
	WHERE "user" = $1 AND cleared_at IS NULL`

// ClearMessages soft-deletes one user's entire chat history, across every
// buddy, and reports how many rows it marked. Scoped to a single user by
// construction: there is no profile argument to narrow it and no way for a
// caller to widen it beyond the one userID passed in.
func ClearMessages(ctx context.Context, pool *pgxpool.Pool, userID string) (int64, error) {
	tag, err := pool.Exec(ctx, clearMessagesUpdate, userID, time.Now().UTC())
	if err != nil {
		return 0, fmt.Errorf("update chat_messages cleared_at: %w", err)
	}
	return tag.RowsAffected(), nil
}

// direction = 'in' is the point: this answers "has the STUDENT ever spoken to
// this buddy?", and without it a buddy's own earlier scheduled beat counts as
// contact and unlocks the next one. requires_prior_contact exists so a buddy the
// student has never spoken to does not open with an intimate reaction to a
// mass-casualty event; a buddy talking to itself must not satisfy that.
//
// HasPriorContact backs chat_schedules.requires_prior_contact: a buddy the
// student has never spoken to should not open with an intimate reaction to
// an event.
func HasPriorContact(ctx context.Context, pool *pgxpool.Pool, userID string, profileID int, before time.Time) (bool, error) {
	var exists bool
	if err := pool.QueryRow(ctx, priorContactSelect, userID, profileID, before).Scan(&exists); err != nil {
		return false, fmt.Errorf("query chat_messages exists: %w", err)
	}
	return exists, nil
}
