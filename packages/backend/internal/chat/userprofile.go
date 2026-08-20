package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode"

	"github.com/jackc/pgx/v5"
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

// userProfileMaxRunes caps one rendered value. The block lives in the cached
// stable prefix, so an unbounded value is paid for on every conversation.
const userProfileMaxRunes = 120

// UserValue is one labelled fact about the person a buddy is talking to.
type UserValue struct {
	Label string
	Text  string
}

// UserProfile is the signed-in user's self-reported profile, already rendered
// to display strings and ordered for the prompt.
type UserProfile struct {
	Values []UserValue
}

// Empty reports whether there is nothing to tell a buddy. The composer omits
// the whole block in that case rather than emitting an empty heading.
func (p UserProfile) Empty() bool { return len(p.Values) == 0 }

// reProfileStrip removes punctuation a value has no business carrying into a
// system prompt: markdown emphasis and the bracketing characters a prompt uses
// for structure. Letters are deliberately left alone, accents included --
// Sanitize's ASCII-only rule is right for a reply a 2001 client must render,
// and wrong for a person's own name.
var reProfileStrip = regexp.MustCompile("[`*_~#<>{}\\[\\]|\\\\]+")

// sanitizeProfileValue defuses one free-text value.
//
// Collapsing newlines is the load-bearing part. Every other transformation
// here is hygiene, but a value containing a newline could open a line of its
// own inside the system prompt and read as an instruction rather than as data.
func sanitizeProfileValue(s string, maxRunes int) string {
	s = reURL.ReplaceAllString(s, "")
	s = reProfileStrip.ReplaceAllString(s, "")

	var b strings.Builder
	for _, r := range s {
		if r == '\n' || r == '\r' || r == '\t' {
			b.WriteRune(' ')
			continue
		}
		if unicode.IsControl(r) {
			continue
		}
		b.WriteRune(r)
	}
	s = reWhitespace.ReplaceAllString(b.String(), " ")
	return truncateRunes(strings.TrimSpace(s), maxRunes)
}

// renderUserValue turns one raw ::text column value into prompt-ready display
// text. Every column is read as text precisely so this function does not have
// to know the type -- a date, an integer or a boolean added to the exposure
// list next year renders as itself with no code change.
func renderUserValue(raw string, choices map[string]string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "null" {
		return ""
	}

	parts := []string{raw}
	switch raw[0] {
	case '[':
		var list []string
		if err := json.Unmarshal([]byte(raw), &list); err != nil {
			return ""
		}
		parts = list
	case '"':
		// A json-typed column holding a bare string arrives quoted.
		var one string
		if err := json.Unmarshal([]byte(raw), &one); err != nil {
			return ""
		}
		parts = []string{one}
	}

	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if label, ok := choices[p]; ok {
			p = label
		}
		if p = sanitizeProfileValue(p, userProfileMaxRunes); p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, ", ")
}

// LoadUserProfile reads the configured columns for one user.
//
// Identifiers come from configuration data, so every one is quoted with
// pgx.Identifier.Sanitize regardless of having already passed ExposableField.
// Each is cast to text so a single []*string scan covers every column type.
func LoadUserProfile(ctx context.Context, pool *pgxpool.Pool, userID string, fields []UserField) (UserProfile, error) {
	if userID == "" || len(fields) == 0 {
		return UserProfile{}, nil
	}

	cols := make([]string, len(fields))
	for i, f := range fields {
		cols[i] = pgx.Identifier{f.Field}.Sanitize() + "::text"
	}
	q := "SELECT " + strings.Join(cols, ", ") + " FROM directus_users WHERE id = $1"

	raw := make([]*string, len(fields))
	dest := make([]any, len(fields))
	for i := range raw {
		dest[i] = &raw[i]
	}
	if err := pool.QueryRow(ctx, q, userID).Scan(dest...); err != nil {
		// A user row that vanished mid-session is anonymous, not an error --
		// the same posture LookupSessionUser takes on an expired session.
		if errors.Is(err, pgx.ErrNoRows) {
			return UserProfile{}, nil
		}
		return UserProfile{}, fmt.Errorf("load user profile: %w", err)
	}

	var out UserProfile
	for i, f := range fields {
		text := renderUserValue(derefStr(raw[i]), f.Choices)
		if text == "" {
			continue
		}
		out.Values = append(out.Values, UserValue{Label: f.Label, Text: text})
	}
	return out, nil
}
