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
	Medium      string // "tv" or "radio" for tier 2; empty otherwise
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

// FloorMinute truncates to the top of the virtual minute.
//
// Every windowed retrieval bound goes through this. An upper bound of "now"
// moves every virtual second, which made the knowledge blocks byte-different on
// every single message and therefore impossible to cache; floored, they are
// identical for every message sent inside the same minute. The cost is that a
// fact or transcript line can be up to a minute late, which the volatile live
// tail (segments since the floor) covers for the tier where immediacy matters.
func FloorMinute(t time.Time) time.Time {
	return t.UTC().Truncate(time.Minute)
}

// LoadCurated returns every curated entry that was public at t and has not been
// superseded. It is cumulative rather than a window: this is the running digest
// of what an ordinary person knew by now, and it is the tier the composer is
// allowed to state plainly.
//
// detailWindow bounds how far back an entry's `detail` column is carried. The
// digest is cumulative, so by mid-afternoon it holds every fact of the day, and
// pasting each one's full detail paragraph into every message was the second
// largest thing in the prompt after the transcript. Older entries keep their
// summary — what the buddy knows — and drop the elaboration they are no longer
// actively reacting to. A zero or negative window keeps detail on everything.
func LoadCurated(ctx context.Context, pool *pgxpool.Pool, t time.Time, detailWindow time.Duration) ([]Passage, error) {
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
		p.At = p.At.UTC()
		if d := derefStr(detail); d != "" && withinDetailWindow(p.At, t, detailWindow) {
			p.Text = p.Text + " " + d
		}
		p.Tier = TierCurated
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate chat_knowledge: %w", err)
	}
	return out, nil
}

// withinDetailWindow reports whether an entry published at `at` is recent enough
// (relative to the virtual clock `now`) to carry its detail column.
func withinDetailWindow(at, now time.Time, window time.Duration) bool {
	if window <= 0 {
		return true
	}
	return !at.Before(now.Add(-window))
}

// $3 carries "no filter at all" as its own flag rather than inferring it from
// empty arrays. Inferring it would make an allow-list that permits nothing mean
// permit everything -- the buddy in Columbus would hear New York local radio
// precisely because nobody said he could.
const broadcastSelect = `
	SELECT start_date, text, medium
	FROM chat_transcript_segments
	WHERE start_date > $1 AND start_date <= $2
	  AND ($3::bool
	       OR channel = ANY($4::int[])
	       OR channel_slug = ANY($5::text[]))
	ORDER BY start_date DESC
	LIMIT $6`

// LoadBroadcast returns transcript segments aired in (lo, hi], restricted to the
// sources that reached the buddy's market. This is what they could have heard
// just now, and it is why the early-morning confusion ("they're saying it was a
// small plane") appears without being authored.
//
// The bounds are explicit rather than a lookback from "now" because the caller
// splits the window in two: a floored, cacheable span ending at the top of the
// current minute, and the volatile remainder since that floor. Both halves are
// this same query, which is what keeps the market allow-list identical across
// them — a second, subtly different filter is how a buddy in Columbus ends up
// hearing New York local radio.
//
// A nil allow means unfiltered. A non-nil allow is applied even when it permits
// nothing -- see the note on broadcastSelect.
//
// limit bounds the result, and the query takes the NEWEST rows: a ten-minute
// window across the national and international sources runs to ~450 segments
// and ~260k runes at 13:00Z, which is roughly 65k tokens against a prompt
// budgeted for 8k. Truncating from the wrong end would keep what was on air ten
// minutes ago and drop the last thirty seconds -- the opposite of "what you have
// just heard". Rows are reversed before returning so the composer still reads
// oldest-first, the way a conversation does.
func LoadBroadcast(ctx context.Context, pool *pgxpool.Pool, lo, hi time.Time, allow *BroadcastFilter, limit int) ([]Passage, error) {
	unfiltered := allow == nil
	var ids []int
	var slugs []string
	if allow != nil {
		ids, slugs = allow.ChannelIDs, allow.Slugs
	}
	rows, err := pool.Query(ctx, broadcastSelect,
		lo.UTC(), hi.UTC(), unfiltered, ids, slugs, limit)
	if err != nil {
		return nil, fmt.Errorf("query chat_transcript_segments: %w", err)
	}
	defer rows.Close()

	var out []Passage
	for rows.Next() {
		var (
			p      Passage
			at     time.Time
			text   string
			medium *string
		)
		if err := rows.Scan(&at, &text, &medium); err != nil {
			return nil, fmt.Errorf("scan chat_transcript_segments: %w", err)
		}
		p.Tier = TierBroadcast
		p.At = at.UTC()
		p.Text = text
		p.Certainty = "reported"
		p.Sensitivity = "normal"
		p.Medium = derefStr(medium)
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate chat_transcript_segments: %w", err)
	}
	return reversePassages(out), nil
}

