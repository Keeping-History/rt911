package chat

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Tier records where a passage came from, which decides how the composer is
// allowed to use it: tier 1 is authored and may be stated plainly (hedged by
// its certainty), tier 2 is what was actually broadcast, and tier 3 is a
// retrospective investigative timeline that must only ever be paraphrased
// vaguely — a civilian in 2001 did not know what it records.
type Tier int

const (
	TierCurated   Tier = 1
	TierBroadcast Tier = 2
	TierTimeline  Tier = 3
)

// Passage is one retrieved piece of knowledge with its provenance attached.
type Passage struct {
	Tier        Tier
	At          time.Time
	Text        string
	Certainty   string
	Sensitivity string
}

// Redact removes passages the curator marked as off limits. This runs before
// anything reaches a prompt, so a do_not_discuss row cannot be paraphrased into
// the conversation by a model that was never shown it.
func Redact(passages []Passage) []Passage {
	out := make([]Passage, 0, len(passages))
	for _, p := range passages {
		if p.Sensitivity == "do_not_discuss" {
			continue
		}
		out = append(out, p)
	}
	return out
}

// Budget orders passages by tier and trims to fit maxRunes, dropping the least
// authoritative first. It always returns at least one passage when given one:
// an empty knowledge block reads to the model as "this buddy knows nothing",
// which is a worse failure than a truncated one.
func Budget(passages []Passage, maxRunes int) []Passage {
	ordered := make([]Passage, len(passages))
	copy(ordered, passages)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Tier < ordered[j].Tier })

	out := make([]Passage, 0, len(ordered))
	used := 0
	for _, p := range ordered {
		n := len([]rune(p.Text))
		// break, not continue: skipping past an over-budget passage to fit a
		// later smaller one would keep a less authoritative tier while dropping
		// a more authoritative one, inverting the rule this function exists for.
		if len(out) > 0 && used+n > maxRunes {
			break
		}
		out = append(out, p)
		used += n
	}
	return out
}

const curatedSelect = `
	SELECT public_at, summary, detail, certainty, sensitivity
	FROM chat_knowledge
	WHERE public_at <= $1 AND (until IS NULL OR until > $1)
	ORDER BY public_at`

// LoadCurated returns every curated entry that was public at t and has not been
// superseded. It is cumulative rather than a window: this is the running digest
// of what an ordinary person knew by now, and it is the tier the composer is
// allowed to state plainly.
func LoadCurated(ctx context.Context, pool *pgxpool.Pool, t time.Time) ([]Passage, error) {
	rows, err := pool.Query(ctx, curatedSelect, t.UTC())
	if err != nil {
		return nil, fmt.Errorf("query chat_knowledge: %w", err)
	}
	defer rows.Close()

	var out []Passage
	for rows.Next() {
		var (
			p      Passage
			detail *string
		)
		if err := rows.Scan(&p.At, &p.Text, &detail, &p.Certainty, &p.Sensitivity); err != nil {
			return nil, fmt.Errorf("scan chat_knowledge: %w", err)
		}
		if d := derefStr(detail); d != "" {
			p.Text = p.Text + " " + d
		}
		p.Tier = TierCurated
		p.At = p.At.UTC()
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate chat_knowledge: %w", err)
	}
	return out, nil
}

const broadcastSelect = `
	SELECT start_date, text
	FROM chat_transcript_segments
	WHERE start_date > $1 AND start_date <= $2
	  AND ($3::int[] IS NULL OR channel = ANY($3::int[]))
	ORDER BY start_date`

// LoadBroadcast returns transcript segments from the lookback window ending at
// t, optionally restricted to the channels the user is actually watching. This
// is what the buddy could have heard just now, and it is why the early-morning
// confusion ("they're saying it was a small plane") appears without being
// authored.
func LoadBroadcast(ctx context.Context, pool *pgxpool.Pool, t time.Time, lookback time.Duration, channelIDs []int) ([]Passage, error) {
	var ids any
	if len(channelIDs) > 0 {
		ids = channelIDs
	}
	rows, err := pool.Query(ctx, broadcastSelect, t.UTC().Add(-lookback), t.UTC(), ids)
	if err != nil {
		return nil, fmt.Errorf("query chat_transcript_segments: %w", err)
	}
	defer rows.Close()

	var out []Passage
	for rows.Next() {
		var p Passage
		if err := rows.Scan(&p.At, &p.Text); err != nil {
			return nil, fmt.Errorf("scan chat_transcript_segments: %w", err)
		}
		p.Tier = TierBroadcast
		p.Certainty = "reported"
		p.Sensitivity = "normal"
		p.At = p.At.UTC()
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate chat_transcript_segments: %w", err)
	}
	return out, nil
}

const timelineSearch = `
	SELECT start_date, title, content
	FROM news_items
	WHERE approved = 1 AND start_date <= $1
	  AND to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))
	      @@ plainto_tsquery('english', $2)
	ORDER BY start_date DESC
	LIMIT $3`

// SearchTimeline is the tier-3 fallback, consulted only when tiers 1 and 2 miss.
// news_items is the History Commons investigative timeline: accurate about what
// happened, but written with hindsight and full of detail no civilian had in
// 2001. The composer must paraphrase it vaguely, never quote it.
//
// news_items.start_date is `timestamp without time zone` while the other two
// tiers are timestamptz, so the scanned value is forced to UTC like the rest.
func SearchTimeline(ctx context.Context, pool *pgxpool.Pool, t time.Time, query string, limit int) ([]Passage, error) {
	rows, err := pool.Query(ctx, timelineSearch, t.UTC(), query, limit)
	if err != nil {
		return nil, fmt.Errorf("query news_items: %w", err)
	}
	defer rows.Close()

	var out []Passage
	for rows.Next() {
		var (
			p       Passage
			title   *string
			content *string
		)
		if err := rows.Scan(&p.At, &title, &content); err != nil {
			return nil, fmt.Errorf("scan news_items: %w", err)
		}
		p.Text = derefStr(title)
		if c := derefStr(content); c != "" {
			p.Text = p.Text + " " + c
		}
		p.Tier = TierTimeline
		p.Certainty = "confirmed"
		p.Sensitivity = "handle_with_care"
		p.At = p.At.UTC()
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate news_items: %w", err)
	}
	return out, nil
}
