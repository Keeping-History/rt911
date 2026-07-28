package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"

	"github.com/jackc/pgx/v5/pgxpool"
)

// UserField is one directus_users column a buddy may know about the signed-in
// user, as configured in chat_user_fields.
type UserField struct {
	Field string
	Label string
	// Choices maps a stored value to the human text the curator typed into the
	// Directus interface options ("high_school" -> "High School"). Nil for a
	// plain input. Resolved from directus_fields so a select field added later
	// reads correctly with no config work.
	Choices map[string]string
}

// userFieldName is what a column name we would ever create looks like. It is a
// policy check, not the injection defence -- LoadUserProfile quotes every
// identifier regardless.
var userFieldName = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// neverExpose are directus_users columns that must never reach a prompt no
// matter what chat_user_fields says.
//
// chat_user_fields is the allowlist; this is the backstop against a mistyped
// or hostile config row. The distinction matters: an allowlist that can be
// widened by editing a database row is only as safe as the row, and some of
// these columns (password, token, tfa_secret) would be a credential leak to a
// third-party LLM vendor rather than merely an embarrassment.
//
// filesystem and avatar are here for a duller reason: both hold opaque
// pointers -- a Wasabi blob URL and a file UUID -- that would render as noise
// in a prompt while telling an attacker where a user's files live.
var neverExpose = map[string]bool{
	"password": true, "token": true, "tfa_secret": true, "auth_data": true,
	"external_identifier": true, "email": true, "id": true, "role": true,
	"status": true, "policies": true, "filesystem": true, "avatar": true,
}

// ExposableField reports whether a configured column may be read into a
// prompt. columns is the real set of directus_users column names.
func ExposableField(name string, columns map[string]bool) bool {
	if !userFieldName.MatchString(name) {
		return false
	}
	if neverExpose[name] {
		return false
	}
	return columns[name]
}

const userFieldsSelect = `
	SELECT field, label
	FROM chat_user_fields
	WHERE active = 1
	ORDER BY sort, id`

const userColumnsSelect = `
	SELECT column_name
	FROM information_schema.columns
	WHERE table_schema = current_schema() AND table_name = 'directus_users'`

// userChoicesSelect reads the interface options a curator configured for each
// custom directus_users field. Only CUSTOM fields have a directus_fields row --
// Directus's own system columns are defined in code -- so a field with no row
// simply has no choices, which is the correct answer for first_name.
const userChoicesSelect = `
	SELECT field, options
	FROM directus_fields
	WHERE collection = 'directus_users' AND options IS NOT NULL`

// LoadUserFields reads the buddy-visible column list. Config is tiny and
// static, so callers load once at boot and keep the slice.
//
// A row that fails validation is dropped rather than failing the load: one bad
// config row must not blind every buddy to every user.
func LoadUserFields(ctx context.Context, pool *pgxpool.Pool) ([]UserField, error) {
	columns, err := userColumns(ctx, pool)
	if err != nil {
		return nil, err
	}
	choices, err := userChoices(ctx, pool)
	if err != nil {
		return nil, err
	}

	rows, err := pool.Query(ctx, userFieldsSelect)
	if err != nil {
		return nil, fmt.Errorf("query chat_user_fields: %w", err)
	}
	defer rows.Close()

	var out []UserField
	for rows.Next() {
		var field string
		var label *string
		if err := rows.Scan(&field, &label); err != nil {
			return nil, fmt.Errorf("scan chat_user_fields: %w", err)
		}
		if !ExposableField(field, columns) {
			continue
		}
		name := derefStr(label)
		if name == "" {
			name = field
		}
		out = append(out, UserField{Field: field, Label: name, Choices: choices[field]})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate chat_user_fields: %w", err)
	}
	return out, nil
}

// RejectedUserFields returns the configured column names LoadUserFields would
// drop, so boot can log the gap. A silently ignored config row looks exactly
// like a working one from the Directus admin.
func RejectedUserFields(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	columns, err := userColumns(ctx, pool)
	if err != nil {
		return nil, err
	}
	rows, err := pool.Query(ctx, userFieldsSelect)
	if err != nil {
		return nil, fmt.Errorf("query chat_user_fields: %w", err)
	}
	defer rows.Close()

	var bad []string
	for rows.Next() {
		var field string
		var label *string
		if err := rows.Scan(&field, &label); err != nil {
			return nil, fmt.Errorf("scan chat_user_fields: %w", err)
		}
		if !ExposableField(field, columns) {
			bad = append(bad, field)
		}
	}
	return bad, rows.Err()
}

func userColumns(ctx context.Context, pool *pgxpool.Pool) (map[string]bool, error) {
	rows, err := pool.Query(ctx, userColumnsSelect)
	if err != nil {
		return nil, fmt.Errorf("query directus_users columns: %w", err)
	}
	defer rows.Close()

	out := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("scan directus_users columns: %w", err)
		}
		out[name] = true
	}
	return out, rows.Err()
}

func userChoices(ctx context.Context, pool *pgxpool.Pool) (map[string]map[string]string, error) {
	rows, err := pool.Query(ctx, userChoicesSelect)
	if err != nil {
		return nil, fmt.Errorf("query directus_fields options: %w", err)
	}
	defer rows.Close()

	out := map[string]map[string]string{}
	for rows.Next() {
		var field string
		var raw []byte
		if err := rows.Scan(&field, &raw); err != nil {
			return nil, fmt.Errorf("scan directus_fields options: %w", err)
		}
		var opts struct {
			Choices []struct {
				Text  string `json:"text"`
				Value string `json:"value"`
			} `json:"choices"`
		}
		// A field whose options hold something other than choices (a
		// placeholder, say) is not an error -- it just has no labels.
		if err := json.Unmarshal(raw, &opts); err != nil || len(opts.Choices) == 0 {
			continue
		}
		m := make(map[string]string, len(opts.Choices))
		for _, c := range opts.Choices {
			m[c.Value] = c.Text
		}
		out[field] = m
	}
	return out, rows.Err()
}
