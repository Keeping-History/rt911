package db

import (
	"context"
	"fmt"
	"time"

	"classicy/streamer/internal/model"

	"github.com/jackc/pgx/v5/pgxpool"
)

// selectFrom is the shared SELECT … FROM clause for the main video channel.
// It reads tv_channels (the stitched per-channel HLS streams), not media_items;
// the row shape is identical (MediaItem). source is resolved to sources.slug via
// a LEFT JOIN so the client receives the human-readable slug instead of the raw
// integer foreign-key. The mi alias is kept for query-suffix compatibility.
const selectFrom = `
	SELECT mi.id, mi.title, mi.full_title, s.slug,
	       mi.start_date, mi.end_date, mi.calc_duration, mi.timezone,
	       mi.url, mi.format, mi.approved, mi.mute,
	       mi.volume, mi.jump, mi.trim, mi.image, mi.image_caption, mi.subtitles,
	       mi.content, mi.sort
	FROM tv_channels mi
	LEFT JOIN sources s ON s.id = mi.source`

// PoolConfig tunes the pgx connection pool. pgx's own default MaxConns is
// max(4, numCPU), which on a small (1-CPU) pod is just 4 — far too few for the
// burst of init/seek queries when many clients connect at once. The caller
// supplies sized values (see cmd/server/main.go); a zero field leaves pgx's
// default for that setting in place.
//
// Sizing note: MaxConns is per-pod. Across N streamer replicas the pool ceilings
// sum, so keep N × MaxConns comfortably under Postgres's max_connections.
type PoolConfig struct {
	MaxConns          int32
	MinConns          int32
	MaxConnLifetime   time.Duration
	MaxConnIdleTime   time.Duration
	HealthCheckPeriod time.Duration
}

// Connect opens a pgx connection pool with the given tuning and verifies
// connectivity.
func Connect(dsn string, pc PoolConfig) (*pgxpool.Pool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("pgxpool.ParseConfig: %w", err)
	}
	if pc.MaxConns > 0 {
		cfg.MaxConns = pc.MaxConns
	}
	if pc.MinConns > 0 {
		cfg.MinConns = pc.MinConns
	}
	if pc.MaxConnLifetime > 0 {
		cfg.MaxConnLifetime = pc.MaxConnLifetime
	}
	if pc.MaxConnIdleTime > 0 {
		cfg.MaxConnIdleTime = pc.MaxConnIdleTime
	}
	if pc.HealthCheckPeriod > 0 {
		cfg.HealthCheckPeriod = pc.HealthCheckPeriod
	}

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("pgxpool.NewWithConfig: %w", err)
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

// videoFormat is the tv_channels.format value the TV app plays. The TV's source
// filter is derived from approved channels of this format.
const videoFormat = "m3u8"

// AvailableVideoSources returns the distinct, sorted source slugs that have at
// least one approved video (m3u8) channel, independent of time. It populates
// the TV app's channel filter with every selectable channel up front, rather than
// only those that have scrolled past in the current virtual-time window.
func AvailableVideoSources(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	return queryStrings(ctx, pool, `
		SELECT DISTINCT s.slug
		FROM tv_channels mi
		JOIN sources s ON s.id = mi.source
		WHERE mi.approved = 1 AND mi.format = $1
		  AND s.slug IS NOT NULL AND s.slug <> ''
		ORDER BY s.slug`, videoFormat)
}

// AvailableAudioSources returns the distinct, sorted source slugs that have at
// least one approved mp3 item, independent of time. It populates the RadioScanner
// app's station strip with every selectable station up front, rather than only
// those that have scrolled past in the current virtual-time window.
func AvailableAudioSources(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	return queryStrings(ctx, pool, `
		SELECT DISTINCT s.slug
		FROM mp3_items mi
		JOIN sources s ON s.id = mi.source
		WHERE mi.approved = 1 AND s.slug IS NOT NULL AND s.slug <> ''
		ORDER BY s.slug`)
}

