package db

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PlaylistOwnerSelectForTest exposes the query so the handler package can
// assert on its shape without a database.
var PlaylistOwnerSelectForTest = playlistOwnerSelect

// The id comparison is deliberately `id::text = $1`, not `id = $1`. Playlist
// ids arrive from a client (the `?playlist=` value a teacher is driving), and
// the column is a uuid — so a non-uuid string against a typed comparison raises
// "invalid input syntax for type uuid" and turns a bad request into a 500. The
// cast makes an unparseable id simply match nothing, which is the honest
// answer. It costs a sequential scan, but this runs once per teacher command,
// not per tick.
const playlistOwnerSelect = `SELECT user_created FROM playlists WHERE id::text = $1`

// PlaylistOwner returns the Directus user id that created the playlist, or ""
// when the playlist does not exist or has no recorded creator (a row seeded
// outside the app, or created before user_created was tracked).
//
// "" is never a match: the caller must treat an empty owner as "nobody may
// drive this", not as "anybody may".
func PlaylistOwner(ctx context.Context, pool *pgxpool.Pool, id string) (string, error) {
	var owner *string
	err := pool.QueryRow(ctx, playlistOwnerSelect, id).Scan(&owner)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("lookup playlist owner: %w", err)
	}
	if owner == nil {
		return "", nil
	}
	return *owner, nil
}
