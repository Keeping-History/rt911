package db

import (
	"context"
	"fmt"
	"time"

	"classicy/streamer/internal/model"

	"github.com/jackc/pgx/v5/pgxpool"
)

// selectFrom is the shared SELECT … FROM clause for all item queries.
// source is resolved to sources.slug via a LEFT JOIN so the client receives
// the human-readable slug instead of the raw integer foreign-key.
const selectFrom = `
	SELECT mi.id, mi.title, mi.full_title, s.slug,
	       mi.start_date, mi.end_date, mi.calc_duration, mi.timezone,
	       mi.url, mi.format, mi.approved, mi.mute,
	       mi.volume, mi.jump, mi.trim, mi.image, mi.image_caption,
	       mi.content, mi.sort
	FROM media_items mi
	LEFT JOIN sources s ON s.id = mi.source`

// Connect opens a pgx connection pool and verifies connectivity.
func Connect(dsn string) (*pgxpool.Pool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("pgxpool.New: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return pool, nil
}

// AllItems loads every approved media item ordered by start_date (used for cache warming).
func AllItems(ctx context.Context, pool *pgxpool.Pool) ([]model.MediaItem, error) {
	return queryItems(ctx, pool,
		selectFrom+` WHERE mi.approved = 1 ORDER BY mi.start_date`)
}

// ItemByID returns the row with the given id, regardless of approval state,
// or nil if not found. The NOTIFY listener uses this to fetch the latest
// version of a changed row; it treats an unapproved result as "evict from cache."
func ItemByID(ctx context.Context, pool *pgxpool.Pool, id int) (*model.MediaItem, error) {
	items, err := queryItems(ctx, pool, selectFrom+` WHERE mi.id = $1`, id)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, nil
	}
	return &items[0], nil
}

// CurrentItems returns items active at time t (start_date ≤ t ≤ end_date).
// Instant items — where start_date = end_date or calc_duration = 0 — are
// included for a 5-minute lookback window so seek/init responses contain
// recent pager traffic without returning the entire history.
func CurrentItems(ctx context.Context, pool *pgxpool.Pool, t time.Time) ([]model.MediaItem, error) {
	return queryItems(ctx, pool,
		selectFrom+`
		 WHERE mi.approved = 1
		   AND (
		     (mi.start_date <= $1 AND (mi.end_date IS NULL OR mi.end_date >= $1))
		     OR (
		       (mi.start_date = mi.end_date OR (mi.calc_duration IS NOT NULL AND mi.calc_duration = 0))
		       AND mi.start_date <= $1
		       AND mi.start_date >= $1 - INTERVAL '5 minutes'
		     )
		   )
		 ORDER BY mi.start_date`, t)
}

// pagerSelectFrom is the shared SELECT … FROM clause for all pager queries.
// provider is a plain text column on pager_items (not a sources FK), so no JOIN
// is needed here.
const pagerSelectFrom = `
	SELECT pi.id, pi.start_date, pi.provider, pi.recipient_id,
	       pi.id_type, pi.channel, pi.mode, pi.message, pi.approved
	FROM pager_items pi`

// AllPagerItems loads every approved pager item ordered by start_date (cache warming).
func AllPagerItems(ctx context.Context, pool *pgxpool.Pool) ([]model.PagerItem, error) {
	return queryPagerItems(ctx, pool,
		pagerSelectFrom+` WHERE pi.approved = 1 ORDER BY pi.start_date`)
}

// PagerItemByID returns the row with the given id, regardless of approval state,
// or nil if not found. The NOTIFY listener uses this to fetch the latest version
// of a changed row; an unapproved result means "evict from cache."
func PagerItemByID(ctx context.Context, pool *pgxpool.Pool, id int) (*model.PagerItem, error) {
	items, err := queryPagerItems(ctx, pool, pagerSelectFrom+` WHERE pi.id = $1`, id)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, nil
	}
	return &items[0], nil
}

// CurrentPagerItems returns approved pager items in the single requested second
// [t, t+1s), used by the init/seek/subscribe snapshot paths. Pager is delivered
// forward-only: no backward lookback (so subscribing doesn't dump prior traffic)
// and no bulk future window (so the client renders messages paced by the tick,
// not all at once). Everything after t arrives second-by-second via the 1 Hz
// tick path (cache.PagerItemsAt); this snapshot just covers the boundary second
// the first tick would otherwise skip.
func CurrentPagerItems(ctx context.Context, pool *pgxpool.Pool, t time.Time) ([]model.PagerItem, error) {
	return queryPagerItems(ctx, pool,
		pagerSelectFrom+`
		 WHERE pi.approved = 1
		   AND pi.start_date >= $1
		   AND pi.start_date < $1 + INTERVAL '1 second'
		 ORDER BY pi.start_date`, t)
}