// The filter clause is deliberately character-for-character the same shape as
// broadcastSelect's, including the $3 "unfiltered" flag. These two queries are
// interchangeable sources for the same tier, so any divergence in how the market
// allow-list is applied would mean a buddy hears different stations depending on
// whether the minute happens to have been summarized yet.
const broadcastMinuteSelect = `
	SELECT minute, summary, medium
	FROM chat_transcript_minutes
	WHERE minute > $1 AND minute <= $2
	  AND ($3::bool
	       OR channel = ANY($4::int[])
	       OR channel_slug = ANY($5::text[]))
	ORDER BY minute DESC
	LIMIT $6`

// LoadBroadcastMinutes returns the pre-summarized per-(channel, minute) rows for
// (lo, hi] — the condensed form of exactly what LoadBroadcast returns raw.
//
// Raw ASR is the single largest thing in the prompt: a ten-minute window is
// hundreds of overlapping segments of half-sentences, repetition and
// mis-transcription, and the trimming that kept it inside budget was dropping
// whole minutes of coverage. One condensed line per channel per minute says the
// same thing in a fraction of the tokens, and reads cleaner than the ASR did.
//
// An empty result is not an error: it means the summarizer has not reached this
// span yet, and the caller falls back to the raw segments.
func LoadBroadcastMinutes(ctx context.Context, pool *pgxpool.Pool, lo, hi time.Time, allow *BroadcastFilter, limit int) ([]Passage, error) {
	unfiltered := allow == nil
	var ids []int
	var slugs []string
	if allow != nil {
		ids, slugs = allow.ChannelIDs, allow.Slugs
	}
	rows, err := pool.Query(ctx, broadcastMinuteSelect,
		lo.UTC(), hi.UTC(), unfiltered, ids, slugs, limit)
	if err != nil {
		return nil, fmt.Errorf("query chat_transcript_minutes: %w", err)
	}
	defer rows.Close()

	var out []Passage
	for rows.Next() {
		var (
			p      Passage
			at     time.Time
			text   string
			medium *string
		)
		if err := rows.Scan(&at, &text, &medium); err != nil {
			return nil, fmt.Errorf("scan chat_transcript_minutes: %w", err)
		}
		p.Tier = TierBroadcast
		p.At = at.UTC()
		p.Text = text
		p.Certainty = "reported"
		p.Sensitivity = "normal"
		p.Medium = derefStr(medium)
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate chat_transcript_minutes: %w", err)
	}
	return reversePassages(out), nil
}

// reversePassages flips newest-first rows back to chronological order. The
// query has to sort DESC so LIMIT keeps the most recent segments; the composer
// reads top-to-bottom, so it needs them the other way round.
func reversePassages(newestFirst []Passage) []Passage {
	out := make([]Passage, len(newestFirst))
	for i, p := range newestFirst {
		out[len(newestFirst)-1-i] = p
	}
	return out
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
