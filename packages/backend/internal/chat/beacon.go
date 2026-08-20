package chat

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Beacon is a named story anchor. It carries two clocks deliberately: At is when
// the event happened, PublicAt is when it became publicly known. The Pentagon was
// struck several minutes before it was on air, and a buddy's mood cannot change
// from an event they have not heard about — so phases advance on PublicAt and
// only the curated knowledge tier uses At.
type Beacon struct {
	ID       int
	Key      string
	Label    string
	At       time.Time
	PublicAt time.Time
}

// Phase is one step of a profile's emotional arc, anchored to a beacon. The
// dials are rendered into prompt language by the composer; the model never sees
// the numbers.
type Phase struct {
	ID         int
	ProfileID  int
	FromBeacon *int
	Tone       string
	Shock      int
	Coherence  int
	Verbosity  int
	TypoRate   int
	TopicFocus int
	Sort       int
}

// DefaultPhase is the phase a profile falls back to when it has none configured
// or when virtual time precedes its first beacon.
//
// It exists because Phase's zero value is not neutral: Coherence's polarity is
// inverted relative to the other four dials, so Phase{} renders the
// self-contradictory "You are not especially worried. You are struggling to
// finish a thought." The polarity itself is not flipped because chat_phases
// already holds live rows seeded with high-means-composed.
var DefaultPhase = Phase{
	Shock:      0,
	Coherence:  100,
	Verbosity:  50,
	TypoRate:   20,
	TopicFocus: 0,
}

// PhaseAt returns the phase in effect at virtual time t: the one whose beacon
// has most recently become public. A phase with no beacon is the opening state.
//
// It resolves for any t, including outside the chat window — deciding whether
// chat is usable at all is Gate's job, and a seek can land anywhere.
func PhaseAt(phases []Phase, beacons map[int]Beacon, t time.Time) (Phase, bool) {
	best := DefaultPhase
	var bestAt time.Time
	found := false

	for _, p := range phases {
		var reachedAt time.Time
		if p.FromBeacon != nil {
			b, ok := beacons[*p.FromBeacon]
			if !ok {
				// Unresolvable: a phase pointing at a deleted beacon must not win
				// by sort order and silently misrepresent the arc.
				continue
			}
			if t.Before(b.PublicAt) {
				continue
			}
			reachedAt = b.PublicAt
		}

		if !found || reachedAt.After(bestAt) ||
			(reachedAt.Equal(bestAt) && p.Sort > best.Sort) {
			best, bestAt, found = p, reachedAt, true
		}
	}
	return best, found
}

const beaconSelect = `SELECT id, key, label, at, public_at FROM chat_beacons`

// LoadBeacons reads every beacon, keyed by id for phase resolution. Config is
// tiny and static, so callers load once and keep the map.
func LoadBeacons(ctx context.Context, pool *pgxpool.Pool) (map[int]Beacon, error) {
	rows, err := pool.Query(ctx, beaconSelect)
	if err != nil {
		return nil, fmt.Errorf("query chat_beacons: %w", err)
	}
	defer rows.Close()

	out := make(map[int]Beacon)
	for rows.Next() {
		var (
			b     Beacon
			label *string
		)
		if err := rows.Scan(&b.ID, &b.Key, &label, &b.At, &b.PublicAt); err != nil {
			return nil, fmt.Errorf("scan chat_beacons: %w", err)
		}
		b.Label = derefStr(label)
		// These columns are timestamptz; every other time in this package is
		// UTC, and a differently-located time compares silently wrong.
		b.At, b.PublicAt = b.At.UTC(), b.PublicAt.UTC()
		out[b.ID] = b
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate chat_beacons: %w", err)
	}
	return out, nil
}

const phaseSelect = `
	SELECT id, profile, from_beacon, tone, shock, coherence, verbosity, typo_rate, topic_focus, sort
	FROM chat_phases
	ORDER BY profile, sort`

// LoadPhases reads every phase, grouped by profile id.
func LoadPhases(ctx context.Context, pool *pgxpool.Pool) (map[int][]Phase, error) {
	rows, err := pool.Query(ctx, phaseSelect)
	if err != nil {
		return nil, fmt.Errorf("query chat_phases: %w", err)
	}
	defer rows.Close()

	out := make(map[int][]Phase)
	for rows.Next() {
		var (
			p    Phase
			tone *string
		)
		if err := rows.Scan(&p.ID, &p.ProfileID, &p.FromBeacon, &tone,
			&p.Shock, &p.Coherence, &p.Verbosity, &p.TypoRate, &p.TopicFocus, &p.Sort); err != nil {
			return nil, fmt.Errorf("scan chat_phases: %w", err)
		}
		p.Tone = derefStr(tone)
		out[p.ProfileID] = append(out[p.ProfileID], p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate chat_phases: %w", err)
	}
	for id := range out {
		sort.SliceStable(out[id], func(i, j int) bool { return out[id][i].Sort < out[id][j].Sort })
	}
	return out, nil
}
