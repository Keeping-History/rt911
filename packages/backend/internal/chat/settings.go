package chat

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Settings is the resolved provider/model/limit configuration for a message:
// the global chat_settings row (or ShippedDefaults) with a profile's
// per-field overrides already applied via Merge.
type Settings struct {
	Provider      string
	Model         string
	MaxTokens     int
	Effort        string
	Temperature   *float64
	OpenAIBaseURL string
}

// ShippedDefaults is the configuration used when chat_settings has no row.
//
// The singleton is genuinely absent on a fresh install, so this is a normal
// path rather than a failure: a missing settings row must not stop every buddy
// from replying.
var ShippedDefaults = Settings{
	Provider:  "anthropic",
	Model:     "claude-opus-5",
	MaxTokens: 2000,
	Effort:    "low",
}

const settingsSelect = `
	SELECT provider, model, max_tokens, effort, temperature, openai_base_url
	FROM chat_settings
	ORDER BY id
	LIMIT 1`

// LoadSettings reads the singleton chat_settings row, falling back to
// ShippedDefaults when the table is empty.
func LoadSettings(ctx context.Context, pool *pgxpool.Pool) (Settings, error) {
	var s Settings
	var effort, baseURL *string
	var temp *float64

	err := pool.QueryRow(ctx, settingsSelect).
		Scan(&s.Provider, &s.Model, &s.MaxTokens, &effort, &temp, &baseURL)
	if errors.Is(err, pgx.ErrNoRows) {
		return ShippedDefaults, nil
	}
	if err != nil {
		return ShippedDefaults, fmt.Errorf("load chat settings: %w", err)
	}

	s.Effort = derefStr(effort)
	s.OpenAIBaseURL = derefStr(baseURL)
	s.Temperature = temp
	return s, nil
}

// Merge applies a profile's per-field overrides. A nil override means inherit —
// it must never be read as a zero value, or a profile that sets nothing would
// silently request max_tokens 0.
func (s Settings) Merge(p Profile) Settings {
	if p.Provider != nil {
		s.Provider = *p.Provider
	}
	if p.Model != nil {
		s.Model = *p.Model
	}
	if p.MaxTokens != nil {
		s.MaxTokens = *p.MaxTokens
	}
	if p.Effort != nil {
		s.Effort = *p.Effort
	}
	if p.Temperature != nil {
		s.Temperature = p.Temperature
	}
	return s
}
