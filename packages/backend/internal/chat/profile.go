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

// Profile is one configured buddy: identity, availability, and the persona
// and style fields the composer renders into the prompt's stable system block.
type Profile struct {
	ID             int
	ScreenName     string
	DisplayName    string
	Avatar         string
	Persona        string
	EducationLevel string
	WritingStyle   string
	StyleExemplars string
	OnlineFrom     *time.Time
	OnlineUntil    *time.Time
	Sort           int

	// Provider, Model, MaxTokens, Effort, and Temperature are per-profile
	// overrides onto Settings. nil means "inherit the global default" — see
	// Settings.Merge — so these stay pointers rather than being derefStr'd.
	Provider    *string
	Model       *string
	MaxTokens   *int
	Effort      *string
	Temperature *float64

	SystemPromptExtra string
	TypingSpeed       int
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
	SELECT id, screen_name, display_name, avatar, persona, education_level,
	       writing_style, style_exemplars, online_from, online_until, sort,
	       provider, model, max_tokens, effort, temperature,
	       system_prompt_extra, typing_speed
	FROM chat_profiles
	WHERE active = 1
	ORDER BY sort, id`

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
			p                 Profile
			displayName       *string
			avatar            *string
			persona           *string
			educationLevel    *string
			writingStyle      *string
			styleExemplars    *string
			systemPromptExtra *string
			typingSpeed       *int
		)
		if err := rows.Scan(&p.ID, &p.ScreenName, &displayName, &avatar,
			&persona, &educationLevel, &writingStyle, &styleExemplars,
			&p.OnlineFrom, &p.OnlineUntil, &p.Sort,
			&p.Provider, &p.Model, &p.MaxTokens, &p.Effort, &p.Temperature,
			&systemPromptExtra, &typingSpeed); err != nil {
			return nil, fmt.Errorf("scan chat_profiles: %w", err)
		}
		p.DisplayName = derefStr(displayName)
		p.Avatar = derefStr(avatar)
		p.Persona = derefStr(persona)
		p.EducationLevel = derefStr(educationLevel)
		p.WritingStyle = derefStr(writingStyle)
		p.StyleExemplars = derefStr(styleExemplars)
		p.SystemPromptExtra = derefStr(systemPromptExtra)
		if typingSpeed != nil {
			p.TypingSpeed = *typingSpeed
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
