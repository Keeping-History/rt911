package chat

import (
	"context"
	"fmt"
	"sort"
	"time"

	"classicy/streamer/internal/model"

	"github.com/jackc/pgx/v5/pgxpool"
)

// The chat channel exists only inside this window: 8 AM to midnight ET on
// September 11, 2001. Outside it every buddy is offline and sends are refused.
var (
	WindowStart = time.Date(2001, 9, 11, 12, 0, 0, 0, time.UTC)
	WindowEnd   = time.Date(2001, 9, 12, 4, 0, 0, 0, time.UTC)
)

// Profile is one configured buddy. Plan A uses only the identity and
// availability fields; persona, style, and LLM overrides are loaded by the
// generation layer in a later plan.
type Profile struct {
	ID          int
	ScreenName  string
	DisplayName string
	Avatar      string
	OnlineFrom  *time.Time
	OnlineUntil *time.Time
	Sort        int
}

// OnlineAt reports whether this buddy is signed on at virtual time t. A nil
// bound means "the whole chat window", so a profile with no bounds is online
// for all of it and never outside it.
func (p Profile) OnlineAt(t time.Time) bool {
	if t.Before(WindowStart) || !t.Before(WindowEnd) {
		return false
	}
	if p.OnlineFrom != nil && t.Before(*p.OnlineFrom) {
		return false
	}
	if p.OnlineUntil != nil && !t.Before(*p.OnlineUntil) {
		return false
	}
	return true
}

// Roster projects profiles to their wire shape at virtual time t, ordered by
// the sort field the Directus admin controls.
func Roster(profiles []Profile, t time.Time) []model.Buddy {
	ordered := make([]Profile, len(profiles))
	copy(ordered, profiles)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Sort < ordered[j].Sort })

	out := make([]model.Buddy, 0, len(ordered))
	for _, p := range ordered {
		out = append(out, model.Buddy{
			ID:          p.ID,
			ScreenName:  p.ScreenName,
			DisplayName: p.DisplayName,
			Avatar:      p.Avatar,
			Online:      p.OnlineAt(t),
		})
	}
	return out
}

const profileSelect = `
	SELECT id, screen_name, display_name, avatar, online_from, online_until, sort
	FROM chat_profiles
	WHERE active = 1
	ORDER BY sort NULLS LAST, id`

// LoadProfiles reads every active buddy. Config is tiny and static, so callers
// load once and keep the slice rather than querying per tick.
func LoadProfiles(ctx context.Context, pool *pgxpool.Pool) ([]Profile, error) {
	rows, err := pool.Query(ctx, profileSelect)
	if err != nil {
		return nil, fmt.Errorf("query chat_profiles: %w", err)
	}
	defer rows.Close()

	var out []Profile
	for rows.Next() {
		var (
			p           Profile
			displayName *string
			avatar      *string
			sortOrder   *int
		)
		if err := rows.Scan(&p.ID, &p.ScreenName, &displayName, &avatar,
			&p.OnlineFrom, &p.OnlineUntil, &sortOrder); err != nil {
			return nil, fmt.Errorf("scan chat_profiles: %w", err)
		}
		p.DisplayName = derefStr(displayName)
		p.Avatar = derefStr(avatar)
		if sortOrder != nil {
			p.Sort = *sortOrder
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate chat_profiles: %w", err)
	}
	return out, nil
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