func queryPagerItems(ctx context.Context, pool *pgxpool.Pool, q string, args ...any) ([]model.PagerItem, error) {
	rows, err := pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	defer rows.Close()

	var out []model.PagerItem
	for rows.Next() {
		var it model.PagerItem
		// Nullable text columns scan into pointer locals — Directus stores empty
		// strings as NULL and pgx cannot scan NULL into a non-pointer string.
		var provider, recipientID, idType, channel, mode, message *string
		if err := rows.Scan(
			&it.ID, &it.StartDate, &provider, &recipientID,
			&idType, &channel, &mode, &message, &it.Approved,
		); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		derefStr(&it.Provider, provider)
		derefStr(&it.RecipientID, recipientID)
		derefStr(&it.IDType, idType)
		derefStr(&it.Channel, channel)
		derefStr(&it.Mode, mode)
		derefStr(&it.Message, message)
		out = append(out, it)
	}
	return out, rows.Err()
}

// mp3SelectFrom is the shared SELECT … FROM clause for mp3 queries. mp3 items
// reuse the MediaItem shape (same columns as media_items) but live in their own
// mp3_items table, delivered on the opt-in "mp3" channel.
const mp3SelectFrom = `
	SELECT mi.id, mi.title, mi.full_title, s.slug,
	       mi.start_date, mi.end_date, mi.calc_duration, mi.timezone,
	       mi.url, mi.format, mi.approved, mi.mute,
	       mi.volume, mi.jump, mi.trim, mi.image, mi.image_caption,
	       mi.content, mi.sort
	FROM mp3_items mi
	LEFT JOIN sources s ON s.id = mi.source`

// AllMp3Items loads every approved mp3 item ordered by start_date (cache warming).
func AllMp3Items(ctx context.Context, pool *pgxpool.Pool) ([]model.MediaItem, error) {
	return queryItems(ctx, pool,
		mp3SelectFrom+` WHERE mi.approved = 1 ORDER BY mi.start_date`)
}

// Mp3ItemByID returns the row with the given id regardless of approval state, or
// nil if not found. The NOTIFY listener uses this to fetch the latest version of
// a changed row; an unapproved result means "evict from cache."
func Mp3ItemByID(ctx context.Context, pool *pgxpool.Pool, id int) (*model.MediaItem, error) {
	items, err := queryItems(ctx, pool, mp3SelectFrom+` WHERE mi.id = $1`, id)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, nil
	}
	return &items[0], nil
}

// CurrentMp3Items returns approved mp3 items active at time t (start_date ≤ t ≤
// end_date). Unlike pager, mp3 items are durational audio: a radio recording
// playing at t must appear when the client seeks to t so it can resume mid-file
// via the jump offset. Used by the init/seek/subscribe snapshot paths.
func CurrentMp3Items(ctx context.Context, pool *pgxpool.Pool, t time.Time) ([]model.MediaItem, error) {
	return queryItems(ctx, pool,
		mp3SelectFrom+`
		 WHERE mi.approved = 1
		   AND mi.start_date <= $1
		   AND (mi.end_date IS NULL OR mi.end_date >= $1)
		 ORDER BY mi.start_date`, t)
}

func derefStr(dst *string, src *string) {
	if src != nil {
		*dst = *src
	}
}

func queryItems(ctx context.Context, pool *pgxpool.Pool, q string, args ...any) ([]model.MediaItem, error) {
	rows, err := pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	defer rows.Close()

	var out []model.MediaItem
	for rows.Next() {
		var it model.MediaItem
		// Use pointer locals for all nullable string columns — the DB stores
		// empty strings as NULL and pgx cannot scan NULL into a non-pointer string.
		var fullTitle, timezone, url, format, image, imageCaption, content *string
		if err := rows.Scan(
			&it.ID, &it.Title, &fullTitle, &it.Source,
			&it.StartDate, &it.EndDate, &it.CalcDuration, &timezone,
			&url, &format, &it.Approved, &it.Mute,
			&it.Volume, &it.Jump, &it.Trim, &image, &imageCaption,
			&content, &it.Sort,
		); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		derefStr(&it.FullTitle, fullTitle)
		derefStr(&it.Timezone, timezone)
		derefStr(&it.URL, url)
		derefStr(&it.Format, format)
		derefStr(&it.Image, image)
		derefStr(&it.ImageCaption, imageCaption)
		derefStr(&it.Content, content)
		out = append(out, it)
	}
	return out, rows.Err()
}
