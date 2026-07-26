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
	Moderation  map[string]any
}

const insertMessage = `
	INSERT INTO chat_messages
		("user", profile, direction, body, virtual_time, created_at, kind, moderation, model, tokens_in, tokens_out)
	VALUES
		($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
		m.Kind, moderation, m.Model, m.TokensIn, m.TokensOut,
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
const historySelect = `
	SELECT direction, body
	FROM chat_messages
	WHERE "user" = $1 AND profile = $2 AND virtual_time <= $3
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
const historyDetailedSelect = `
	SELECT id, direction, body, virtual_time, kind
	FROM chat_messages
	WHERE "user" = $1 AND profile = $2 AND virtual_time <= $3
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

const priorContactSelect = `
	SELECT EXISTS(
		SELECT 1
		FROM chat_messages
		WHERE "user" = $1 AND profile = $2 AND virtual_time <= $3
	)`

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