// pagerSelectFrom is the shared SELECT … FROM clause for all pager queries.
// provider is resolved to its sources.slug via a LEFT JOIN (source rows of
// type="pager"), the same way media/news/usenet resolve their source.
const pagerSelectFrom = `
	SELECT pi.id, pi.start_date, s.slug, pi.recipient_id,
	       pi.id_type, pi.channel, pi.mode, pi.message, pi.approved
	FROM pager_items pi
	LEFT JOIN sources s ON s.id = pi.source`

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

// AvailablePagerProviders returns the sorted set of pager providers from the
// sources catalogue (rows of type="pager"), independent of time. Populates the
// Pager app's provider filter.
func AvailablePagerProviders(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	return queryStrings(ctx, pool, `
		SELECT slug
		FROM sources
		WHERE type = 'pager' AND slug IS NOT NULL AND slug <> ''
		ORDER BY slug`)
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
	       mi.volume, mi.jump, mi.trim, mi.image, mi.image_caption, mi.subtitles,
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

// Mp3ItemHistory returns every approved mp3 item that has started by time t,
// ordered by start_date. It backs the Radio app's "Previous" list, which shows
// the full past schedule of a station — not just a recent window — so the query
// is unbounded on the low side. The whole table is small (hundreds of metadata
// rows), so delivering it wholesale on init/seek/subscribe is cheap; revisit
// with a per-station LIMIT if the catalogue ever grows by orders of magnitude.
// Items still active at t also match (the client decides what has "ended").
func Mp3ItemHistory(ctx context.Context, pool *pgxpool.Pool, t time.Time) ([]model.MediaItem, error) {
	return queryItems(ctx, pool,
		mp3SelectFrom+`
		 WHERE mi.approved = 1
		   AND mi.start_date <= $1
		 ORDER BY mi.start_date`, t)
}

// newsSelectFrom is the shared SELECT … FROM clause for news queries. News items
// reuse the MediaItem shape (same columns as media_items) but live in their own
// news_items table, delivered on the opt-in "news" channel.
const newsSelectFrom = `
	SELECT mi.id, mi.title, mi.full_title, s.slug,
	       mi.start_date, mi.end_date, mi.calc_duration, mi.timezone,
	       mi.url, mi.format, mi.approved, mi.mute,
	       mi.volume, mi.jump, mi.trim, mi.image, mi.image_caption, mi.subtitles,
	       mi.content, mi.sort
	FROM news_items mi
	LEFT JOIN sources s ON s.id = mi.source`

// AllNewsItems loads every approved news item ordered by start_date (cache warming).
func AllNewsItems(ctx context.Context, pool *pgxpool.Pool) ([]model.MediaItem, error) {
	return queryItems(ctx, pool,
		newsSelectFrom+` WHERE mi.approved = 1 ORDER BY mi.start_date`)
}

// NewsItemByID returns the row with the given id regardless of approval state, or
// nil if not found. The NOTIFY listener uses this to fetch the latest version of
// a changed row; an unapproved result means "evict from cache."
func NewsItemByID(ctx context.Context, pool *pgxpool.Pool, id int) (*model.MediaItem, error) {
	items, err := queryItems(ctx, pool, newsSelectFrom+` WHERE mi.id = $1`, id)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, nil
	}
	return &items[0], nil
}

