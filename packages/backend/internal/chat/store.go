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

const historySelect = `
	SELECT direction, body
	FROM chat_messages
	WHERE "user" = $1 AND profile = $2 AND virtual_time <= $3
	ORDER BY virtual_time, id
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

	var out []Turn
	for rows.Next() {
		var direction, body string
		if err := rows.Scan(&direction, &body); err != nil {
			return nil, fmt.Errorf("scan chat_messages: %w", err)
		}
		out = append(out, Turn{FromBuddy: direction == "out", Text: body})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate chat_messages: %w", err)
	}
	return out, nil
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
