package chat

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Schedule is one proactive beat a buddy can send unprompted. AtBeacon +
// OffsetSeconds is the primary form (react to a beacon a fixed delay after it
// went public); At is an absolute override for beats that don't hang off a
// beacon at all. Kind selects how Text/Prompt gets delivered: "static" sends
// Text verbatim, "generated" sends Prompt through the provider. See FireAt.
type Schedule struct {
	ID                   int
	ProfileID            int
	AtBeacon             *int
	OffsetSeconds        int
	At                   *time.Time
	Kind                 string
	Text                 string
	Prompt               string
	RequiresPriorContact bool
}

const scheduleSelect = `
	SELECT id, profile, at_beacon, offset_seconds, at, kind, text, prompt, requires_prior_contact
	FROM chat_schedules
	WHERE active = 1`

// LoadSchedules reads every active scheduled beat. Config is tiny and static,
// so callers load once and keep the slice, exactly like LoadProfiles and
// LoadBeacons.
func LoadSchedules(ctx context.Context, pool *pgxpool.Pool) ([]Schedule, error) {
	rows, err := pool.Query(ctx, scheduleSelect)
	if err != nil {
		return nil, fmt.Errorf("query chat_schedules: %w", err)
	}
	defer rows.Close()

	var out []Schedule
	for rows.Next() {
		var (
			s                    Schedule
			text                 *string
			prompt               *string
			at                   *time.Time
			requiresPriorContact int
		)
		if err := rows.Scan(&s.ID, &s.ProfileID, &s.AtBeacon, &s.OffsetSeconds, &at,
			&s.Kind, &text, &prompt, &requiresPriorContact); err != nil {
			return nil, fmt.Errorf("scan chat_schedules: %w", err)
		}
		s.Text = derefStr(text)
		s.Prompt = derefStr(prompt)
		if at != nil {
			utc := at.UTC()
			s.At = &utc
		}
		s.RequiresPriorContact = requiresPriorContact != 0
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate chat_schedules: %w", err)
	}
	return out, nil
}

// FireAt resolves the absolute instant a beat fires. At, when set, always
// wins over AtBeacon -- an absolute override beat has nothing left to resolve
// even if its AtBeacon also happens to point at a beacon that no longer
// exists. Otherwise the beat fires OffsetSeconds after its beacon's
// PublicAt -- never At, the same rule PhaseAt follows: a buddy cannot react
// to an event before it was publicly known. ok is false when neither an
// absolute time nor a resolvable beacon is available, e.g. a schedule
// pointing at a deleted beacon.
func (s Schedule) FireAt(beacons map[int]Beacon) (time.Time, bool) {
	if s.At != nil {
		return *s.At, true
	}
	if s.AtBeacon == nil {
		return time.Time{}, false
	}
	b, ok := beacons[*s.AtBeacon]
	if !ok {
		return time.Time{}, false
	}
	return b.PublicAt.Add(time.Duration(s.OffsetSeconds) * time.Second), true
}

// DueBetween returns the schedules whose FireAt falls in the half-open window
// (from, to]. Half-open at both ends is load-bearing: as a session's horizon
// advances tick by tick, each instant is the "to" of exactly one call and the
// "from" of the next, so a beat lands in exactly one window and fires exactly
// once. A schedule that cannot resolve (FireAt's ok == false) is skipped, not
// treated as always-due.
func DueBetween(schedules []Schedule, beacons map[int]Beacon, from, to time.Time) []Schedule {
	var out []Schedule
	for _, s := range schedules {
		t, ok := s.FireAt(beacons)
		if !ok {
			continue
		}
		if t.After(from) && !t.After(to) {
			out = append(out, s)
		}
	}
	return out
}