// CurrentNewsItems returns approved news items active at time t. Most news is
// "instant" (start_date = end_date), so — like CurrentItems — instant items are
// included for a 5-minute lookback window so a seek to t still shows headlines
// fired in the preceding minutes. Used by the init/seek/subscribe snapshot paths.
func CurrentNewsItems(ctx context.Context, pool *pgxpool.Pool, t time.Time) ([]model.MediaItem, error) {
	return queryItems(ctx, pool,
		newsSelectFrom+`
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

// alertSelectFrom mirrors newsSelectFrom but reads alert_items and adds the
// alert-only severity column (last, so queryAlertItems scans it after the shared
// MediaItem columns).
const alertSelectFrom = `
	SELECT mi.id, mi.title, mi.full_title, s.slug,
	       mi.start_date, mi.end_date, mi.calc_duration, mi.timezone,
	       mi.url, mi.format, mi.approved, mi.mute,
	       mi.volume, mi.jump, mi.trim, mi.image, mi.image_caption, mi.subtitles,
	       mi.content, mi.sort, mi.severity
	FROM alert_items mi
	LEFT JOIN sources s ON s.id = mi.source`

// AllAlertItems loads every approved alert ordered by start_date (cache warming).
func AllAlertItems(ctx context.Context, pool *pgxpool.Pool) ([]model.AlertItem, error) {
	return queryAlertItems(ctx, pool,
		alertSelectFrom+` WHERE mi.approved = 1 ORDER BY mi.start_date`)
}

// AlertItemByID returns the row with the given id regardless of approval state, or
// nil if not found. The NOTIFY listener uses this to fetch the latest version of a
// changed row; an unapproved result means "evict from cache."
func AlertItemByID(ctx context.Context, pool *pgxpool.Pool, id int) (*model.AlertItem, error) {
	items, err := queryAlertItems(ctx, pool, alertSelectFrom+` WHERE mi.id = $1`, id)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, nil
	}
	return &items[0], nil
}

// AlertItemsInRange returns approved alerts whose start_date is in [lo, hi). Kept
// for symmetry/tests; the live tick refill reads Redis (cache.AlertItemsInRange).
func AlertItemsInRange(ctx context.Context, pool *pgxpool.Pool, lo, hi time.Time) ([]model.AlertItem, error) {
	return queryAlertItems(ctx, pool,
		alertSelectFrom+` WHERE mi.approved = 1 AND mi.start_date >= $1 AND mi.start_date < $2 ORDER BY mi.start_date`, lo, hi)
}

// queryAlertItems mirrors queryItems but scans the extra severity column into
// AlertItem. Severity is nullable (Directus default "note" may be absent on old rows).
func queryAlertItems(ctx context.Context, pool *pgxpool.Pool, q string, args ...any) ([]model.AlertItem, error) {
	rows, err := pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	defer rows.Close()

	var out []model.AlertItem
	for rows.Next() {
		var it model.AlertItem
		var fullTitle, timezone, url, format, image, imageCaption, subtitles, content, severity *string
		if err := rows.Scan(
			&it.ID, &it.Title, &fullTitle, &it.Source,
			&it.StartDate, &it.EndDate, &it.CalcDuration, &timezone,
			&url, &format, &it.Approved, &it.Mute,
			&it.Volume, &it.Jump, &it.Trim, &image, &imageCaption, &subtitles,
			&content, &it.Sort, &severity,
		); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		derefStr(&it.FullTitle, fullTitle)
		derefStr(&it.Timezone, timezone)
		derefStr(&it.URL, url)
		derefStr(&it.Format, format)
		derefStr(&it.Image, image)
		derefStr(&it.ImageCaption, imageCaption)
		derefStr(&it.Subtitles, subtitles)
		derefStr(&it.Content, content)
		it.Severity = severity
		out = append(out, it)
	}
	return out, rows.Err()
}

// usenetSelectFrom is the shared SELECT … FROM clause for Usenet message queries.
// The newsgroup is resolved to its sources.slug via a LEFT JOIN (source rows of
// type="usenet"), so the client and the per-group cache key both use the
// human-readable group name — exactly how the media queries resolve their source.
// "references" is double-quoted — it is a reserved word in Postgres and cannot
// appear as a bare column name even when table-qualified.
const usenetSelectFrom = `
	SELECT ui.id, ui.start_date, s.slug, ui.subject, ui.author,
	       ui.message_id, ui."references", ui.in_reply_to, ui.thread_id,
	       ui.parent_id, ui.body, ui.date_source, ui.approved
	FROM usenet_items ui
	LEFT JOIN sources s ON s.id = ui.source`

// usenetListSelectFrom mirrors usenetSelectFrom without ui.body: list views
// (snapshot/window/pagination) carry only headers. The body is fetched on demand
// per message via UsenetItemByID — see plans/usenet-on-demand-bodies.md.
const usenetListSelectFrom = `
	SELECT ui.id, ui.start_date, s.slug, ui.subject, ui.author,
	       ui.message_id, ui."references", ui.in_reply_to, ui.thread_id,
	       ui.parent_id, ui.date_source, ui.approved
	FROM usenet_items ui
	LEFT JOIN sources s ON s.id = ui.source`

// AllUsenetItems loads every approved Usenet message ordered by start_date
// (cache warming). The per-group cache index is built from the resolved slug.
func AllUsenetItems(ctx context.Context, pool *pgxpool.Pool) ([]model.UsenetItem, error) {
	return queryUsenetItems(ctx, pool,
		usenetSelectFrom+` WHERE ui.approved = 1 ORDER BY ui.start_date`)
}

// UsenetItemByID returns the row with the given id regardless of approval state,
// or nil if not found. The NOTIFY listener uses this to fetch the latest version
// of a changed row; an unapproved result means "evict from cache."
func UsenetItemByID(ctx context.Context, pool *pgxpool.Pool, id int) (*model.UsenetItem, error) {
	items, err := queryUsenetItems(ctx, pool, usenetSelectFrom+` WHERE ui.id = $1`, id)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, nil
	}
	return &items[0], nil
}

// CurrentUsenetItems returns the most recent `limit` approved messages in a single
// newsgroup whose start_date is at or before t — the backlog a client sees when it
// opens a group. Ordered newest-first so the LIMIT keeps the freshest messages;
// the client sorts for display. Bounded by `limit` because a group's full history
// can be large; older messages are fetched on demand (pagination, future work).
func CurrentUsenetItems(ctx context.Context, pool *pgxpool.Pool, newsgroup string, t time.Time, limit int) ([]model.UsenetItem, error) {
	return queryUsenetListItems(ctx, pool,
		usenetListSelectFrom+`
		 WHERE ui.approved = 1
		   AND s.slug = $1
		   AND ui.start_date <= $2
		 ORDER BY ui.start_date DESC
		 LIMIT $3`, newsgroup, t, limit)
}

// OlderUsenetItems returns up to `limit` approved messages in one newsgroup whose
// start_date is strictly before `before`, newest-first — the next page back when a
// reader scrolls past the initial backlog snapshot. The client passes the oldest
// start_date it currently holds as `before`.
func OlderUsenetItems(ctx context.Context, pool *pgxpool.Pool, newsgroup string, before time.Time, limit int) ([]model.UsenetItem, error) {
	return queryUsenetListItems(ctx, pool,
		usenetListSelectFrom+`
		 WHERE ui.approved = 1
		   AND s.slug = $1
		   AND ui.start_date < $2
		 ORDER BY ui.start_date DESC
		 LIMIT $3`, newsgroup, before, limit)
}

// usenetWindowLimit caps a single forward-window query. Historical newsgroup
// traffic is sparse, so a window rarely approaches this — it is only a guard
// against a pathologically busy group flooding one frame.
const usenetWindowLimit = 1000

// UsenetItemsInRange returns approved header-only messages (no body — see
// usenetListSelectFrom) in one newsgroup whose start_date is in the half-open
// interval [lo, hi). Unlike the other channels this reads Postgres directly (not
// Redis): usenet history is too large to warm into the cache, and delivery is gated
// by the group the client is viewing — so the per-tick query volume is tiny and an
// index on (source, start_date) serves it. Bodies are fetched on demand via
// UsenetItemByID. The client reveal-gates the window by its virtual clock.
func UsenetItemsInRange(ctx context.Context, pool *pgxpool.Pool, newsgroup string, lo, hi time.Time) ([]model.UsenetItem, error) {
	return queryUsenetListItems(ctx, pool,
		usenetListSelectFrom+`
		 WHERE ui.approved = 1
		   AND s.slug = $1
		   AND ui.start_date >= $2
		   AND ui.start_date < $3
		 ORDER BY ui.start_date
		 LIMIT $4`, newsgroup, lo, hi, usenetWindowLimit)
}

// AvailableNewsgroups returns the sorted newsgroups from the sources catalogue
// (rows of type="usenet"), each with its precomputed message_count, independent of
// time. Populates the Newsgroups app's group-browse list and the usenet filter.
// Reading the catalogue is far cheaper than aggregating the whole message table.
const usenetSourceType = "usenet"

func AvailableNewsgroups(ctx context.Context, pool *pgxpool.Pool) ([]model.NewsgroupSource, error) {
	rows, err := pool.Query(ctx, `
		SELECT slug, COALESCE(message_count, 0)
		FROM sources
		WHERE type = $1 AND slug IS NOT NULL AND slug <> ''
		ORDER BY slug`, usenetSourceType)
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	defer rows.Close()

	var out []model.NewsgroupSource
	for rows.Next() {
		var ns model.NewsgroupSource
		if err := rows.Scan(&ns.Name, &ns.Count); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		out = append(out, ns)
	}
	return out, rows.Err()
}

func queryUsenetItems(ctx context.Context, pool *pgxpool.Pool, q string, args ...any) ([]model.UsenetItem, error) {
	rows, err := pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	defer rows.Close()

	var out []model.UsenetItem
	for rows.Next() {
		var it model.UsenetItem
		// Nullable text columns scan into pointer locals — Directus stores empty
		// strings as NULL and pgx cannot scan NULL into a non-pointer string.
		var newsgroup, subject, author, messageID, references, inReplyTo, threadID, parentID, body, dateSource *string
		if err := rows.Scan(
			&it.ID, &it.StartDate, &newsgroup, &subject, &author,
			&messageID, &references, &inReplyTo, &threadID,
			&parentID, &body, &dateSource, &it.Approved,
		); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		derefStr(&it.Newsgroup, newsgroup)
		derefStr(&it.Subject, subject)
		derefStr(&it.Author, author)
		derefStr(&it.MessageID, messageID)
		derefStr(&it.References, references)
		derefStr(&it.InReplyTo, inReplyTo)
		derefStr(&it.ThreadID, threadID)
		derefStr(&it.ParentID, parentID)
		derefStr(&it.Body, body)
		derefStr(&it.DateSource, dateSource)
		out = append(out, it)
	}
	return out, rows.Err()
}

// queryUsenetListItems scans header-only Usenet rows (no body column) for the list
// views. It mirrors queryUsenetItems minus the body scan target; Body stays empty.
func queryUsenetListItems(ctx context.Context, pool *pgxpool.Pool, q string, args ...any) ([]model.UsenetItem, error) {
	rows, err := pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	defer rows.Close()

	var out []model.UsenetItem
	for rows.Next() {
		var it model.UsenetItem
		var newsgroup, subject, author, messageID, references, inReplyTo, threadID, parentID, dateSource *string
		if err := rows.Scan(
			&it.ID, &it.StartDate, &newsgroup, &subject, &author,
			&messageID, &references, &inReplyTo, &threadID,
			&parentID, &dateSource, &it.Approved,
		); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		derefStr(&it.Newsgroup, newsgroup)
		derefStr(&it.Subject, subject)
		derefStr(&it.Author, author)
		derefStr(&it.MessageID, messageID)
		derefStr(&it.References, references)
		derefStr(&it.InReplyTo, inReplyTo)
		derefStr(&it.ThreadID, threadID)
		derefStr(&it.ParentID, parentID)
		derefStr(&it.DateSource, dateSource)
		out = append(out, it)
	}
	return out, rows.Err()
}

func derefStr(dst *string, src *string) {
	if src != nil {
		*dst = *src
	}
}

// queryStrings runs a query selecting a single non-null text column and returns
// the values in row order. Used by the distinct-source helpers.
func queryStrings(ctx context.Context, pool *pgxpool.Pool, q string, args ...any) ([]string, error) {
	rows, err := pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		out = append(out, v)
	}
	return out, rows.Err()
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
		var fullTitle, timezone, url, format, image, imageCaption, subtitles, content *string
		if err := rows.Scan(
			&it.ID, &it.Title, &fullTitle, &it.Source,
			&it.StartDate, &it.EndDate, &it.CalcDuration, &timezone,
			&url, &format, &it.Approved, &it.Mute,
			&it.Volume, &it.Jump, &it.Trim, &image, &imageCaption, &subtitles,
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
		derefStr(&it.Subtitles, subtitles)
		derefStr(&it.Content, content)
		out = append(out, it)
	}
	return out, rows.Err()
}

// --- flight positions (flights channel) ---

// StreamFlightPositions scans every flight position ordered by utc and invokes
// fn once per minute (all rows sharing the same utc-truncated minute). Streaming
// with per-minute flushing keeps peak memory at one bucket (≤ ~1k rows), never
// the full multi-million-row table. Used only by the boot-time cache warm — the
// flights tick path reads Redis (see cache.FlightPositionsInRange), so this
// table needs no serving index. COALESCE handles Directus NULLs in one place
// instead of per-field pointer scans (the derefStr pattern) — every nullable
// column here has an obvious zero value.
func StreamFlightPositions(ctx context.Context, pool *pgxpool.Pool, fn func(minute time.Time, items []model.FlightPosition) error) error {
	rows, err := pool.Query(ctx, `
		SELECT id, flight, COALESCE(carrier, ''), utc,
		       COALESCE(lat, 0), COALESCE(lon, 0), COALESCE(alt_ft, 0),
		       COALESCE(phase, ''), COALESCE(diverted, false)
		FROM flight_positions
		WHERE utc IS NOT NULL
		ORDER BY utc`)
	if err != nil {
		return err
	}
	defer rows.Close()

	var bucket []model.FlightPosition
	var minute time.Time
	flush := func() error {
		if len(bucket) == 0 {
			return nil
		}
		err := fn(minute, bucket)
		bucket = nil
		return err
	}
	for rows.Next() {
		var it model.FlightPosition
		if err := rows.Scan(&it.ID, &it.Flight, &it.Carrier, &it.StartDate,
			&it.Lat, &it.Lon, &it.AltFt, &it.Phase, &it.Diverted); err != nil {
			return err
		}
		// utc is a bare `timestamp` column holding UTC wall times; pin the
		// location so downstream Unix()/RFC3339 conversions are exact.
		it.StartDate = it.StartDate.UTC()
		if m := it.StartDate.Truncate(time.Minute); !m.Equal(minute) {
			if err := flush(); err != nil {
				return err
			}
			minute = m
		}
		bucket = append(bucket, it)
	}
	if err := flush(); err != nil {
		return err
	}
	return rows.Err()
}

// --- weather (weather channel) ---

// weatherObsSelectFrom is the shared SELECT clause for weather_observations
// rows (packages/tools/weather-recon). Numeric fields are nullable in the
// NCEI source data — a station can report temp without gust, or vice versa —
// so they scan straight into the model's *float64/*int fields rather than
// COALESCEing to 0 (see model.WeatherObservation).
const weatherObsSelectFrom = `
	SELECT id, station_id, observed_at, temp_c, dewpoint_c,
	       wind_dir_deg, wind_speed_kt, gust_kt, pressure_hpa,
	       sky_condition, present_weather, visibility_km, raw_metar
	FROM weather_observations`

// WeatherObsInRange returns observations whose observed_at falls in the
// half-open interval [lo, hi), ordered by observed_at — the forward window a
// tick fetches for the weather channel.
func WeatherObsInRange(ctx context.Context, pool *pgxpool.Pool, lo, hi time.Time) ([]model.WeatherObservation, error) {
	return queryWeatherObs(ctx, pool,
		weatherObsSelectFrom+`
		 WHERE observed_at >= $1 AND observed_at < $2
		 ORDER BY observed_at`, lo, hi)
}

// CurrentWeatherObs returns the most recent observation at or before t for
// every station — the per-station snapshot a client sees on init/seek.
func CurrentWeatherObs(ctx context.Context, pool *pgxpool.Pool, t time.Time) ([]model.WeatherObservation, error) {
	return queryWeatherObs(ctx, pool,
		`SELECT DISTINCT ON (station_id) id, station_id, observed_at, temp_c, dewpoint_c,
		        wind_dir_deg, wind_speed_kt, gust_kt, pressure_hpa,
		        sky_condition, present_weather, visibility_km, raw_metar
		 FROM weather_observations
		 WHERE observed_at <= $1
		 ORDER BY station_id, observed_at DESC`, t)
}

func queryWeatherObs(ctx context.Context, pool *pgxpool.Pool, q string, args ...any) ([]model.WeatherObservation, error) {
	rows, err := pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	defer rows.Close()

	var out []model.WeatherObservation
	for rows.Next() {
		var it model.WeatherObservation
		// sky_condition/present_weather/raw_metar are nullable text — the derefStr
		// pattern; the numeric fields are already *float64/*int on the model, so
		// they scan directly (see item.go's CalcDuration/Sort for precedent).
		var skyCondition, presentWeather, rawMetar *string
		if err := rows.Scan(
			&it.ID, &it.StationID, &it.StartDate, &it.TempC, &it.DewpointC,
			&it.WindDirDeg, &it.WindSpeedKt, &it.GustKt, &it.PressureHpa,
			&skyCondition, &presentWeather, &it.VisibilityKm, &rawMetar,
		); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		derefStr(&it.SkyCondition, skyCondition)
		derefStr(&it.PresentWeather, presentWeather)
		derefStr(&it.RawMetar, rawMetar)
		out = append(out, it)
	}
	return out, rows.Err()
}

// weatherForecastSelectFrom is the shared SELECT clause for weather_forecasts
// rows (archived NWS ZFP/AFD zone forecast text products).
const weatherForecastSelectFrom = `
	SELECT id, wfo, zone, product_type, issued_at, raw_text
	FROM weather_forecasts`

// WeatherForecastsInRange returns forecasts whose issued_at falls in the
// half-open interval [lo, hi), ordered by issued_at.
func WeatherForecastsInRange(ctx context.Context, pool *pgxpool.Pool, lo, hi time.Time) ([]model.WeatherForecast, error) {
	// zone IS NOT NULL: Zone scans as a plain string; the loader never writes
	// NULL zones, but the column is nullable — one bad row would otherwise
	// fail the scan and black out the whole tick window.
	return queryWeatherForecasts(ctx, pool,
		weatherForecastSelectFrom+`
		 WHERE zone IS NOT NULL AND issued_at >= $1 AND issued_at < $2
		 ORDER BY issued_at`, lo, hi)
}

// CurrentWeatherForecast returns the most recently issued forecast at or
// before t whose comma-joined zone list contains zone, or (nil, nil) if none
// exists. zone is matched with a substring LIKE since a single product can
// cover many UGC zones.
func CurrentWeatherForecast(ctx context.Context, pool *pgxpool.Pool, zone string, t time.Time) (*model.WeatherForecast, error) {
	items, err := queryWeatherForecasts(ctx, pool,
		weatherForecastSelectFrom+`
		 WHERE zone LIKE '%'||$1||'%' AND issued_at <= $2
		 ORDER BY issued_at DESC
		 LIMIT 1`, zone, t)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, nil
	}
	return &items[0], nil
}

func queryWeatherForecasts(ctx context.Context, pool *pgxpool.Pool, q string, args ...any) ([]model.WeatherForecast, error) {
	rows, err := pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	defer rows.Close()

	var out []model.WeatherForecast
	for rows.Next() {
		var it model.WeatherForecast
		var wfo, productType, rawText *string
		if err := rows.Scan(
			&it.ID, &wfo, &it.Zone, &productType, &it.StartDate, &rawText,
		); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		derefStr(&it.Wfo, wfo)
		derefStr(&it.ProductType, productType)
		derefStr(&it.RawText, rawText)
		out = append(out, it)
	}
	return out, rows.Err()
}
